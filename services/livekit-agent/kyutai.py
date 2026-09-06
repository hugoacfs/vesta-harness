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
from livekit.agents import APIConnectionError, APIError, stt, tts, utils, vad as lk_vad
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


# Playback pacing (see _Pacer): playback audio held before the first push, and the buffered lead
# below/above which the speed slides between 1.0 and TTS_SPEED. TTS_PREROLL_S=0 and
# TTS_LEAD_LOW_S=0 turn the pacing off.
TTS_PREROLL_S = float(os.environ.get("TTS_PREROLL_S", "0.35"))
TTS_LEAD_LOW_S = float(os.environ.get("TTS_LEAD_LOW_S", "0.15"))
TTS_LEAD_HIGH_S = float(os.environ.get("TTS_LEAD_HIGH_S", "0.5"))
# wsola: pitch-preserving time stretch (audiotsm); resample: the old linear resample (pitch follows speed).
TTS_STRETCH = os.environ.get("TTS_STRETCH", "wsola").strip().lower()
STARVE_LEAD_S = 0.02    # the playout buffer is considered empty below this lead
TEXT_GAP_S = 0.2        # a pause in the model's words longer than this is counted as a text gap

try:
    from audiotsm import wsola as _wsola
    from audiotsm.io.array import ArrayReader as _ArrayReader, ArrayWriter as _ArrayWriter
except Exception:  # noqa: BLE001 — the stretch falls back to resampling
    _wsola = None


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


class _Stretcher:
    """Speed up speech by a factor that can change between chunks: WSOLA keeps the pitch
    (the resample fallback does not). Speeds below 1.0 are never used."""

    def __init__(self, speed: float) -> None:
        self._speed = max(1.0, speed)
        self._tsm = None
        if TTS_STRETCH == "wsola" and _wsola is not None and self._speed > 1.0:
            self._tsm = _wsola(channels=1, speed=self._speed)

    @property
    def speed(self) -> float:
        return self._speed

    def set_speed(self, speed: float) -> None:
        speed = max(1.0, speed)
        if abs(speed - self._speed) < 0.005:
            return
        self._speed = speed
        if self._tsm is not None:
            self._tsm.set_speed(speed)

    def feed(self, pcm: np.ndarray) -> np.ndarray:
        if self._tsm is None:
            return _resample_factor(pcm, self._speed)
        writer = _ArrayWriter(1)
        self._tsm.run(_ArrayReader(pcm.reshape(1, -1)), writer, flush=False)
        return writer.data.reshape(-1).astype(np.float32)

    def flush(self) -> np.ndarray:
        if self._tsm is None:
            return np.zeros(0, dtype=np.float32)
        writer = _ArrayWriter(1)
        self._tsm.run(_ArrayReader(np.zeros((1, 0), dtype=np.float32)), writer, flush=True)
        return writer.data.reshape(-1).astype(np.float32)


class _Pacer:
    """Playback pacing for one utterance. Holds a pre-roll before the first push, stretches the
    server's chunks to the configured speed, slows towards 1.0 when the buffered lead runs low
    (a slower word beats a gap), and keeps the counters behind the utterance log line: the
    lowest lead seen and how often the playout buffer ran empty (an "audio starve")."""

    def __init__(self, speed: float, push) -> None:
        self._push = push
        self._speed = max(1.0, speed)
        self._stretch = _Stretcher(speed)
        self._held: list[np.ndarray] = []
        self._held_n = 0
        self._released = False
        self._t_start = 0.0
        self._pushed = 0          # playback samples handed to the emitter
        self._starving_since: float | None = None
        self.samples_in = 0       # server samples received
        self.min_lead = float("inf")
        self.starves = 0
        self.starve_s = 0.0

    def lead(self, now: float) -> float:
        """Playback seconds pushed but not yet played, by the wall clock since the first push."""
        return self._pushed / SAMPLE_RATE - (now - self._t_start)

    def feed(self, pcm: np.ndarray) -> None:
        self.samples_in += len(pcm)
        now = time.monotonic()
        if self._released:
            lead = self.lead(now)
            self.min_lead = min(self.min_lead, lead)
            if lead < STARVE_LEAD_S:
                if self._starving_since is None:
                    self._starving_since = now
                    self.starves += 1
                if lead < 0.0:
                    # The playout ran dry and restarts with this chunk: re-base the clock.
                    self._t_start = now - self._pushed / SAMPLE_RATE
                    lead = 0.0
            elif self._starving_since is not None:
                self.starve_s += now - self._starving_since
                self._starving_since = None
            self._stretch.set_speed(self._speed_for(lead))
        self._emit(self._stretch.feed(pcm), now)

    def finish(self) -> None:
        now = time.monotonic()
        self._emit(self._stretch.flush(), now)
        if not self._released:
            self._release(now)
        if self._starving_since is not None:
            self.starve_s += now - self._starving_since
            self._starving_since = None

    def summary(self) -> str:
        lead = 0.0 if self.min_lead == float("inf") else self.min_lead
        return (f"{self._pushed / SAMPLE_RATE:.1f}s played from {self.samples_in / SAMPLE_RATE:.1f}s generated, "
                f"min lead {lead:.2f}s, audio starves {self.starves} ({int(self.starve_s * 1000)} ms)")

    def _speed_for(self, lead: float) -> float:
        if self._speed <= 1.0 or TTS_LEAD_LOW_S <= 0.0:
            return self._speed
        if lead >= TTS_LEAD_HIGH_S:
            return self._speed
        if lead <= TTS_LEAD_LOW_S:
            return 1.0
        return 1.0 + (self._speed - 1.0) * (lead - TTS_LEAD_LOW_S) / max(1e-6, TTS_LEAD_HIGH_S - TTS_LEAD_LOW_S)

    def _emit(self, out: np.ndarray, now: float) -> None:
        if len(out) == 0:
            return
        if self._released:
            self._pushed += len(out)
            self._push(_to_s16(out))
            return
        self._held.append(out)
        self._held_n += len(out)
        if self._held_n >= int(TTS_PREROLL_S * SAMPLE_RATE):
            self._release(now)

    def _release(self, now: float) -> None:
        self._released = True
        self._t_start = now
        for out in self._held:
            self._pushed += len(out)
            self._push(_to_s16(out))
        self._held = []
        self._held_n = 0


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

    @property
    def speed(self) -> float:
        return self._speed

    @speed.setter
    def speed(self, value: float) -> None:
        self._speed = max(1.0, min(2.0, float(value)))

    def _ws_url(self) -> str:
        return f"{self._url}/api/tts_streaming?voice={quote(self._voice, safe='')}&format=PcmMessagePack"

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> tts.ChunkedStream:
        return KyutaiChunkedStream(tts=self, input_text=text, conn_options=conn_options)

    def stream(self, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> tts.SynthesizeStream:
        return KyutaiSynthesizeStream(tts=self, conn_options=conn_options)

    async def render(self, text: str) -> np.ndarray:
        """Synthesize one line to float32 24 kHz PCM at speed 1.0 (for pre-rendered clips)."""
        words: asyncio.Queue[str | None] = asyncio.Queue()
        for w in text.split():
            words.put_nowait(w)
        words.put_nowait(None)
        chunks: list[np.ndarray] = []
        await self._speak(words, chunks.append)
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

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
        pacer = _Pacer(self._kyutai.speed, output_emitter.push)
        started = False
        t0 = time.monotonic()
        first = [True]
        last_word_at = 0.0
        text_gaps = 0

        def on_pcm(pcm: np.ndarray) -> None:
            if first[0]:
                first[0] = False
                log.info("kyutai tts: first audio %.2fs after first word", time.monotonic() - t0)
            pacer.feed(pcm)

        speak_task: asyncio.Task[None] | None = None
        try:
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
                    now = time.monotonic()
                    if last_word_at and now - last_word_at > TEXT_GAP_S:
                        text_gaps += 1   # the model paused mid-reply; the pre-roll is what covers this
                    last_word_at = now
                    self._mark_started()
                    words.put_nowait(w)
            if speak_task is not None:
                await speak_task
                pacer.finish()
                output_emitter.end_segment()
        finally:
            if started:
                log.info("kyutai tts: utterance %s, word gaps over %dms %d", pacer.summary(), int(TEXT_GAP_S * 1000), text_gaps)


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
        pacer = _Pacer(self._kyutai.speed, output_emitter.push)
        await self._kyutai._speak(words, pacer.feed)
        pacer.finish()


# ---------------------------------------------------------------- STT
class KyutaiSTT(stt.STT):
    """refine_url: the media sidecar's second pass (/v1/audio/refine): once the streaming model
    has ended an utterance, the same audio goes through Whisper for the text the brain receives
    and through SenseVoice for the "[tone: …]" note, which reaches on_tone before the final
    transcript is emitted. tone_url: the SenseVoice-only lookup used when refine is off (the
    note then arrives out of band, and the streamed words are the transcript)."""

    def __init__(self, *, url: str, api_key: str = "public_token", language: str = "en",
                 tone_url: str | None = None, refine_url: str | None = None, on_tone=None,
                 vad: lk_vad.VAD | None = None) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True, offline_recognize=False))
        self._url = url.rstrip("/")
        self._api_key = api_key
        self._language = language
        self._tone_url = tone_url
        self._refine_url = refine_url
        self._on_tone = on_tone
        self._vad = vad if GATE_WHILE_SPEAKING else None
        self.agent_speaking = False

    def set_agent_speaking(self, speaking: bool) -> None:
        """Told by the agent session; drives the listener gate of every open stream."""
        self.agent_speaking = speaking

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

    async def refine(self, pcm: np.ndarray) -> tuple[str | None, str | None, str | None]:
        """Second pass over one finished utterance: (text, note, SenseVoice's own reading);
        each is None when the sidecar has nothing (no Whisper loaded, neutral tone, notes hidden)."""
        if not self._refine_url or len(pcm) < SAMPLE_RATE // 4:
            return None, None, None
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=REFINE_TIMEOUT_S + 1.0)) as http:
            async with http.post(self._refine_url, data=self._wav_form(pcm)) as r:
                data = await r.json()
        text = str(data.get("text") or "").strip() or None
        note = str(data.get("note") or "").strip() or None
        other = str(data.get("sensevoice_text") or "").strip() or None
        return text, note, other


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
# Listener gate: while the agent speaks and the caller is silent, room audio is held (the last
# LEAD_IN seconds) instead of streamed, so the listening model takes no GPU steps during a
# reply. The local VAD reopens the stream the moment the caller starts, and the held audio is
# flushed first. GATE_TAIL_S keeps the stream open after the caller stops.
GATE_WHILE_SPEAKING = os.environ.get("KYUTAI_GATE_WHILE_SPEAKING", "1").strip() not in ("0", "false", "no", "")
GATE_TAIL_S = float(os.environ.get("KYUTAI_GATE_TAIL_S", "1.0"))
# Late words arrive in bursts: re-run the pass this long after the last of them.
REFINE_DEBOUNCE_S = float(os.environ.get("KYUTAI_REFINE_DEBOUNCE_S", "0.25"))


_WORD = re.compile(r"[a-z0-9']+")


def _similarity(a: str, b: str) -> float:
    """Jaccard overlap of the lowercase word sets (punctuation ignored)."""
    wa, wb = set(_WORD.findall(a.lower())), set(_WORD.findall(b.lower()))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _plausible(refined: str | None, streamed: str, second_opinion: str | None = None) -> bool:
    """Accept the second pass when it is non-empty, not wildly different in length from the
    streamed words, and agrees with at least one other reading of the same audio (the
    streamed words or SenseVoice's). A Whisper hallucination ("Thank you for listening to
    me." over an interrupted "Hello, can you hear me?") agrees with neither."""
    if not refined:
        return False
    ratio = len(refined.split()) / max(1, len(streamed.split()))
    if not 0.5 <= ratio <= 2.5:
        return False
    if _similarity(refined, streamed) >= 0.5:
        return True
    return bool(second_opinion) and _similarity(refined, second_opinion) >= 0.5


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
        self._spec: asyncio.Task[tuple[str | None, str | None, str | None]] | None = None   # second pass started at the pause
        self._spec_words = 0                 # how many words it covered
        self._spec_timer: asyncio.TimerHandle | None = None   # debounce for late-word re-runs
        self._delivery: asyncio.Task[None] | None = None   # finals are delivered in order
        self._input_done = False             # the framework closed the input: no reconnects after this
        self._gate_vad = stt._vad.stream() if stt._vad is not None else None
        self._held: list[np.ndarray] = []    # audio held back while gated (the last LEAD_IN seconds)
        self._held_samples = 0
        self._user_speaking = False          # the local VAD hears the caller
        self._open_until = 0.0               # keep streaming this long after the caller stops
        self._gated = False                  # for the log line on transitions
        self._held_total = 0                 # frames held this call (log)

    def _emit(self, kind: stt.SpeechEventType, text: str = "") -> None:
        ev = stt.SpeechEvent(type=kind, request_id="", alternatives=[stt.SpeechData(language=self._language, text=text)] if text or kind in (stt.SpeechEventType.INTERIM_TRANSCRIPT, stt.SpeechEventType.FINAL_TRANSCRIPT) else [])
        self._event_ch.send_nowait(ev)

    def _start_refine(self) -> asyncio.Task[tuple[str | None, str | None, str | None]]:
        audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
        return asyncio.get_running_loop().create_task(self._kyutai.refine(audio))

    def _respeculate(self) -> None:
        """Re-run the second pass over the utterance as it stands now (late words included)."""
        self._spec_timer = None
        if not self._words or self._pause_at is None:
            return
        if self._spec is not None:
            self._spec.cancel()
        self._spec = self._start_refine()
        self._spec_words = len(self._words)

    def _finalize(self, reason: str) -> None:
        if not self._words:
            return
        text = " ".join(self._words).strip()
        words = len(self._words)
        started = self._utterance_start
        audio = np.concatenate(self._audio) if self._audio else np.zeros(0, dtype=np.float32)
        if self._spec_timer is not None:
            self._spec_timer.cancel()
            self._spec_timer = None
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

    async def _deliver(self, previous: asyncio.Task[None] | None, text: str, pending: asyncio.Task[tuple[str | None, str | None, str | None]], reason: str, started: float) -> None:
        if previous is not None:
            await asyncio.wait({previous})
        t0 = time.monotonic()
        refined: str | None = None
        note: str | None = None
        other: str | None = None
        try:
            refined, note, other = await asyncio.wait_for(pending, REFINE_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("kyutai stt: second pass took over %.1fs; using the streamed words", REFINE_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            log.warning("kyutai stt: second pass failed (%s); using the streamed words", e)
        accepted = _plausible(refined, text, other)
        final = refined if accepted and refined else text
        detail = "" if final == text else f" (streamed: {text[:60]!r})"
        if refined and not accepted:
            detail = f" (rejected second pass: {refined[:60]!r}; sensevoice: {(other or '')[:60]!r})"
        log.info("kyutai stt: final (%s) %.1fs after first word, second pass waited %dms: %r%s",
                 reason, time.monotonic() - started, int((time.monotonic() - t0) * 1000), final[:80], detail)
        if note and self._kyutai._on_tone is not None:
            self._kyutai._on_tone(note)   # before the transcript, so the note rides on this turn
        self._emit(stt.SpeechEventType.FINAL_TRANSCRIPT, final)
        self._emit(stt.SpeechEventType.END_OF_SPEECH)

    async def _gate_events(self) -> None:
        assert self._gate_vad is not None
        async for ev in self._gate_vad:
            if ev.type == lk_vad.VADEventType.START_OF_SPEECH:
                self._user_speaking = True
            elif ev.type == lk_vad.VADEventType.END_OF_SPEECH:
                self._user_speaking = False
                self._open_until = time.monotonic() + GATE_TAIL_S

    async def _run(self) -> None:
        """One recognition stream for the life of the call: the socket to moshi-server is
        reopened after any drop, so the framework never sees a dead pump."""
        attempt = 0
        gate_task = asyncio.create_task(self._gate_events()) if self._gate_vad is not None else None
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
            if gate_task is not None:
                gate_task.cancel()
                await asyncio.gather(gate_task, return_exceptions=True)
                await self._gate_vad.aclose()
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
                    if self._speech_started:
                        self._audio.append(samples)
                    else:
                        self._lead.append(samples)
                        self._lead_samples += len(samples)
                        while self._lead and self._lead_samples - len(self._lead[0]) >= LEAD_IN_SAMPLES:
                            self._lead_samples -= len(self._lead.pop(0))
                    if self._gate_vad is not None:
                        self._gate_vad.push_frame(frame)
                        gated = (self._kyutai.agent_speaking and not self._user_speaking
                                 and time.monotonic() >= self._open_until)
                        if gated != self._gated:
                            self._gated = gated
                            if not gated:
                                log.info("kyutai stt: listener open (%d frames held)", self._held_total)
                                self._held_total = 0
                        if gated:
                            # Nothing sent: the server steps only on data. Keep the tail for the flush.
                            self._held.append(samples)
                            self._held_samples += len(samples)
                            self._held_total += 1
                            while self._held and self._held_samples - len(self._held[0]) >= LEAD_IN_SAMPLES:
                                self._held_samples -= len(self._held.pop(0))
                            continue
                        if self._held:
                            pending = np.concatenate([pending, *self._held])
                            self._held = []
                            self._held_samples = 0
                    pending = np.concatenate([pending, samples])
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
                        if self._pause_at is not None and self._kyutai._refine_url:
                            # Words after the pause (the model's emission lag) make the pass
                            # started at the pause stale; they come in a burst, so wait for the
                            # burst to end before re-running. The grace restarts from the last
                            # word, so the fresh pass still lands before the turn is finalized.
                            if self._spec_timer is not None:
                                self._spec_timer.cancel()
                            self._spec_timer = asyncio.get_running_loop().call_later(REFINE_DEBOUNCE_S, self._respeculate)
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
