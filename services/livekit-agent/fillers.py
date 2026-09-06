"""
Filler lines: short things Vesta says in her own voice while she thinks or works, the way a
voice assistant fills a silence ("Hmm.", "Let me check.", "Still on it."). The lines live in
a YAML file (deploy/vesta/fillers.yaml, mounted at FILLERS_FILE), grouped by when they play:

  thinking       the reply's first words are late (FILLER_THINK_AFTER_S after the turn ended)
  working        the first tool call of a turn
  still_working  every DSH_PROGRESS_INTERVAL_S of silent tool work
  acknowledge    reserved (a spoken "stop" already answers in text)

Each line is rendered once per voice through the streaming TTS and kept as a WAV under
FILLERS_DIR/<voice key>/ (a host volume), so a restart costs nothing and a new line in the
file renders at the next worker start. Clips are played from memory, already stretched to
TTS_SPEED, and never through the GPU.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import threading
import time
import wave
from collections import deque
from typing import AsyncIterator, Callable

import numpy as np
import yaml
from livekit import rtc

log = logging.getLogger("vesta-voice.fillers")

SAMPLE_RATE = 24000
FILLERS = os.environ.get("FILLERS", "1").strip() not in ("0", "false", "no", "")
FILLERS_FILE = os.environ.get("FILLERS_FILE", "/app/fillers.yaml")
FILLERS_DIR = os.environ.get("FILLERS_DIR", "/app/fillers")
# Clips longer than these are never played (a long filler would hold the real answer back).
FILLER_MAX_S = float(os.environ.get("FILLER_MAX_S", "1.3"))
FILLER_THINK_MAX_S = float(os.environ.get("FILLER_THINK_MAX_S", "0.9"))
FRAME_MS = 20
CATEGORIES = ("thinking", "working", "still_working", "acknowledge")


def _clip_name(phrase: str) -> str:
    return hashlib.sha1(phrase.strip().encode("utf-8")).hexdigest()[:16] + ".wav"


def _read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def _write_wav(path: str, pcm: np.ndarray) -> None:
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    os.replace(tmp, path)


def _trim(pcm: np.ndarray, threshold: float = 0.01, keep_s: float = 0.08) -> np.ndarray:
    """Cut the silence the TTS leaves around a line, keeping a short edge on each side."""
    loud = np.flatnonzero(np.abs(pcm) > threshold)
    if len(loud) == 0:
        return pcm
    keep = int(keep_s * SAMPLE_RATE)
    return pcm[max(0, loud[0] - keep): min(len(pcm), loud[-1] + keep)]


class FillerLibrary:
    def __init__(self, phrases: dict[str, list[str]], cache_dir: str, stretch: Callable[[np.ndarray], np.ndarray]) -> None:
        self._phrases = {c: [p for p in phrases.get(c, []) if p and p.strip()] for c in CATEGORIES}
        self._dir = cache_dir
        self._stretch = stretch
        self._clips: dict[str, np.ndarray] = {}
        self._recent: dict[str, deque[str]] = {c: deque(maxlen=3) for c in CATEGORIES}

    @classmethod
    def from_file(cls, path: str, voice_key: str, stretch: Callable[[np.ndarray], np.ndarray]) -> "FillerLibrary":
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        phrases = {c: [str(p) for p in (data.get(c) or [])] for c in CATEGORIES}
        return cls(phrases, os.path.join(FILLERS_DIR, voice_key), stretch)

    @property
    def phrases(self) -> dict[str, list[str]]:
        return self._phrases

    def _path(self, phrase: str) -> str:
        return os.path.join(self._dir, _clip_name(phrase))

    def missing(self) -> list[str]:
        return [p for ps in self._phrases.values() for p in ps if not os.path.exists(self._path(p))]

    def load(self) -> int:
        """Read every rendered clip into memory, stretched to the playback speed."""
        loaded = 0
        for ps in self._phrases.values():
            for p in ps:
                path = self._path(p)
                if p in self._clips or not os.path.exists(path):
                    continue
                try:
                    self._clips[p] = self._stretch(_trim(_read_wav(path)))
                    loaded += 1
                except Exception as e:  # noqa: BLE001
                    log.warning("filler clip unreadable, re-rendered next start: %s (%s)", path, e)
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
        return loaded

    async def render(self, tts) -> int:
        """Render the missing lines through the TTS (one at a time) into the cache dir."""
        os.makedirs(self._dir, exist_ok=True)
        rendered = 0
        for phrase in self.missing():
            t0 = time.monotonic()
            pcm = await tts.render(phrase)
            if len(pcm) < SAMPLE_RATE // 10:
                log.warning("filler %r rendered empty; skipped", phrase)
                continue
            _write_wav(self._path(phrase), pcm)
            rendered += 1
            log.info("filler rendered %r: %.1fs of audio in %.1fs", phrase, len(pcm) / SAMPLE_RATE, time.monotonic() - t0)
        return rendered

    def render_blocking(self, tts, timeout_s: float = 120.0) -> int:
        """render() from synchronous code (the worker's prewarm hook), on its own event loop."""
        result: list[int] = []
        errors: list[BaseException] = []

        def run() -> None:
            try:
                result.append(asyncio.run(self.render(tts)))
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        thread = threading.Thread(target=run, name="filler-render", daemon=True)
        thread.start()
        thread.join(timeout_s)
        if thread.is_alive():
            log.warning("filler rendering still running after %.0fs; the rest renders next start", timeout_s)
            return 0
        if errors:
            log.warning("filler rendering failed (%s); clips render next start", errors[0])
            return 0
        return result[0] if result else 0

    def pick(self, category: str) -> tuple[str, np.ndarray] | None:
        """A rendered line of the category, not one of the last three used."""
        limit = FILLER_THINK_MAX_S if category == "thinking" else FILLER_MAX_S
        ready = [p for p in self._phrases.get(category, []) if p in self._clips and len(self._clips[p]) / SAMPLE_RATE <= limit]
        if not ready:
            return None
        fresh = [p for p in ready if p not in self._recent[category]] or ready
        phrase = random.choice(fresh)
        self._recent[category].append(phrase)
        return phrase, self._clips[phrase]

    @staticmethod
    async def frames(pcm: np.ndarray) -> AsyncIterator[rtc.AudioFrame]:
        """The clip as 20 ms frames, for session.say(audio=...)."""
        step = SAMPLE_RATE * FRAME_MS // 1000
        data = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2")
        for i in range(0, len(data), step):
            chunk = data[i:i + step]
            yield rtc.AudioFrame(data=chunk.tobytes(), sample_rate=SAMPLE_RATE, num_channels=1, samples_per_channel=len(chunk))
