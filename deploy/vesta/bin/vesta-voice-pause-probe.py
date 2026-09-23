"""Build one utterance with a drawn-out word mid-sentence: half1 + (last word of half1 stretched) + half2."""
import sys, wave, numpy as np
from audiotsm import wsola
from audiotsm.io.array import ArrayReader, ArrayWriter
SR = 24000
def read(p):
    with wave.open(p, 'rb') as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
def write(p, a):
    with wave.open(p, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
a, b = read(sys.argv[1]), read(sys.argv[2])
a = a[int(0.5 * SR):len(a) - SR]; b = b[int(0.5 * SR):len(b) - SR]      # say.py pads 0.5 s lead, 1 s tail
stretch = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0
gap = float(sys.argv[5]) if len(sys.argv) > 5 else 0.08   # silence after the drawn-out word; keep it under the VAD's 0.55 s
idx = np.flatnonzero(np.abs(a) > 0.02); end = int(idx[-1])
seg_len = int(0.45 * SR); seg = a[max(0, end - seg_len):end]
reader = ArrayReader(seg.reshape(1, -1)); writer = ArrayWriter(1)
wsola(1, speed=1.0 / stretch).run(reader, writer)
long = writer.data.reshape(-1).astype(np.float32)
fade = int(0.02 * SR); long[:fade] *= np.linspace(0, 1, fade); long[-fade:] *= np.linspace(1, 0, fade)
out = np.concatenate([np.zeros(int(0.5 * SR), np.float32), a[:end - seg_len], long, np.zeros(int(gap * SR), np.float32), b, np.zeros(int(1.5 * SR), np.float32)])
write(sys.argv[3], out)
print(f"{sys.argv[3]}: {len(out)/SR:.1f}s total; stretched the last {seg_len/SR:.2f}s of half 1 by x{stretch} into {len(long)/SR:.1f}s, then {gap:.2f}s of silence")
