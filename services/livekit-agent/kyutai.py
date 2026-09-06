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
    """refine_url: the media sidecar's second pass (/v1/audio/refine): once the streaming model
    has ended an utterance, the same audio goes through Whisper for the text the brain receives
    and through SenseVoice for the "[tone: …]" note, which reaches on_tone before the final
    transcript is emitted. tone_url: the SenseVoice-only lookup used when refine is off (the
    note then arrives out of band, and the streamed words are the transcript)."""

    def __init__(self, *, url: str, api_key: str = "public_token", language: str = "en",
                 tone_url: str | None = None, refine_url: str | None = None, on_tone=None) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True, offline_recognize=False))
        self._url = url.rstrip("/")
        self._api_key = api_key
        self._language = language
        self._tone_url = tone_url
        self._refine_url = refine_url
        self._on_tone = on_tone

    @property
    def label(self) -> str:
        return "kyutai.moshi-server"

    async def _recognize_impl(self, buffer, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> stt.SpeechEvent:
        raise NotImplementedError("KyutaiSTT is streaming-only; use stream()")

    def stream(self, *, language: NotGivenOr[str] = NOT_GIVEN, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> stt.RecognizeStream:
        return KyutaiRecognizeStream(stt=self, conn_options=conn_options, language=self._language)

    @staticmethod
    def _wav_form(pcm: np.ndarray) -> aiohttp.FormData:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SAMPLE_RATE)
            w.writeframes(_to_s16(pcm))
        form = aiohttp.FormData()
        form.add_field("file", buf.getvalue(), filename="utterance.wav", content_type="audio/wav")
        form.add_field("model", "whisper-1")
        return form

    async def tone_of(self, pcm: np.ndarray) -> str | None:
        """Ask the SenseVoice sidecar how the utterance sounded; None when unavailable or neutral."""
        if not self._tone_url or len(pcm) < SAMPLE_RATE // 4:
            return None
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as http:
                async with http.post(self._tone_url, data=self._wav_form(pcm)) as r:
                    data = await r.json()
        except Exception as e:  # noqa: BLE001
            log.warning("tone lookup failed: %s", e)
            return None
        m = _TONE_NOTE.search(str(data.get("text", "")))
        return m.group(0) if m else None

    async def refine(self, pcm: np.ndarray) -> tuple[str | None, str | None]:
        """Second pass over one finished utterance: (text, note); either is None when the
        sidecar has nothing better (no Whisper loaded, neutral tone, notes hidden)."""
        if not self._refine_url or len(pcm) < SAMPLE_RATE // 4:
            return None, None
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=REFINE_TIMEOUT_S + 1.0)) as http:
            async with http.post(self._refine_url, data=self._wav_form(pcm)) as r:
                data = await r.json()
        text = str(data.get("text") or "").strip() or None
        note = str(data.get("note") or "").strip() or None
        return text, note


# moshi-server drops an ASR socket that has carried no message for 120 s (batched_asr.rs,
# long_timeout). A muted microphone or a caller who left and came back used to hit that, and
# the dead socket then took the recognition pump down for the rest of the call: send a frame of
# silence whenever the room has been quiet this long, and reopen the socket after any drop.
STT_KEEPALIVE_S = float(os.environ.get("KYUTAI_STT_KEEPALIVE_S", "20"))
_SILENCE_CHUNK = [0.0] * STT_CHUNK
# The streaming model reports a word 0.5–1 s after it was spoken, so the audio kept for the
# second pass starts this long before the first word: the whole onset of the utterance.
LEAD_IN_SAMPLES = int(float(os.environ.get("KYUTAI_LEAD_IN_S", "1.5")) * SAMPLE_RATE)
# The final transcript waits at most this long for the second pass (it usually finishes
# inside the pause grace, because it starts when the pause is predicted).
REFINE_TIMEOUT_S = float(os.environ.get("KYUTAI_REFINE_TIMEOUT_S", "1.5"))


def _plausible(refined: str | None, streamed: str) -> bool:
    """Accept the second pass unless it is empty or wildly different in length from the
    streamed words (a hallucinated sentence over silence, or a truncated one)."""
    if not refined:
        return False
    ratio = len(refined.split()) / max(1, len(streamed.split()))
    return 0.5 <= ratio <= 2.5


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
        self._audio: list[np.ndarray] = []   # the utterance so far (from the lead-in on), for the second pass
        self._lead: list[np.ndarray] = []    # rolling audio before the first word
        self._lead_samples = 0
        self._spec: asyncio.Task[tuple[str | None, str | None]] | None = None   # second pass started at the pause
        self._spec_words = 0                 # how many words it covered
        self._delivery: asyncio.Task[None] | None = None   # finals are delivered in order
        self._input_done = False             # the framework closed the input: no reconnects after this

    def _emit(self, kind: stt.SpeechEventType, text: str = "") -> None:
        ev = stt.SpeechEvent(type=kind, request_id="", alternatives=[stt.SpeechData(language=self._language, text=text)] if text or kind in (stt.SpeechEventType.INTERIM_TRANSCRIPT, stt.SpeechEventType.FINAL_TRANSCRIPT) else [])
        self._event_ch.send_nowait(ev)

    def _start_refine(self) -> asyncio.Task[tuple[str | None, str | None]]:
        audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
        return asyncio.get_running_loop().create_task(self._kyutai.refine(audio))

    def _finalize(self, reason: str) -> None:
        if not self._words:
            return
        text = " ".join(self._words).strip()
        words = len(self._words)
        started = self._utterance_start
        audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
        spec = self._spec if self._spec is not None and self._spec_words == words else None
        if self._spec is not None and spec is None:
            self._spec.cancel()   # words came after the pause: that pass is stale
        self._words = []
        self._speech_started = False
        self._pause_at = None
        self._audio = []
        self._spec = None
        if not self._kyutai._refine_url:
            log.info("kyutai stt: final (%s) %.1fs after first word: %r", reason, time.monotonic() - started, text[:80])
            self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, text)
            self._emit(stt.SpeechEventType.END_OF_SPEECH)
            if self._kyutai._tone_url and self._kyutai._on_tone is not None:
                async def _tone() -> None:
                    note = await self._kyutai.tone_of(audio)
                    if note:
                        self._kyutai._on_tone(note)
                asyncio.get_running_loop().create_task(_tone())
            return
        pending = spec or asyncio.get_running_loop().create_task(self._kyutai.refine(audio))
        self._delivery = asyncio.get_running_loop().create_task(self._deliver(self._delivery, text, pending, reason, started))

    async def _deliver(self, previous: asyncio.Task[None] | None, text: str, pending: asyncio.Task[tuple[str | None, str | None]], reason: str, started: float) -> None:
        if previous is not None:
            await asyncio.wait({previous})
        t0 = time.monotonic()
        refined: str | None = None
        note: str | None = None
        try:
            refined, note = await asyncio.wait_for(pending, REFINE_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("kyutai stt: second pass took over %.1fs; using the streamed words", REFINE_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            log.warning("kyutai stt: second pass failed (%s); using the streamed words", e)
        final = refined if _plausible(refined, text) else text
        log.info("kyutai stt: final (%s) %.1fs after first word, second pass waited %dms: %r%s",
                 reason, time.monotonic() - started, int((time.monotonic() - t0) * 1000), final[:80],
                 "" if final == text else f" (streamed: {text[:60]!r})")
        if note and self._kyutai._on_tone is not None:
            self._kyutai._on_tone(note)   # before the transcript, so the note rides on this turn
        self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, final)
        self._emit(stt.SpeechEventType.END_OF_SPEECH)

    async def _run(self) -> None:
        """One recognition stream for the life of the call: the socket to moshi-server is
        reopened after any drop, so the framework never sees a dead pump."""
        attempt = 0
        try:
            while not self._input_done:
                try:
                    await self._session()
                except (websockets.exceptions.WebSocketException, OSError, APIConnectionError, APIError) as e:
                    if self._input_done:
                        return
                    attempt += 1
                    delay = min(5.0, 0.5 * attempt)
                    log.warning("kyutai stt: connection lost (%s); reopening in %.1fs", e, delay)
                    self._finalize("reconnect")
                    await asyncio.sleep(delay)
                    continue
                if not self._input_done:
                    attempt = 0
                    log.info("kyutai stt: server closed the stream; reopening")
                    await asyncio.sleep(0.2)
        finally:
            if self._delivery is not None and not self._delivery.done():
                await asyncio.wait({self._delivery}, timeout=REFINE_TIMEOUT_S + 0.5)

    async def _session(self) -> None:
        url = f"{self._kyutai._url}/api/asr-streaming"
        try:
            ws = await websockets.connect(url, additional_headers=_headers(self._kyutai._api_key), max_size=None, open_timeout=10)
        except Exception as e:  # noqa: BLE001
            raise APIConnectionError(f"kyutai stt connect failed: {e}") from e
        async with ws:
            pending = np.zeros(0, dtype=np.float32)
            frames = self._input_ch.__aiter__()

            async def send() -> None:
                nonlocal pending
                while True:
                    try:
                        item = await asyncio.wait_for(frames.__anext__(), timeout=STT_KEEPALIVE_S)
                    except asyncio.TimeoutError:
                        # Nothing from the room (muted, or the caller is away): keep the slot alive.
                        await ws.send(msgpack.packb({"type": "Audio", "pcm": _SILENCE_CHUNK}, use_single_float=True))
                        continue
                    except StopAsyncIteration:
                        break
                    if isinstance(item, self._FlushSentinel):
                        # The framework's VAD saw the end of speech: finalize what we have.
                        self._finalize("vad")
                        continue
                    frame = item
                    samples = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0
                    if frame.num_channels > 1:
                        samples = samples.reshape(-1, frame.num_channels).mean(axis=1)
                    pending = np.concatenate([pending, samples])
                    if self._speech_started:
                        self._audio.append(samples)
                    else:
                        self._lead.append(samples)
                        self._lead_samples += len(samples)
                        while self._lead and self._lead_samples - len(self._lead[0]) >= LEAD_IN_SAMPLES:
                            self._lead_samples -= len(self._lead.pop(0))
                    while len(pending) >= STT_CHUNK:
                        chunk, pending = pending[:STT_CHUNK], pending[STT_CHUNK:]
                        await ws.send(msgpack.packb({"type": "Audio", "pcm": chunk.tolist()}, use_single_float=True))
                # input ended: flush the remainder and finalize
                if len(pending):
                    await ws.send(msgpack.packb({"type": "Audio", "pcm": pending.tolist()}, use_single_float=True))
                self._input_done = True
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
                            self._audio = self._lead   # the onset was spoken before this word arrived
                            self._lead = []
                            self._lead_samples = 0
                            self._emit(stt.SpeechEventType.START_OF_SPEECH)
                        self._words.append(word)
                        self._last_word_at = time.monotonic()
                        self._emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, " ".join(self._words))
                    elif kind == "Step":
                        prs = msg.get("prs") or []
                        if self._words and self._pause_at is None and len(prs) > PAUSE_HEAD and prs[PAUSE_HEAD] > PAUSE_THRESHOLD:
                            self._pause_at = time.monotonic()   # the watchdog finalizes after the grace
                            if self._kyutai._refine_url:
                                # Start the second pass now; the grace usually covers it.
                                self._spec = self._start_refine()
                                self._spec_words = len(self._words)
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
                # The first task to finish decides: send() ends with the input (done), recv()
                # ends with the socket (reopen), and an exception from either is re-raised.
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    t.result()
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
