# CPU-only worker: VAD (silero) and the turn-detector run on CPU via onnxruntime.
# All GPU work (SenseVoice STT / Kyutai TTS) lives in sidecars on the 3060.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY agent.py kyutai.py .
# Pre-download the silero VAD + turn-detector model weights into the image so the
# worker starts fast and offline. (|| true: fall back to a runtime download.)
RUN python agent.py download-files || true

CMD ["python", "agent.py", "start"]
