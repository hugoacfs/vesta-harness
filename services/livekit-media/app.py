"""
livekit-media — SenseVoice STT sidecar (OpenAI-compatible) for the LiveKit agent.

SenseVoice (FunAudioLLM/Alibaba) transcribes AND perceives the speaker's emotion +
audio events (including laughter) in one fast model — so Vesta can hear *how* you
sound and react, while Qwen-27B stays the brain. Replaces faster-whisper.

    POST /v1/audio/transcriptions  (multipart file) -> {"text","emotion","events"}

The `text` field is the words plus, when notable, a compact bracketed note like
" [tone: happy; laughing]" so the LLM (via the openai STT plugin, which only passes
`text`) sees how the user sounded. The agent's system prompt tells Qwen to adapt to
it and never read it aloud.
"""
import os
import re
import tempfile

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
    return {"ok": True, "asr": ASR_MODEL, "device": _dev, "emotion_enabled": _emotion_enabled}


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


def _annotate(clean: str, emotion, events) -> str:
    notes = []
    if emotion and emotion not in ("NEUTRAL", "EMO_UNKNOWN"):
        notes.append("tone: " + emotion.lower())
    for e in events:
        if e in ("Laughter", "Applause", "Cry", "Cough", "Sneeze"):
            notes.append("laughing" if e == "Laughter" else e.lower())
    if notes and clean:
        return f"{clean} [{'; '.join(notes)}]"
    return clean


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("sensevoice"),
    language: str = Form("en"),
    response_format: str = Form("json"),
    temperature: str = Form("0"),
):
    data = await file.read()
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(data)
        path = tf.name
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
