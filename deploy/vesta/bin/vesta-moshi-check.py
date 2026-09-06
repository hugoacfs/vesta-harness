#!/usr/bin/env python3
"""vesta-moshi-check — probe Kyutai moshi-server's streaming TTS and STT from the agent container.

  docker cp deploy/vesta/bin/vesta-moshi-check.py livekit-agent:/tmp/moshi-check.py
  docker exec livekit-agent python /tmp/moshi-check.py tts "Hello there, this is a streaming test."
  docker exec livekit-agent python /tmp/moshi-check.py stt /tmp/q2.wav

TTS: reports time to first audio after the first word was sent and total audio length.
STT: streams the WAV in 80 ms chunks in real time and prints each word with its arrival
     delay relative to the audio position, plus the pause-head values that end a turn.
"""
import asyncio
import os
import sys
import time
import wave

import msgpack
import numpy as np
import websockets

URL = os.environ.get("KYUTAI_WS_URL", "ws://127.0.0.1:8090")
KEY = os.environ.get("KYUTAI_API_KEY", "public_token")
VOICE = os.environ.get("TTS_VOICE", "expresso/ex03-ex01_calm_001_channel1_1143s.wav")
HDR = {"kyutai-api-key": KEY}


async def tts(text: str) -> int:
    from urllib.parse import quote
    url = f"{URL}/api/tts_streaming?voice={quote(VOICE, safe='')}&format=PcmMessagePack"
    async with websockets.connect(url, additional_headers=HDR, max_size=None) as ws:
        t0 = time.monotonic(); first = None; samples = 0

        async def send():
            for w in text.split():
                await ws.send(msgpack.packb({"type": "Text", "text": w}))
            await ws.send(msgpack.packb({"type": "Eos"}))

        st = asyncio.create_task(send())
        async for raw in ws:
            msg = msgpack.unpackb(raw, raw=False)
            if msg["type"] == "Audio":
                if first is None:
                    first = time.monotonic() - t0
                samples += len(msg["pcm"])
            elif msg["type"] == "Error":
                print("error:", msg.get("message")); return 1
        await st
        print(f"tts: first audio {first:.2f}s after first word; {samples / 24000:.1f}s of audio in {time.monotonic() - t0:.2f}s")
        return 0


async def stt(path: str) -> int:
    with wave.open(path, "rb") as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    if rate != 24000:
        n = int(len(pcm) * 24000 / rate)
        pcm = np.interp(np.linspace(0, 1, n, endpoint=False), np.linspace(0, 1, len(pcm), endpoint=False), pcm).astype(np.float32)
    total_s = len(pcm) / 24000
    async with websockets.connect(f"{URL}/api/asr-streaming", additional_headers=HDR, max_size=None) as ws:
        t0 = time.monotonic(); words = []

        async def send():
            pos = 0
            while pos < len(pcm):
                chunk = pcm[pos:pos + 1920]; pos += 1920
                await ws.send(msgpack.packb({"type": "Audio", "pcm": chunk.tolist()}, use_single_float=True))
                await asyncio.sleep(0.08)   # real time
            # keep feeding silence so the pause prediction can fire
            for _ in range(40):
                await ws.send(msgpack.packb({"type": "Audio", "pcm": [0.0] * 1920}, use_single_float=True))
                await asyncio.sleep(0.08)

        st = asyncio.create_task(send())
        fired = None
        try:
            async for raw in ws:
                msg = msgpack.unpackb(raw, raw=False)
                k = msg["type"]
                now = time.monotonic() - t0
                if k == "Word":
                    words.append(msg["text"])
                    print(f"  +{now:5.2f}s word {msg['text']!r} (audio pos {msg.get('start_time', 0):.2f}s)")
                elif k == "Step":
                    prs = msg.get("prs") or []
                    if words and fired is None and len(prs) > 1 and prs[1] > 0.5:
                        fired = now
                        print(f"  +{now:5.2f}s pause head[1]={prs[1]:.2f} -> end of turn ({now - total_s:+.2f}s vs audio end)")
                        break
                elif k == "Error":
                    print("error:", msg.get("message")); break
        finally:
            st.cancel()
        print(f"stt: {' '.join(words)!r}; audio {total_s:.1f}s; turn ended {'never' if fired is None else f'{fired:.2f}s'}")
        return 0 if words else 1


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__); raise SystemExit(64)
    mode, arg = sys.argv[1], " ".join(sys.argv[2:]) if sys.argv[1] == "tts" else sys.argv[2]
    raise SystemExit(asyncio.run(tts(arg) if mode == "tts" else stt(arg)))
