"""Multi-platform export presets.

Re-encodes a master MP4 (1080x1920 @ 60fps recommended) into the dimensions /
bitrate / loudness profile each social platform actually wants in 2026.

Reference data sourced from official platform docs (YouTube, Instagram, TikTok,
Twitter/X, Facebook Reels) — May 2026 verified.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder

router = APIRouter()


# Width, height, fps, video bitrate, audio bitrate, audio rate, target LUFS,
# max duration (seconds), aspect_strategy ("none"|"crop"|"pad").
EXPORT_PRESETS: dict[str, dict] = {
    "youtube_shorts": {
        "size": (1080, 1920), "fps": 60, "vbr": "10M", "abr": "192k",
        "ar": 48000, "lufs": -14, "max_dur": 180, "aspect": "vertical",
        "label": "YouTube Shorts (1080x1920)",
    },
    "youtube_1080p": {
        "size": (1920, 1080), "fps": 60, "vbr": "12M", "abr": "384k",
        "ar": 48000, "lufs": -14, "max_dur": 43200, "aspect": "horizontal",
        "label": "YouTube 1080p (1920x1080)",
    },
    "youtube_4k": {
        "size": (3840, 2160), "fps": 60, "vbr": "68M", "abr": "384k",
        "ar": 48000, "lufs": -14, "max_dur": 43200, "aspect": "horizontal",
        "label": "YouTube 4K (3840x2160)",
    },
    "instagram_reels": {
        "size": (1080, 1920), "fps": 30, "vbr": "5M", "abr": "128k",
        "ar": 44100, "lufs": -12, "max_dur": 90, "aspect": "vertical",
        "label": "Instagram Reels (1080x1920)",
    },
    "instagram_4_5": {
        "size": (1080, 1350), "fps": 30, "vbr": "5M", "abr": "128k",
        "ar": 44100, "lufs": -14, "max_dur": 3600, "aspect": "feed_4_5",
        "label": "Instagram Feed 4:5 (1080x1350)",
    },
    "instagram_1_1": {
        "size": (1080, 1080), "fps": 30, "vbr": "5M", "abr": "128k",
        "ar": 44100, "lufs": -14, "max_dur": 3600, "aspect": "square",
        "label": "Instagram Feed 1:1 (1080x1080)",
    },
    "tiktok": {
        "size": (1080, 1920), "fps": 60, "vbr": "12M", "abr": "128k",
        "ar": 44100, "lufs": -10, "max_dur": 180, "aspect": "vertical",
        "label": "TikTok (1080x1920)",
    },
    "twitter_x": {
        "size": (1920, 1080), "fps": 30, "vbr": "10M", "abr": "128k",
        "ar": 48000, "lufs": -14, "max_dur": 140, "aspect": "horizontal",
        "label": "X / Twitter (1920x1080)",
    },
    "facebook_reels": {
        "size": (1080, 1920), "fps": 30, "vbr": "8M", "abr": "128k",
        "ar": 44100, "lufs": -14, "max_dur": 90, "aspect": "vertical",
        "label": "Facebook Reels (1080x1920)",
    },
}


class ExportRequest(BaseModel):
    video_path: str
    preset: str
    out_dir: str | None = None
    add_shorts_hashtag: bool = False  # not used in re-encode, returned for caller


class ExportResponse(BaseModel):
    output_path: str
    preset: str
    label: str
    width: int
    height: int
    fps: int
    duration_seconds: float
    size_bytes: int


class PresetInfo(BaseModel):
    id: str
    label: str
    width: int
    height: int
    fps: int
    vbr: str
    abr: str
    lufs: float
    max_dur: int


@router.get("/presets", response_model=list[PresetInfo])
async def list_presets() -> list[PresetInfo]:
    out: list[PresetInfo] = []
    for k, v in EXPORT_PRESETS.items():
        out.append(
            PresetInfo(
                id=k, label=v["label"],
                width=v["size"][0], height=v["size"][1], fps=v["fps"],
                vbr=v["vbr"], abr=v["abr"], lufs=float(v["lufs"]),
                max_dur=v["max_dur"],
            )
        )
    return out


def _aspect_filter(src_w: int, src_h: int, dst_w: int, dst_h: int, strategy: str) -> str:
    """Return the FFmpeg `-vf` chain to adapt source aspect to dst aspect."""
    if strategy == "vertical" or strategy == "horizontal":
        # Same orientation as source: simple scale + lanczos
        return f"scale={dst_w}:{dst_h}:flags=lanczos+full_chroma_int+accurate_rnd"
    if strategy == "square":
        return (
            f"crop=ih:ih,scale={dst_w}:{dst_h}:flags=lanczos+full_chroma_int+accurate_rnd"
        )
    if strategy == "feed_4_5":
        return (
            f"crop=ih*4/5:ih,scale={dst_w}:{dst_h}:flags=lanczos+full_chroma_int+accurate_rnd"
        )
    # Pad fallback: contain + letterbox
    return (
        f"scale={dst_w}:{dst_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={dst_w}:{dst_h}:(ow-iw)/2:(oh-ih)/2:black"
    )


@router.post("", response_model=ExportResponse)
def export(req: ExportRequest) -> ExportResponse:
    if req.preset not in EXPORT_PRESETS:
        raise HTTPException(400, f"unknown preset '{req.preset}'. Use /export/presets to list.")
    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video not found: {req.video_path}")

    p = EXPORT_PRESETS[req.preset]
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out")) / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{req.preset}-{uuid.uuid4().hex[:8]}.mp4"

    # Probe source dims for aspect adaptation.
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "default=nw=1:nk=1",
         req.video_path],
        capture_output=True, text=True,
    )
    src_lines = [l.strip() for l in probe.stdout.splitlines() if l.strip()]
    src_w = int(src_lines[0]) if len(src_lines) > 0 else p["size"][0]
    src_h = int(src_lines[1]) if len(src_lines) > 1 else p["size"][1]

    dst_w, dst_h = p["size"]
    vf = _aspect_filter(src_w, src_h, dst_w, dst_h, p["aspect"])

    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr",
            "-b:v", p["vbr"], "-maxrate", _maxrate(p["vbr"]),
            "-bufsize", _bufsize(p["vbr"]),
            "-spatial-aq", "1", "-temporal-aq", "1",
            "-bf", "4", "-rc-lookahead", "32", "-multipass", "fullres",
            "-pix_fmt", "yuv420p",
        ]
    else:
        encode_args = [
            "-preset", "slow", "-b:v", p["vbr"], "-maxrate", _maxrate(p["vbr"]),
            "-bufsize", _bufsize(p["vbr"]), "-pix_fmt", "yuv420p",
        ]

    af = f"loudnorm=I={p['lufs']}:TP=-1.5:LRA=11"

    cmd = [
        "ffmpeg", "-y",
        "-i", req.video_path,
        "-vf", vf,
        "-af", af,
        "-c:v", enc.codec_name,
        *encode_args,
        "-r", str(p["fps"]),
        "-g", str(p["fps"] * 2),
        "-c:a", "aac", "-b:a", p["abr"], "-ar", str(p["ar"]), "-ac", "2",
        "-t", str(p["max_dur"]),
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"export failed: {proc.stderr[-500:]}")

    # Probe output for response data.
    out_probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(out_path)],
        capture_output=True, text=True,
    )
    duration = float(out_probe.stdout.strip() or 0.0)

    return ExportResponse(
        output_path=str(out_path),
        preset=req.preset,
        label=p["label"],
        width=dst_w, height=dst_h, fps=p["fps"],
        duration_seconds=duration,
        size_bytes=out_path.stat().st_size,
    )


def _maxrate(vbr: str) -> str:
    n = float(vbr.rstrip("Mk"))
    return f"{int(n * 1.4)}M" if vbr.endswith("M") else f"{int(n * 1.4)}k"


def _bufsize(vbr: str) -> str:
    n = float(vbr.rstrip("Mk"))
    return f"{int(n * 2)}M" if vbr.endswith("M") else f"{int(n * 2)}k"
