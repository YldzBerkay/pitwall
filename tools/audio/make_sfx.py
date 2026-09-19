#!/usr/bin/env python3
"""
Synthesise Pit Wall's garage sound effects.

Generates the upgrade/repair SFX the Development screen plays, so the app
ships real audio without pulling in licensed sample packs.

  python3 make_sfx.py ../../mobile/assets/sfx
"""
import math
import os
import struct
import sys
import wave

import numpy as np

RATE = 44100


def write_wav(path, samples, rate=RATE):
    """Write mono 16-bit PCM, normalised with a little headroom."""
    peak = np.max(np.abs(samples))
    if peak > 0:
        samples = samples / peak * 0.89
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm.tobytes())
    print(f"  {os.path.basename(path)}  {len(samples) / rate:.2f}s")


def envelope(n, attack, decay, sustain_level=0.0):
    """Simple AD envelope in samples."""
    env = np.zeros(n)
    a = max(1, int(attack * RATE))
    d = max(1, int(decay * RATE))
    a = min(a, n)
    env[:a] = np.linspace(0, 1, a)
    rest = n - a
    if rest > 0:
        d = min(d, rest)
        env[a:a + d] = np.linspace(1, sustain_level, d)
        if a + d < n:
            env[a + d:] = sustain_level
    return env


def band_noise(n, low, high, rate=RATE):
    """Noise shaped by a crude FFT band-pass — metallic without a DSP dep."""
    noise = np.random.default_rng(7).standard_normal(n)
    spectrum = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1 / rate)
    mask = np.exp(-((freqs - (low + high) / 2) ** 2) / (2 * ((high - low) / 2.2) ** 2))
    return np.fft.irfft(spectrum * mask, n)


def metal_ring(n, freq, decay, detune=1.006):
    """Two close partials beating against each other — struck-metal timbre."""
    t = np.arange(n) / RATE
    body = (np.sin(2 * math.pi * freq * t)
            + 0.6 * np.sin(2 * math.pi * freq * detune * t)
            + 0.35 * np.sin(2 * math.pi * freq * 2.76 * t))
    return body * np.exp(-t / decay)


def impact_wrench(duration=1.15, hits=17):
    """
    The pit-lane rattle gun: a fast train of metallic impacts over a whining
    motor that spins up then falls away.
    """
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    out = np.zeros(n)

    # Motor whine, rising then dropping as the gun loads up.
    spin = np.interp(t, [0, 0.18, 0.75, duration], [0.0, 1.0, 0.92, 0.0])
    whine_f = np.interp(t, [0, 0.18, 0.75, duration], [180, 620, 560, 200])
    phase = 2 * math.pi * np.cumsum(whine_f) / RATE
    out += 0.16 * spin * (np.sin(phase) + 0.4 * np.sin(2 * phase))

    # Impact train — tightly spaced, slightly uneven so it does not sound looped.
    rng = np.random.default_rng(3)
    start, end = 0.13, duration - 0.16
    for i in range(hits):
        frac = i / max(1, hits - 1)
        at = start + (end - start) * frac + rng.uniform(-0.004, 0.004)
        idx = int(at * RATE)
        hit_n = min(int(0.075 * RATE), n - idx)
        if hit_n <= 0:
            continue
        loud = 0.55 + 0.45 * math.sin(math.pi * frac)  # swell in the middle
        click = band_noise(hit_n, 1800, 6200) * envelope(hit_n, 0.0006, 0.030)
        ring = metal_ring(hit_n, rng.uniform(1450, 1850), 0.024) * 0.55
        out[idx:idx + hit_n] += loud * (click * 0.9 + ring)

    # Air hiss under the whole thing.
    out += 0.05 * band_noise(n, 3000, 9000) * spin
    return out * envelope(n, 0.004, duration)


def part_fitted(duration=0.85):
    """A solid clunk of a part seating, then a short confirming two-note rise."""
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    out = np.zeros(n)

    # Clunk: low thud + metal ring.
    clunk_n = int(0.30 * RATE)
    tc = np.arange(clunk_n) / RATE
    out[:clunk_n] += 0.9 * np.sin(2 * math.pi * 84 * tc) * np.exp(-tc / 0.055)
    out[:clunk_n] += 0.5 * metal_ring(clunk_n, 520, 0.10)
    out[:clunk_n] += 0.35 * band_noise(clunk_n, 700, 3200) * envelope(clunk_n, 0.001, 0.05)

    # Confirmation: perfect fifth up, soft and short.
    for offset, freq in ((0.30, 784.0), (0.44, 1174.7)):
        idx = int(offset * RATE)
        tone_n = min(int(0.36 * RATE), n - idx)
        if tone_n <= 0:
            continue
        tt = np.arange(tone_n) / RATE
        tone = (np.sin(2 * math.pi * freq * tt)
                + 0.30 * np.sin(2 * math.pi * freq * 2 * tt)
                + 0.12 * np.sin(2 * math.pi * freq * 3 * tt))
        out[idx:idx + tone_n] += 0.34 * tone * np.exp(-tt / 0.13)

    return out * envelope(n, 0.002, duration)


def spark_weld(duration=0.55):
    """Welding-torch crackle for the visual spark burst."""
    n = int(duration * RATE)
    rng = np.random.default_rng(11)
    out = 0.5 * band_noise(n, 2500, 11000)
    # Random crackle transients on top of the hiss.
    for _ in range(38):
        idx = rng.integers(0, n - 400)
        crack_n = int(rng.integers(90, 380))
        out[idx:idx + crack_n] += rng.uniform(0.4, 1.0) * (
            band_noise(crack_n, 3500, 12000) * envelope(crack_n, 0.0004, 0.006))
    shape = np.interp(np.arange(n) / RATE, [0, 0.05, 0.35, duration], [0, 1, 0.7, 0])
    return out * shape


def upgrade_denied(duration=0.42):
    """Dull, dry buzz for 'not enough RP'."""
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    tone = np.sign(np.sin(2 * math.pi * 132 * t)) * 0.35   # square-ish buzz
    tone += 0.3 * np.sin(2 * math.pi * 98 * t)
    gate = (np.sin(2 * math.pi * 26 * t) > 0).astype(float)  # stutter
    return tone * gate * envelope(n, 0.003, duration)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    print(f"writing SFX -> {out_dir}")
    write_wav(os.path.join(out_dir, "wrench.wav"), impact_wrench())
    write_wav(os.path.join(out_dir, "part-fitted.wav"), part_fitted())
    write_wav(os.path.join(out_dir, "spark.wav"), spark_weld())
    write_wav(os.path.join(out_dir, "denied.wav"), upgrade_denied())


if __name__ == "__main__":
    main()
