"""
livekit-media — SenseVoice STT sidecar (OpenAI-compatible) for the LiveKit agent.

SenseVoice (FunAudioLLM/Alibaba) transcribes AND perceives the speaker's emotion +
audio events (including laughter) in one fast model — so Vesta can hear *how* you
sound and react, while Qwen-27B stays the brain.

    POST /v1/audio/transcriptions  (multipart file) -> {"text","emotion","events"}
    POST /v1/audio/refine          (multipart file) -> {"text","note","emotion","events",...}

The `text` field of /transcriptions is the words plus, when notable, a compact bracketed
note like " [tone: happy; laughing]" so the LLM (via the openai STT plugin, which only
passes `text`) sees how the user sounded. The agent's system prompt tells Qwen to adapt
to it and never read it aloud.

/refine is the second pass behind the streaming STT: the streaming model (Kyutai 1B) ends
the turn and shows words as they come, and once the utterance is complete the same audio
goes through Whisper (faster-whisper large-v3-turbo, int8_float16 on the 3060) for the
text the brain actually receives, with SenseVoice run alongside for the tone note.
"""
import asyncio
import os
import re
import shutil
import tempfile
import time

import soundfile as sf
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

ASR_MODEL = os.environ.get("ASR_MODEL", "iic/SenseVoiceSmall")
ASR_DEVICE = os.environ.get("ASR_DEVICE", "cuda:0")
ASR_LANGUAGE = os.environ.get("ASR_LANGUAGE", "en")

print("[media] loading SenseVoice:", ASR_MODEL, ASR_DEVICE, flush=True)
from funasr import AutoModel

try:
    _asr = AutoModel(model=ASR_MODEL, trust_remote_code=True, device=ASR_DEVICE, disable_update=True)
    _dev = ASR_DEVICE
except Exception as e:  # noqa: BLE001 — fall back to CPU so the service still starts
    print("[media] cuda SenseVoice failed, CPU:", e, flush=True)
    _asr = AutoModel(model=ASR_MODEL, trust_remote_code=True, device="cpu", disable_update=True)
    _dev = "cpu"
print("[media] ready.", flush=True)

# Second-pass transcriber (see the module docstring). REFINE_MODEL= (empty) disables it.
REFINE_MODEL = os.environ.get("REFINE_MODEL", "large-v3-turbo")
REFINE_DEVICE = os.environ.get("REFINE_DEVICE", "cuda")
REFINE_COMPUTE = os.environ.get("REFINE_COMPUTE", "int8_float16")
REFINE_LANGUAGE = os.environ.get("REFINE_LANGUAGE", "en")
# Whisper biases towards the vocabulary of its prompt: the names the caller actually uses.
REFINE_PROMPT = os.environ.get("REFINE_PROMPT", "Vesta, Qwen, LiveKit, Kyutai, vLLM, LiteLLM, Docker, tailnet, harness, SearXNG.")
# When Whisper and SenseVoice disagree on an utterance, the clip is kept here (newest 20) so
# a bad reading can be replayed against both. Empty disables.
REFINE_DEBUG_DIR = os.environ.get("REFINE_DEBUG_DIR", "/app/debug/refine")
_whisper = None
_whisper_dev = None
if REFINE_MODEL:
    from faster_whisper import WhisperModel

    try:
        print("[media] loading whisper:", REFINE_MODEL, REFINE_DEVICE, REFINE_COMPUTE, flush=True)
        _whisper = WhisperModel(REFINE_MODEL, device=REFINE_DEVICE, compute_type=REFINE_COMPUTE)
        _whisper_dev = REFINE_DEVICE
    except Exception as e:  # noqa: BLE001 — the refine pass is optional; the streaming text still flows
        print("[media] cuda whisper failed, CPU int8:", e, flush=True)
        try:
            _whisper = WhisperModel(REFINE_MODEL, device="cpu", compute_type="int8")
            _whisper_dev = "cpu"
        except Exception as e2:  # noqa: BLE001
            print("[media] whisper unavailable:", e2, flush=True)
    if _whisper is not None:
        # First call is slow (kernel selection); take it here rather than on the first turn.
        import numpy as _np

        t0 = time.monotonic()
        list(_whisper.transcribe(_np.zeros(16000, dtype=_np.float32), language=REFINE_LANGUAGE, beam_size=1)[0])
        print(f"[media] whisper ready on {_whisper_dev} ({time.monotonic() - t0:.1f}s warm-up)", flush=True)

# SenseVoice encodes rich info as <|...|> tags before the transcription.
_EMO_RE = re.compile(r"<\|(HAPPY|SAD|ANGRY|NEUTRAL|FEARFUL|DISGUSTED|SURPRISED|EMO_UNKNOWN)\|>")
_EVT_RE = re.compile(r"<\|(Speech|BGM|Applause|Laughter|Cry|Sneeze|Breath|Cough)\|>")
_TAG_RE = re.compile(r"<\|[^|]*\|>")

app = FastAPI(title="livekit-media (SenseVoice STT + emotion)")

# Runtime-toggleable: when off, the emotion/event note is NOT appended to the
# transcript (so it isn't shared with the brain or shown). Toggled via /config.
_emotion_enabled = os.environ.get("EMOTION_ENABLED", "1") == "1"


@app.get("/healthz")
async def healthz():
    return {"ok": True, "asr": ASR_MODEL, "device": _dev, "emotion_enabled": _emotion_enabled,
            "refine": REFINE_MODEL if _whisper is not None else None, "refine_device": _whisper_dev}


@app.get("/config")
async def get_config():
    return {"emotion_enabled": _emotion_enabled}


@app.post("/config")
async def set_config(request: Request):
    global _emotion_enabled
    body = await request.json()
    if "emotion_enabled" in body:
        _emotion_enabled = bool(body["emotion_enabled"])
        print(f"[config] emotion_enabled={_emotion_enabled}", flush=True)
    return {"emotion_enabled": _emotion_enabled}


def _transcribe(path: str):
    res = _asr.generate(input=path, cache={}, language=ASR_LANGUAGE, use_itn=True)
    raw = (res[0].get("text") if res else "") or ""
    emo_m = _EMO_RE.search(raw)
    emotion = emo_m.group(1) if emo_m else None
    events = _EVT_RE.findall(raw)
    clean = _TAG_RE.sub("", raw).strip()
    return clean, emotion, events


def _note(emotion, events) -> str:
    notes = []
    if emotion and emotion not in ("NEUTRAL", "EMO_UNKNOWN"):
        notes.append("tone: " + emotion.lower())
    for e in events:
        if e in ("Laughter", "Applause", "Cry", "Cough", "Sneeze"):
            notes.append("laughing" if e == "Laughter" else e.lower())
    return f"[{'; '.join(notes)}]" if notes else ""


def _annotate(clean: str, emotion, events) -> str:
    note = _note(emotion, events)
    return f"{clean} {note}" if note and clean else clean


def _refine(path: str) -> str:
    """Whisper pass over one finished utterance: greedy-free beam search, no temperature
    fallback (a fallback is where the hallucinations come from), no cross-segment
    conditioning (each utterance stands alone)."""
    segments, _info = _whisper.transcribe(
        path, language=REFINE_LANGUAGE, beam_size=5, best_of=1, temperature=0.0,
        condition_on_previous_text=False, initial_prompt=REFINE_PROMPT or None,
        vad_filter=False, without_timestamps=True,
    )
    return " ".join(seg.text.strip() for seg in segments).strip()


_WORD_RE = re.compile(r"[a-z0-9']+")


def _agree(a: str, b: str) -> bool:
    wa, wb = set(_WORD_RE.findall(a.lower())), set(_WORD_RE.findall(b.lower()))
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) >= 0.5


def _keep_for_debug(path: str, whisper_text: str, sensevoice_text: str) -> None:
    if not REFINE_DEBUG_DIR or not whisper_text or _agree(whisper_text, sensevoice_text):
        return
    try:
        os.makedirs(REFINE_DEBUG_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%S")
        base = os.path.join(REFINE_DEBUG_DIR, f"{stamp}-{int(time.time() * 1000) % 1000:03d}")
        shutil.copyfile(path, base + ".wav")
        with open(base + ".txt", "w") as f:
            f.write(f"whisper: {whisper_text}\nsensevoice: {sensevoice_text}\n")
        kept = sorted(p for p in os.listdir(REFINE_DEBUG_DIR) if p.endswith(".wav"))
        for old in kept[:-20]:
            for ext in (".wav", ".txt"):
                try:
                    os.unlink(os.path.join(REFINE_DEBUG_DIR, old[:-4] + ext))
                except OSError:
                    pass
    except Exception as e:  # noqa: BLE001
        print("[refine] debug copy failed:", e, flush=True)


async def _save_upload(file: UploadFile) -> str:
    data = await file.read()
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(data)
        return tf.name


@app.post("/v1/audio/refine")
async def refine(file: UploadFile = File(...)):
    """Second pass for a finished utterance: Whisper for the text, SenseVoice for the note,
    run side by side. `text` is empty when Whisper is unavailable (the caller keeps the
    streaming text); `note` is empty when the tone is neutral or notes are hidden."""
    path = await _save_upload(file)
    t0 = time.monotonic()
    try:
        tone_task = asyncio.to_thread(_transcribe, path)
        if _whisper is not None:
            (clean, emotion, events), refined = await asyncio.gather(tone_task, asyncio.to_thread(_refine, path))
        else:
            (clean, emotion, events), refined = await tone_task, ""
        _keep_for_debug(path, refined, clean)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    ms = int((time.monotonic() - t0) * 1000)
    note = _note(emotion, events) if _emotion_enabled else ""
    print(f"[refine] {ms}ms emo={emotion} events={events} whisper={refined!r} sensevoice={clean!r}", flush=True)
    return JSONResponse({"text": refined, "note": note, "sensevoice_text": clean, "emotion": emotion, "events": events, "ms": ms})


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("sensevoice"),
    language: str = Form("en"),
    response_format: str = Form("json"),
    temperature: str = Form("0"),
):
    path = await _save_upload(file)
    try:
        info = sf.info(path)
        dur, rate, ch = info.duration, info.samplerate, info.channels
    except Exception:  # noqa: BLE001
        dur, rate, ch = -1.0, -1, -1
    try:
        clean, emotion, events = _transcribe(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    # Diagnostic: see exactly what audio arrived and what SenseVoice made of it.
    print(f"[stt] dur={dur:.2f}s rate={rate} ch={ch} emo={emotion} events={events} text={clean!r}", flush=True)
    text = _annotate(clean, emotion, events) if _emotion_enabled else clean
    if (response_format or "json").lower() == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text, "emotion": emotion, "events": events})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
