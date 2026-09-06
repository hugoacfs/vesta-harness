# Use NVIDIA CUDA base image for GPU support
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# Set the Hugging Face home directory for better model caching
ENV HF_HOME=/app/cache

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy the requirements file
COPY requirements.txt .

# Install the required dependencies
RUN pip3 install -r requirements.txt

# Stateful resampler for the streaming PCM path (speed factor without chunk seams)
RUN pip3 install --no-cache-dir "soxr>=0.4,<0.6"

# Copy the entire app directory
COPY app/ .

# Expose the port the app runs on
EXPOSE 8000

# Command to run the application
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8000"]
