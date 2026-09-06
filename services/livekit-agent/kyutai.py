"""
LiveKit plugins for Kyutai's moshi-server (the Rust server behind Unmute):

  KyutaiTTS — streaming text in, streaming audio out over /api/tts_streaming.
              The agent pushes the LLM's tokens as they arrive; audio starts a few
              hundred milliseconds after the first words instead of after the
              first full sentence has been synthesized.
  KyutaiSTT — streaming speech-to-text with semantic end-of-turn over
              /api/asr-streaming. Words arrive ~0.5 s behind the audio while the
              user is still talking, and the model's own pause prediction ends the
              turn without waiting for a batch transcription.

Wire protocol (msgpack over websockets, 24 kHz float32 mono PCM):
  TTS  in : {"type":"Text","text":word} …, {"type":"Eos"}
       out: {"type":"Ready"} | {"type":"Audio","pcm":[f32…]} | {"type":"Text",…} | {"type":"Error","message"}
            the server closes the socket when the utterance is finished.
  STT  in : {"type":"Audio","pcm":[f32…]}
       out: {"type":"Ready"} | {"type":"Word","text","start_time"} | {"type":"EndWord","stop_time"}
            | {"type":"Step","step_idx","prs":[p_0.5s, p_1s, p_2s, p_3s],…} | {"type":"Error","message"}
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from urllib.parse import quote

import io
import re
import wave

import aiohttp
import msgpack
import numpy as np
import websockets
from livekit.agents import APIConnectionError, APIError, stt, tts, utils
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions, NotGivenOr, NOT_GIVEN
from livekit.agents.utils import aio

log = logging.getLogger("vesta-voice.kyutai")

SAMPLE_RATE = 24000
NUM_CHANNELS = 1
# STT: which pause-prediction head ends the turn (0: 0.5 s, 1: 1 s, 2: 2 s, 3: 3 s) and the threshold.
PAUSE_HEAD = int(os.environ.get("KYUTAI_PAUSE_HEAD", "1"))
PAUSE_THRESHOLD = float(os.environ.get("KYUTAI_PAUSE_THRESHOLD", "0.5"))
# Words trail the audio by asr_delay (6 × 80 ms) plus the model's own emission lag (the last
# word of an utterance was seen 0.8 s after the pause prediction), so a pause can fire before
# the last word arrives: finalize this long after the pause, or after the latest word,
# whichever is later.
PAUSE_GRACE_S = float(os.environ.get("KYUTAI_PAUSE_GRACE_S", "0.9"))
# Fallback: finalize this long after the last word if the pause head never fires.
FINAL_AFTER_SILENCE_S = float(os.environ.get("KYUTAI_FINAL_AFTER_SILENCE_S", "1.2"))
# Audio is sent in chunks of this many samples (80 ms = one mimi frame).
STT_CHUNK = 1920
_TONE_NOTE = re.compile(r"\[tone:[^\]]*\]")


def _headers(api_key: str) -> dict[str, str]:
    return {"kyutai-api-key": api_key}


def _resample_factor(pcm: np.ndarray, speed: float) -> np.ndarray:
    """Plain resample by 1/speed (pitch follows speed, like the WAV sidecar did)."""
    if speed == 1.0 or len(pcm) == 0:
        return pcm
    n = max(1, int(round(len(pcm) / speed)))
    x_old = np.linspace(0.0, 1.0, num=len(pcm), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, pcm).astype(np.float32)


def _to_s16(pcm: np.ndarray) -> bytes:
    return (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


# ---------------------------------------------------------------- TTS
class KyutaiTTS(tts.TTS):
    def __init__(self, *, url: str, voice: str, api_key: str = "public_token", speed: float = 1.0) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=True),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
        )
        self._url = url.rstrip("/")
        self._voice = voice
        self._api_key = api_key
        self._speed = speed

    @property
    def label(self) -> str:
        return "kyutai.moshi-server"

    def _ws_url(self) -> str:
        return f"{self._url}/api/tts_streaming?voice={quote(self._voice, safe='')}&format=PcmMessagePack"

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> tts.ChunkedStream:
        return KyutaiChunkedStream(tts=self, input_text=text, conn_options=conn_options)

    def stream(self, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> tts.SynthesizeStream:
        return KyutaiSynthesizeStream(tts=self, conn_options=conn_options)

    async def _speak(self, words: "asyncio.Queue[str | None]", on_pcm, ready_deadline: float = 30.0) -> None:
        """Drive one utterance: words in (None ends it), float32 pcm chunks out via on_pcm."""
        try:
            ws = await websockets.connect(self._ws_url(), additional_headers=_headers(self._api_key), max_size=None, open_timeout=ready_deadline)
        except Exception as e:  # noqa: BLE001
            raise APIConnectionError(f"kyutai tts connect failed: {e}") from e
        async with ws:
            async def send() -> None:
                while True:
                    word = await words.get()
                    if word is None:
                        await ws.send(msgpack.packb({"type": "Eos"}))
                        return
                    await ws.send(msgpack.packb({"type": "Text", "text": word}))

            async def recv() -> None:
                async for raw in ws:
                    msg = msgpack.unpackb(raw, raw=False)
                    kind = msg.get("type")
                    if kind == "Audio":
                        on_pcm(np.asarray(msg["pcm"], dtype=np.float32))
                    elif kind == "Error":
                        raise APIError(f"kyutai tts: {msg.get('message')}")

            send_task = asyncio.create_task(send())
            try:
                await recv()          # the server closes the socket after the utterance
            finally:
                if not send_task.done():
                    send_task.cancel()
                    try:
                        await send_task
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass


class _WordSplitter:
    """Turn a token stream into whitespace-delimited words; the tail is released on flush."""

    def __init__(self) -> None:
        self._buf = ""

    def feed(self, text: str) -> list[str]:
        self._buf += text
        parts = self._buf.split()
        if not parts:
            return []
        if self._buf[-1].isspace():
            self._buf = ""
            return parts
        self._buf = parts[-1]
        return parts[:-1]

    def flush(self) -> list[str]:
        tail, self._buf = self._buf.strip(), ""
        return [tail] if tail else []


class KyutaiSynthesizeStream(tts.SynthesizeStream):
    def __init__(self, *, tts: KyutaiTTS, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, conn_options=conn_options)
        self._kyutai = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        request_id = utils.shortuuid()
        output_emitter.initialize(
            request_id=request_id, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS,
            mime_type="audio/pcm", frame_size_ms=80, stream=True,
        )
        words: asyncio.Queue[str | None] = asyncio.Queue()
        splitter = _WordSplitter()
        started = False
        t0 = time.monotonic()
        first = [True]

        def on_pcm(pcm: np.ndarray) -> None:
            if first[0]:
                first[0] = False
                log.info("kyutai tts: first audio %.2fs after first word", time.monotonic() - t0)
            output_emitter.push(_to_s16(_resample_factor(pcm, self._kyutai._speed)))

        speak_task: asyncio.Task[None] | None = None
        async for item in self._input_ch:
            if isinstance(item, self._FlushSentinel):
                if started:
                    for w in splitter.flush():
                        words.put_nowait(w)
                    words.put_nowait(None)
                break
            if not started:
                started = True
                t0 = time.monotonic()
                output_emitter.start_segment(segment_id=utils.shortuuid())
                speak_task = asyncio.create_task(self._kyutai._speak(words, on_pcm))
            for w in splitter.feed(item):
                self._mark_started()
                words.put_nowait(w)
        if speak_task is not None:
            await speak_task
            output_emitter.end_segment()


class KyutaiChunkedStream(tts.ChunkedStream):
    """Non-streaming path (session.say with a plain string): the whole text at once."""

    def __init__(self, *, tts: KyutaiTTS, input_text: str, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._kyutai = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=utils.shortuuid(), sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS,
            mime_type="audio/pcm", frame_size_ms=80,
        )
        words: asyncio.Queue[str | None] = asyncio.Queue()
        for w in self._input_text.split():
            words.put_nowait(w)
        words.put_nowait(None)
        await self._kyutai._speak(words, lambda pcm: output_emitter.push(_to_s16(_resample_factor(pcm, self._kyutai._speed))))


# ---------------------------------------------------------------- STT
class KyutaiSTT(stt.STT):
    """tone_url: the SenseVoice sidecar's transcription endpoint; when set, each finished
    utterance is also sent there and its "[tone: …]" note is handed to on_tone out of band,
    so the transcript never waits for it."""

    def __init__(self, *, url: str, api_key: str = "public_token", language: str = "en",
                 tone_url: str | None = None, on_tone=None) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True, offline_recognize=False))
        self._url = url.rstrip("/")
        self._api_key = api_key
        self._language = language
        self._tone_url = tone_url
        self._on_tone = on_tone

    @property
    def label(self) -> str:
        return "kyutai.moshi-server"

    async def _recognize_impl(self, buffer, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> stt.SpeechEvent:
        raise NotImplementedError("KyutaiSTT is streaming-only; use stream()")

    def stream(self, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> stt.RecognizeStream:
        return KyutaiRecognizeStream(stt=self, conn_options=conn_options, language=self._language)

    async def tone_of(self, pcm: np.ndarray) -> str | None:
        """Ask the SenseVoice sidecar how the utterance sounded; None when unavailable or neutral."""
        if not self._tone_url or len(pcm) < SAMPLE_RATE // 4:
            return None
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SAMPLE_RATE)
            w.writeframes(_to_s16(pcm))
        form = aiohttp.FormData()
        form.add_field("file", buf.getvalue(), filename="utterance.wav", content_type="audio/wav")
        form.add_field("model", "whisper-1")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as http:
                async with http.post(self._tone_url, data=form) as r:
                    data = await r.json()
        except Exception as e:  # noqa: BLE001
            log.warning("tone lookup failed: %s", e)
            return None
        m = _TONE_NOTE.search(str(data.get("text", "")))
        return m.group(0) if m else None


class KyutaiRecognizeStream(stt.RecognizeStream):
    def __init__(self, *, stt: KyutaiSTT, conn_options: APIConnectOptions, language: str) -> None:
        super().__init__(stt=stt, conn_options=conn_options, sample_rate=SAMPLE_RATE)
        self._kyutai = stt
        self._language = language
        self._words: list[str] = []
        self._speech_started = False
        self._last_word_at = 0.0
        self._utterance_start = 0.0
        self._pause_at: float | None = None   # when the pause head fired for the current utterance
        self._audio: list[np.ndarray] = []   # the utterance so far, for the tone lookup

    def _emit(self, kind: stt.SpeechEventType, text: str = "") -> None:
        ev = stt.SpeechEvent(type=kind, request_id="", alternatives=[stt.SpeechData(language=self._language, text=text)] if text or kind in (stt.SpeechEventType.INTERIM_TRANSCRIPT, stt.SpeechEventType.FINAL_TRANSCRIPT) else [])
        self._event_ch.send_nowait(ev)

    def _finalize(self, reason: str) -> None:
        if not self._words:
            return
        text = " ".join(self._words).strip()
        self._words = []
        self._speech_started = False
        self._pause_at = None
        audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
        self._audio = []
        log.info("kyutai stt: final (%s) %.1fs after first word: %r", reason, time.monotonic() - self._utterance_start, text[:80])
        self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, text)
        self._emit(stt.SpeechEventType.END_OF_SPEECH)
        if self._kyutai._tone_url and self._kyutai._on_tone is not None:
            async def _tone() -> None:
                note = await self._kyutai.tone_of(audio)
                if note:
                    self._kyutai._on_tone(note)
            asyncio.get_running_loop().create_task(_tone())

    async def _run(self) -> None:
        url = f"{self._kyutai._url}/api/asr-streaming"
        try:
            ws = await websockets.connect(url, additional_headers=_headers(self._kyutai._api_key), max_size=None)
        except Exception as e:  # noqa: BLE001
            raise APIConnectionError(f"kyutai stt connect failed: {e}") from e
        async with ws:
            pending = np.zeros(0, dtype=np.float32)

            async def send() -> None:
                nonlocal pending
                async for item in self._input_ch:
                    if isinstance(item, self._FlushSentinel):
                        # The framework's VAD saw the end of speech: finalize what we have.
                        self._finalize("vad")
                        continue
                    frame = item
                    samples = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0
                    if frame.num_channels > 1:
                        samples = samples.reshape(-1, frame.num_channels).mean(axis=1)
                    pending = np.concatenate([pending, samples])
                    if self._speech_started or len(self._audio) < 12:
                        self._audio.append(samples)          # keep ~1 s of lead-in before the first word
                        if not self._speech_started and len(self._audio) > 12:
                            self._audio = self._audio[-12:]
                    while len(pending) >= STT_CHUNK:
                        chunk, pending = pending[:STT_CHUNK], pending[STT_CHUNK:]
                        await ws.send(msgpack.packb({"type": "Audio", "pcm": chunk.tolist()}, use_single_float=True))
                # input ended: flush the remainder and finalize
                if len(pending):
                    await ws.send(msgpack.packb({"type": "Audio", "pcm": pending.tolist()}, use_single_float=True))
                self._finalize("end")

            async def recv() -> None:
                async for raw in ws:
                    msg = msgpack.unpackb(raw, raw=False)
                    kind = msg.get("type")
                    if kind == "Word":
                        word = str(msg.get("text", "")).strip()
                        if not word:
                            continue
                        if not self._speech_started:
                            self._speech_started = True
                            self._utterance_start = time.monotonic()
                            self._emit(stt.SpeechEventType.START_OF_SPEECH)
                        self._words.append(word)
                        self._last_word_at = time.monotonic()
                        self._emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, " ".join(self._words))
                    elif kind == "Step":
                        prs = msg.get("prs") or []
                        if self._words and self._pause_at is None and len(prs) > PAUSE_HEAD and prs[PAUSE_HEAD] > PAUSE_THRESHOLD:
                            self._pause_at = time.monotonic()   # the watchdog finalizes after the grace
                    elif kind == "Error":
                        raise APIError(f"kyutai stt: {msg.get('message')}")

            async def watchdog() -> None:
                while True:
                    await asyncio.sleep(0.05)
                    if not self._words:
                        continue
                    now = time.monotonic()
                    if self._pause_at is not None and now - max(self._pause_at, self._last_word_at) >= PAUSE_GRACE_S:
                        self._finalize("pause")
                    elif now - self._last_word_at > FINAL_AFTER_SILENCE_S:
                        self._finalize("silence")

            tasks = [asyncio.create_task(send()), asyncio.create_task(recv()), asyncio.create_task(watchdog())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                for t in done:
                    t.result()
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
