"""Hardware-accelerated video encoder selection.

Detects what FFmpeg can use locally — preferring GPU encoders when present —
and exposes:

  - codec_name: a string like "h264_nvenc" or "libx264"
  - moviepy_codec: same string, suitable for moviepy.write_videofile(codec=...)
  - ffmpeg_args: list of CLI flags ("-preset", "p5", ...) tuned per encoder
  - is_hw_accelerated: bool

Selection priority on a typical install:
  1. h264_nvenc      — NVIDIA RTX/GTX (separate hardware, no VRAM cost)
  2. h264_qsv        — Intel iGPU (Quick Sync)
  3. h264_amf        — AMD Radeon
  4. libx264         — CPU fallback (slowest, highest quality per bit)

Any TTS / image / scheduling work running on CUDA cores is unaffected by
NVENC because NVENC lives on a dedicated silicon block.
"""

from __future__ import annotations

import functools
import subprocess
from typing import NamedTuple


class EncoderProfile(NamedTuple):
    codec_name: str
    moviepy_codec: str
    ffmpeg_args: list[str]
    is_hw_accelerated: bool
    label: str


@functools.lru_cache(maxsize=1)
def available_hwaccels() -> set[str]:
    """Hardware accel methods FFmpeg can use for input decoding."""
    try:
        out = subprocess.check_output(
            ["ffmpeg", "-hide_banner", "-hwaccels"],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        )
    except Exception:
        return set()
    return {line.strip() for line in out.splitlines()
            if line.strip() and not line.startswith("Hardware")}


@functools.lru_cache(maxsize=1)
def _available_encoders() -> set[str]:
    """Return set of FFmpeg encoder names available on this machine."""
    try:
        out = subprocess.check_output(
            ["ffmpeg", "-hide_banner", "-encoders"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except Exception:
        return set()
    names: set[str] = set()
    for line in out.splitlines():
        # Format: " V....D h264_nvenc            NVIDIA NVENC H.264 encoder ..."
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0].startswith("V"):
            names.add(parts[1])
    return names


@functools.lru_cache(maxsize=1)
def best_video_encoder() -> EncoderProfile:
    """Pick the fastest available encoder for our ~1080p MP4 outputs."""
    enc = _available_encoders()

    # NVIDIA NVENC — RTX/GTX dedicated encoder block. p5 = balanced speed/quality.
    if "h264_nvenc" in enc:
        return EncoderProfile(
            codec_name="h264_nvenc",
            moviepy_codec="h264_nvenc",
            ffmpeg_args=[
                "-preset", "p5",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "20",
                "-b:v", "0",
                "-pix_fmt", "yuv420p",
            ],
            is_hw_accelerated=True,
            label="NVIDIA NVENC H.264 (GPU acelerado)",
        )

    # Intel Quick Sync (iGPU)
    if "h264_qsv" in enc:
        return EncoderProfile(
            codec_name="h264_qsv",
            moviepy_codec="h264_qsv",
            ffmpeg_args=[
                "-preset", "veryfast",
                "-global_quality", "20",
                "-pix_fmt", "yuv420p",
            ],
            is_hw_accelerated=True,
            label="Intel Quick Sync H.264 (iGPU)",
        )

    # AMD AMF
    if "h264_amf" in enc:
        return EncoderProfile(
            codec_name="h264_amf",
            moviepy_codec="h264_amf",
            ffmpeg_args=[
                "-quality", "balanced",
                "-rc", "cqp",
                "-qp_p", "20",
                "-pix_fmt", "yuv420p",
            ],
            is_hw_accelerated=True,
            label="AMD AMF H.264 (Radeon)",
        )

    # CPU fallback
    return EncoderProfile(
        codec_name="libx264",
        moviepy_codec="libx264",
        ffmpeg_args=["-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"],
        is_hw_accelerated=False,
        label="x264 software (CPU, sin aceleración GPU)",
    )
