# app/tts.py

import threading
import queue as _queue
import time
import torch
import numpy as np
from io import BytesIO
import soundfile as sf
from huggingface_hub import snapshot_download
from fastapi import HTTPException
from moshi.models.loaders import CheckpointInfo
from moshi.models.tts import DEFAULT_DSM_TTS_REPO, DEFAULT_DSM_TTS_VOICE_REPO, TTSModel
from config import logger, DEFAULT_MODEL_PARAMS, CFG_COEF

# Global model instance (loaded once)
tts_model = None
model_loaded = False
# The model keeps one streaming state; generations must not overlap.
_generation_lock = threading.Lock()
SAMPLE_RATE = 24000

def is_model_loaded() -> bool:
    global model_loaded
    return model_loaded

def load_model():
    """Load the TTS model once at startup"""
    global tts_model, model_loaded

    if model_loaded:
        return tts_model

    try:
        logger.info("Loading TTS model...")
        checkpoint_info = CheckpointInfo.from_hf_repo(DEFAULT_DSM_TTS_REPO)
        tts_model = TTSModel.from_checkpoint_info(
            checkpoint_info,
            **DEFAULT_MODEL_PARAMS,
            device=torch.device("cuda" if torch.cuda.is_available() else "cpu")
        )
        logger.info("TTS model loaded successfully")

        logger.info("Loading Voices...")
        snapshot_download(repo_id=DEFAULT_DSM_TTS_VOICE_REPO)
        logger.info("Voices loaded successfully")

        model_loaded = True
        return tts_model
    except Exception as e:
        logger.error(f"Error loading TTS model: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to load TTS model: {str(e)}")

def generate_audio_bytes(request):
    """Generate audio stream for the given request in WAV format"""
    if not tts_model:
        raise HTTPException(status_code=500, detail="TTS model not loaded")

    if not request.input and not request.inputs:
        raise HTTPException(status_code=500, detail="Input not provided")

    if not request.voice and not request.voices:
        raise HTTPException(status_code=500, detail="Voice not provided")

    try:
        logger.info(f"Starting audio generation")

        # Prepare the script with the input text
        inputs = [request.input] if request.input else request.inputs
        logger.info(f"Generating audio for {inputs[0][:50]}")
        entries = tts_model.prepare_script(inputs, padding_between=1)

        # Get voice path
        voice_paths = []
        if request.voice:
            voice_paths = [tts_model.get_voice_path(request.voice)]
        else:
            voice_paths = [tts_model.get_voice_path(voice) for voice in request.voices]
        logger.info(f"Using {len(voice_paths)} voices")

        # Create condition attributes
        condition_attributes = tts_model.make_condition_attributes(
            voice_paths, cfg_coef=CFG_COEF
        )

        # Generate audio
        pcms = []

        def _on_frame(frame):
            if (frame != -1).all():
                pcm = tts_model.mimi.decode(frame[:, 1:, :]).cpu().numpy()
                pcms.append(torch.clamp(torch.from_numpy(pcm[0, 0]), -1, 1).numpy())

        # Generate audio with streaming
        all_entries = [entries]
        all_condition_attributes = [condition_attributes]

        logger.info("Starting voice generation")
        with tts_model.mimi.streaming(len(all_entries)):
            result = tts_model.generate(all_entries, all_condition_attributes, on_frame=_on_frame)

        # Concatenate all PCM frames
        if not pcms:
            raise HTTPException(status_code=500, detail="Failed to generate audio")

        audio = np.concatenate(pcms, axis=-1)

        # Apply speed adjustment if needed
        if request.speed != 1.0:
            # Simple speed adjustment by resampling
            from scipy import signal
            audio_length = len(audio)
            new_length = int(audio_length / request.speed)
            audio = signal.resample(audio, new_length)

        # Convert to bytes (WAV format)
        audio_bytes = BytesIO()
        sf.write(audio_bytes, audio, samplerate=tts_model.mimi.sample_rate, format='WAV')
        audio_bytes.seek(0)

        logger.info("Audio generated successfully")
        return audio_bytes.read()

    except Exception as e:
        logger.error(f"Error generating speech: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate speech: {str(e)}")

def _prepare(request):
    """Script entries and voice conditioning for one request (shared by both paths)."""
    if not tts_model:
        raise HTTPException(status_code=500, detail="TTS model not loaded")
    if not request.input and not request.inputs:
        raise HTTPException(status_code=500, detail="Input not provided")
    if not request.voice and not request.voices:
        raise HTTPException(status_code=500, detail="Voice not provided")
    inputs = [request.input] if request.input else request.inputs
    entries = tts_model.prepare_script(inputs, padding_between=1)
    voices = [request.voice] if request.voice else request.voices
    voice_paths = [tts_model.get_voice_path(v) for v in voices]
    condition_attributes = tts_model.make_condition_attributes(voice_paths, cfg_coef=CFG_COEF)
    return [entries], [condition_attributes]


def iter_pcm_s16(request, chunk_frames: int = 2):
    """Blocking generator of s16le mono PCM at SAMPLE_RATE, yielded while the model is
    still generating (each mimi frame is 80 ms). The speed factor is applied with a
    stateful resampler so chunk boundaries stay continuous; like the WAV path it is a
    plain resample, so pitch follows speed."""
    all_entries, all_attributes = _prepare(request)
    speed = float(request.speed or 1.0)
    resampler = None
    if speed != 1.0:
        import soxr
        resampler = soxr.ResampleStream(SAMPLE_RATE, SAMPLE_RATE / speed, 1, dtype="float32", quality="HQ")
    frames: _queue.Queue = _queue.Queue()

    def _on_frame(frame):
        if (frame != -1).all():
            pcm = tts_model.mimi.decode(frame[:, 1:, :]).cpu().numpy()
            frames.put(np.clip(pcm[0, 0], -1.0, 1.0).astype(np.float32))

    def _generate():
        try:
            with _generation_lock, tts_model.mimi.streaming(len(all_entries)):
                tts_model.generate(all_entries, all_attributes, on_frame=_on_frame)
        except Exception as e:  # noqa: BLE001
            frames.put(e)
        finally:
            frames.put(None)

    threading.Thread(target=_generate, name="kyutai-generate", daemon=True).start()

    def _to_bytes(samples):
        if resampler is not None:
            samples = resampler.resample_chunk(samples, last=False)
        return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()

    started = time.monotonic()
    first = True
    pending = []
    while True:
        item = frames.get()
        if item is None:
            break
        if isinstance(item, Exception):
            raise item
        pending.append(item)
        if len(pending) >= chunk_frames:
            if first:
                logger.info(f"first audio chunk after {time.monotonic() - started:.2f}s")
                first = False
            yield _to_bytes(np.concatenate(pending))
            pending = []
    if pending:
        yield _to_bytes(np.concatenate(pending))
    if resampler is not None:
        tail = resampler.resample_chunk(np.zeros(0, dtype=np.float32), last=True)
        if len(tail):
            yield (np.clip(tail, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    logger.info(f"stream finished in {time.monotonic() - started:.2f}s")
