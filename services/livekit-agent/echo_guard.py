"""
echo_guard.py — acoustic self-echo guard for the voice worker (2026-09-20).

A hands-free caller (a laptop or a phone on its speaker) feeds Vesta's own voice back into
the microphone. The browser's echo canceller removes most of it, but what is left still drove
the VAD: the agent interrupted itself, and the words it then heard were its own, so the
harness answered its own replies. Two wrappers, installed on the session's audio chain after
`session.start()`:

  ReferenceTap  an AudioOutput wrapper: every frame the agent plays (replies, fillers, spoken
                questions) is copied into the EchoReference on a virtual playout clock before
                it goes on to the room.
  EchoGate      an AudioInput wrapper: each microphone frame is compared with what was playing
                a little earlier. A frame that is mostly Vesta's own voice is replaced by
                silence, so neither the VAD nor the recognizer hears it; a frame the caller
                dominates passes, so barge-in still works.

The comparison runs at 16 kHz on 240 ms windows. The echo lag (network plus the acoustic path,
a few hundred milliseconds in practice) is searched with an FFT correlation up to
ECHO_MAX_LAG_S and then tracked in a narrow window. Two verdicts say "echo": a high normalized
correlation with the reference, unless the least-squares residual (what the reference does not
frame keeps a residual well above the echo once the least-squares estimate of her voice is
subtracted — that is the caller talking over Vesta, and the cleaned frame passes; or a
microphone level no louder than the echo return seen so far, even when the correlation is weak
(the residual a canceller leaves, codec artefacts).
"""
from __future__ import annotations

import logging
import os
import time

import numpy as np
from livekit import rtc
from livekit.agents.voice.io import AudioInput, AudioOutput, AudioOutputCapabilities

log = logging.getLogger("vesta-voice.echo")

ENABLED = os.environ.get("ECHO_GUARD", "1").strip() not in ("0", "false", "no", "")
RATE = 16000
WINDOW_S = float(os.environ.get("ECHO_WINDOW_S", "0.24"))
MAX_LAG_S = float(os.environ.get("ECHO_MAX_LAG_S", "1.5"))
# Normalized correlation with the reference at which a window counts as echo, and the lower
# bound that keeps a window gated for HOLD_S after a confident verdict.
RHO_ON = float(os.environ.get("ECHO_RHO_ON", "0.45"))
RHO_HOLD = float(os.environ.get("ECHO_RHO_HOLD", "0.25"))
HOLD_S = float(os.environ.get("ECHO_HOLD_S", "0.3"))
# The guard is armed while the agent has played audio within this long.
TAIL_S = float(os.environ.get("ECHO_TAIL_S", "1.0"))
# Double talk: with her voice in the frame, what remains once the least-squares estimate of it
# is subtracted must exceed the estimate by this factor to count as the caller (the cleaned
# frame then passes). Codec and alignment errors alone leave about half the echo behind.
DOUBLE_TALK_RATIO = float(os.environ.get("ECHO_DOUBLE_TALK_RATIO", "1.5"))
# Residual echo without a correlation verdict: no louder than the echo return (the 30th
# percentile of the mic-to-reference ratio over confident, lag-locked echo frames) times this
# margin — a caller is louder than the echo, a canceller's leftovers are not.
LEVEL_MARGIN = float(os.environ.get("ECHO_LEVEL_MARGIN", "1.5"))
# A confident correlation for the lag vote (three agreeing votes lock the lag); the guard is
# inert until then, so a caller on earphones is never touched.
RHO_LOCK = float(os.environ.get("ECHO_RHO_LOCK", "0.6"))
LEVEL_WINDOWS = int(os.environ.get("ECHO_LEVEL_WINDOWS", "40"))   # ~2 s of 50 ms frames
FLOOR = float(os.environ.get("ECHO_FLOOR", "0.002"))               # mic rms below this is silence
LOCK_TOLERANCE_S = 0.03
NARROW_S = 0.16


def _pcm(frame: rtc.AudioFrame) -> np.ndarray:
    samples = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0
    if frame.num_channels > 1:
        samples = samples.reshape(-1, frame.num_channels).mean(axis=1)
    return samples


def _to_rate(samples: np.ndarray, rate: int) -> np.ndarray:
    if rate == RATE or len(samples) == 0:
        return samples
    n = max(1, int(round(len(samples) * RATE / rate)))
    x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


class EchoReference:
    """What the agent has played, on a virtual playout clock: a block pushed while the previous
    one is still playing starts when that one ends, otherwise now; the gaps between utterances
    are silence. `clear` cuts the future off (an interrupted reply never plays its queued tail)."""

    def __init__(self, seconds: float = 10.0) -> None:
        self._n = int(seconds * RATE)
        self._buf = np.zeros(self._n, dtype=np.float32)
        self._origin = time.monotonic()
        self._head = 0            # absolute sample index of the playout end
        self.last_push = 0.0

    def _index(self, t: float) -> int:
        return int((t - self._origin) * RATE)

    def head_time(self) -> float:
        return self._origin + self._head / RATE

    def push(self, samples: np.ndarray, now: float) -> None:
        if len(samples) == 0:
            return
        start = max(self._index(now), self._head)
        if start - self._head >= self._n:
            self._buf[:] = 0.0
        else:
            self._zero(self._head, start)
        self._write(start, samples)
        self._head = start + len(samples)
        self.last_push = now

    def clear(self, now: float) -> None:
        cut = self._index(now)
        if cut < self._head:
            self._zero(cut, self._head)
            self._head = cut

    def segment(self, t_end: float, length: int) -> np.ndarray:
        """`length` samples ending at wall-clock `t_end` (zeros beyond what was played)."""
        end = min(self._index(t_end), self._head)
        start = end - length
        out = np.zeros(length, dtype=np.float32)
        if end <= 0 or end - start <= 0:
            return out
        lo = max(start, self._head - self._n, 0)
        if lo >= end:
            return out
        idx = np.arange(lo, end) % self._n
        out[lo - start:] = self._buf[idx]
        return out

    def armed(self, now: float) -> bool:
        return self._head > 0 and now - self.head_time() < TAIL_S

    def _zero(self, a: int, b: int) -> None:
        if b <= a:
            return
        if b - a >= self._n:
            self._buf[:] = 0.0
            return
        idx = np.arange(a, b) % self._n
        self._buf[idx] = 0.0

    def _write(self, start: int, samples: np.ndarray) -> None:
        if len(samples) >= self._n:
            samples = samples[-self._n:]
            start = start + len(samples) - self._n
        idx = np.arange(start, start + len(samples)) % self._n
        self._buf[idx] = samples


class ReferenceTap(AudioOutput):
    """Copies everything the agent plays into the reference, then hands it on."""

    def __init__(self, *, next_in_chain: AudioOutput, reference: EchoReference) -> None:
        super().__init__(label="EchoReferenceTap", capabilities=AudioOutputCapabilities(pause=True),
                         next_in_chain=next_in_chain, sample_rate=next_in_chain.sample_rate)
        self._reference = reference

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await super().capture_frame(frame)
        self._reference.push(_to_rate(_pcm(frame), frame.sample_rate), time.monotonic())
        assert self.next_in_chain is not None
        await self.next_in_chain.capture_frame(frame)

    def flush(self) -> None:
        super().flush()
        assert self.next_in_chain is not None
        self.next_in_chain.flush()

    def clear_buffer(self) -> None:
        self._reference.clear(time.monotonic())
        assert self.next_in_chain is not None
        self.next_in_chain.clear_buffer()


class EchoGate(AudioInput):
    """Replaces microphone frames that are mostly Vesta's own voice with silence."""

    def __init__(self, *, source: AudioInput, reference: EchoReference) -> None:
        super().__init__(label="EchoGate", source=source)
        self._reference = reference
        self._window = int(WINDOW_S * RATE)
        self._max_lag = int(MAX_LAG_S * RATE)
        self._narrow = int(NARROW_S * RATE)
        self._mic = np.zeros(self._window, dtype=np.float32)
        self._lock: int | None = None          # locked lag in samples
        self._lag_votes: list[int] = []
        self._hold_until = 0.0
        self._ratios: list[float] = []         # mic/reference level ratios seen while armed
        self._lost_since: float | None = None
        # per armed stretch, for the log line
        self._stretch_started: float | None = None
        self._frames = 0
        self._gated = 0
        self._rho_max = 0.0
        self._lag_at_max = 0
        self._gain_db: float | None = None
        self._over = 0                          # frames the caller dominated while she played
        self._gated_corr = 0
        self._gated_level = 0

    async def __anext__(self) -> rtc.AudioFrame:
        frame = await super().__anext__()
        if not ENABLED:
            return frame
        try:
            return self._process(frame)
        except Exception as e:  # noqa: BLE001 — the guard must never take the call down
            log.warning("echo guard error (%s); frame passed", e)
            return frame

    def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
        now = time.monotonic()
        pcm = _to_rate(_pcm(frame), frame.sample_rate)
        self._mic = np.concatenate([self._mic, pcm])[-self._window:]
        if not self._reference.armed(now):
            self._finish_stretch(now)
            return frame
        if self._stretch_started is None:
            self._stretch_started = now
            self._frames = self._gated = self._over = self._gated_corr = self._gated_level = 0
            self._rho_max = 0.0
        self._frames += 1
        x = self._mic
        rms_x = _rms(x)
        if rms_x < FLOOR:
            return frame
        rho, lag, best = self._correlate(x, now)
        if best is None:
            return frame
        r = best
        rms_r = _rms(r)
        if rms_r < 1e-4:
            return frame
        gain = float(np.dot(x, r) / max(1e-9, np.dot(r, r)))   # least-squares echo gain at the best lag
        if rho > self._rho_max:
            self._rho_max, self._lag_at_max = rho, lag
        if rho >= RHO_LOCK:
            self._vote(lag, now)
        if rho >= RHO_ON:
            self._hold_until = now + HOLD_S
            self._gain_db = 20.0 * np.log10(max(1e-6, abs(gain)))
            if self._lock is not None:
                self._ratios.append(rms_x / rms_r)
                if len(self._ratios) > LEVEL_WINDOWS:
                    self._ratios.pop(0)
        correlated = rho >= RHO_ON or (rho >= RHO_HOLD and now < self._hold_until)
        if correlated:
            # Her voice is in this frame. Take the estimate out and look at what is left: a
            # caller talking over her leaves a residual well above the echo itself, and gets
            # the cleaned frame; anything else is her, and gets silence.
            r_frame = self._reference.segment(now - lag / RATE, len(pcm))
            residual = pcm - gain * r_frame
            echo_est = abs(gain) * _rms(r_frame)
            if _rms(residual) > max(FLOOR, DOUBLE_TALK_RATIO * echo_est):
                self._over += 1
                return self._cleaned(frame, gain, r_frame)
            echo = True
            self._gated_corr += 1
        else:
            # No correlated echo. A canceller's residual is weakly correlated but never louder
            # than the echo return seen so far; the caller is. Only with a locked lag: until
            # then nothing is known about this call's echo path.
            level_floor = float(np.percentile(self._ratios, 30)) if self._lock is not None and len(self._ratios) >= 6 else None
            echo = level_floor is not None and rms_x <= LEVEL_MARGIN * level_floor * rms_r
            if echo:
                self._gated_level += 1
        if echo:
            self._gated += 1
            return rtc.AudioFrame.create(frame.sample_rate, frame.num_channels, frame.samples_per_channel)   # zeros
        return frame

    def _cleaned(self, frame: rtc.AudioFrame, gain: float, r_frame: np.ndarray) -> rtc.AudioFrame:
        """The frame with the estimated echo subtracted (mono frames only; others pass as they are)."""
        if frame.num_channels != 1:
            return frame
        native = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0
        if frame.sample_rate != RATE:
            x_old = np.linspace(0.0, 1.0, num=len(r_frame), endpoint=False)
            x_new = np.linspace(0.0, 1.0, num=len(native), endpoint=False)
            r_native = np.interp(x_new, x_old, r_frame).astype(np.float32)
        else:
            r_native = r_frame
        clean = np.clip(native - gain * r_native, -1.0, 1.0)
        return rtc.AudioFrame(data=(clean * 32767.0).astype("<i2").tobytes(), sample_rate=frame.sample_rate,
                              num_channels=1, samples_per_channel=len(clean))

    def _correlate(self, x: np.ndarray, now: float) -> tuple[float, int, np.ndarray | None]:
        """Best normalized correlation of the mic window against the reference over the lag
        window: (rho, lag in samples, the reference window at that lag)."""
        w = self._window
        if self._lock is not None:
            span = self._narrow
            t_end = now - self._lock / RATE + span / RATE
            length = w + 2 * span
        else:
            span = self._max_lag
            t_end = now
            length = w + span
        r = self._reference.segment(t_end, length)
        if not np.any(r):
            return 0.0, 0, None
        n = 1
        while n < length + w:
            n <<= 1
        corr = np.fft.irfft(np.fft.rfft(r, n) * np.conj(np.fft.rfft(x, n)), n)[:length - w + 1]
        sq = np.concatenate([[0.0], np.cumsum(r.astype(np.float64) ** 2)])
        energy = sq[w:] - sq[:-w]                  # energy of each reference window r[k:k+w]
        norm = np.sqrt(np.maximum(energy, 1e-9) * max(1e-9, float(np.dot(x, x))))
        rho_all = corr / norm
        rho_all[energy < 1e-6] = 0.0
        k = int(np.argmax(rho_all))
        rho = float(rho_all[k])
        # r spans [t_end - length, t_end]; window k ends at offset k + w; the mic window ends at now
        lag = int(round((now - t_end) * RATE)) + (length - (k + w))
        if self._lock is not None and rho < RHO_HOLD:
            if self._lost_since is None:
                self._lost_since = now
            elif now - self._lost_since > 2.0:
                log.info("echo guard: lag lock lost, searching again")
                self._lock = None
                self._lag_votes = []
                self._lost_since = None
        else:
            self._lost_since = None
        return rho, lag, r[k:k + w]

    def _vote(self, lag: int, now: float) -> None:
        if self._lock is not None:
            return
        self._lag_votes.append(lag)
        self._lag_votes = self._lag_votes[-3:]
        if len(self._lag_votes) == 3 and max(self._lag_votes) - min(self._lag_votes) <= LOCK_TOLERANCE_S * RATE:
            self._lock = int(np.median(self._lag_votes))
            log.info("echo guard: lag locked at %d ms", int(self._lock * 1000 / RATE))

    def _finish_stretch(self, now: float) -> None:
        if self._stretch_started is None:
            return
        if self._frames:
            log.info("echo guard: %.1fs of playback: gated %d of %d frames (%d%%; %d by correlation, %d by level), caller over her %d, rho max %.2f at %d ms, echo return %s, lag %s",
                     now - self._stretch_started, self._gated, self._frames, int(100 * self._gated / self._frames), self._gated_corr, self._gated_level, self._over,
                     self._rho_max, int(self._lag_at_max * 1000 / RATE),
                     f"{self._gain_db:.0f} dB" if self._gain_db is not None else "n/a",
                     f"locked {int(self._lock * 1000 / RATE)} ms" if self._lock is not None else "unlocked")
        self._stretch_started = None
        self._ratios = []


def install(session, reference: EchoReference | None = None) -> EchoReference | None:
    """Wrap the session's audio input and output; call after session.start()."""
    if not ENABLED:
        log.info("echo guard disabled (ECHO_GUARD=0)")
        return None
    reference = reference or EchoReference()
    sink = session.output.audio
    source = session.input.audio
    if sink is None or source is None:
        log.warning("echo guard not installed: audio %s missing", "output" if sink is None else "input")
        return None
    session.output.audio = ReferenceTap(next_in_chain=sink, reference=reference)
    session.input.audio = EchoGate(source=source, reference=reference)
    log.info("echo guard installed (window %d ms, lag up to %d ms, rho %.2f/%.2f, level margin x%.1f)",
             int(WINDOW_S * 1000), int(MAX_LAG_S * 1000), RHO_ON, RHO_HOLD, LEVEL_MARGIN)
    return reference
