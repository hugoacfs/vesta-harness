# SenseVoice (FunASR) STT + emotion — runs on the RTX 3060. torch bundles its own
# CUDA libs, but the CUDA runtime base keeps GPU access consistent with the host.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    MODELSCOPE_CACHE=/models/hf/modelscope \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-dev libgomp1 libsndfile1 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["python3", "-u", "app.py"]
