# Kyutai TTS Server

> **Vesta deployment note (2026-09-06):** this is the live TTS of the voice stack, pinned to the RTX 3060, `127.0.0.1:8010`, used by `livekit-agent`; source of truth is `services/kyutai-tts` in the vesta-harness checkout (compose: `deploy/vesta/kyutai-tts.docker-compose.yaml`, installed at `/srv/ai/compose/kyutai-tts`). Vesta addition: `response_format: pcm` streams raw s16le 24 kHz mono while the model is still generating (first bytes ~200 ms in), which is what the LiveKit agent uses; other formats keep the upstream whole-file behaviour. The rest of this file is the upstream project README.

Kyutai TTS Server is an OpenAI-compatible Text-to-Speech (TTS) API server built with FastAPI. It provides a simple interface for generating speech from text using state-of-the-art TTS models.

## Features

- OpenAI-compatible API for text-to-speech generation
- Supports multiple audio formats (WAV, MP3, FLAC, OGG)
- Multi-voice and Multi Dialogue generation support
- Health check endpoint
- Docker support for easy deployment

## Voice Library
The Kyutai (voices)[https://huggingface.co/kyutai/tts-voices] will be automatically downloaded, along with the (model)[https://huggingface.co/kyutai/tts-1.6b-en_fr] itself, from huggingface during startup to the cache directory.

For the API, you can provide the wav file path from this voice library. (for example `expresso/ex03-ex01_happy_001_channel1_334s.wav`).

## Project Structure

```
Kyutai-TTS-Server/
├── app/
│   ├── __init__.py
│   ├── server.py
│   ├── config.py
│   ├── models.py
│   ├── tts.py
│   └── utils.py
├── .gitignore
├── docker-compose.yaml
├── Dockerfile
├── requirements.txt
└── README.md
```

## API Endpoints

### Text-to-Speech Generation

- **URL**: `/v1/audio/speech`
- **Method**: `POST`
- **Request Body**:
  ```json
  {
    "model": "optional-model-name",
    "input": "Text to convert to speech",
    "voice": "expresso/ex03-ex01_happy_001_channel1_334s.wav",
    "response_format": "wav|mp3|flac|ogg",
    "speed": 1.0
  }
  ```
- **Response**: Audio file in the requested format

### Multi-Voice, Multi-Dialogue Text-to-Speech Generation (extended from OpenAI API)

- **URL**: `/v1/audio/speech`
- **Method**: `POST`
- **Request Body**:
  ```json
  {
    "model": "optional-model-name",
    "inputs": [
      "Hey there, I'm speaker A",
      "And I'm speaker B!",
      "We are having a dialogue"
    ],
    "voices": [
      "expresso/ex03-ex01_happy_001_channel1_334s.wav",
      "expresso/ex04-ex02_sarcastic_001_channel2_466s.wav"
    ]
    "response_format": "wav|mp3|flac|ogg",
    "speed": 1.0
  }
  ```
- **Response**: Audio file in the requested format

### Health Check

- **URL**: `/health`
- **Method**: `GET`
- **Response**:
  ```json
  {
    "status": "healthy"
  }
  ```

## Running the Server

### Using Docker

1. Build the Docker image:
   ```bash
   docker build -t kyutai-tts-server .
   ```

2. Run the Docker container:
   ```bash
   docker run -d -p 8000:8000 kyutai-tts-server
   ```

### Locally

1. Install the required dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the server:
   ```bash
   python server.py --host 0.0.0.0 --port 8000 --reload
   ```

## License

This project is licensed under the MIT License.
