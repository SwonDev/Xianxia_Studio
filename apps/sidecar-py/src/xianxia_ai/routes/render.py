"""Video render fallback via MoviePy. Primary path uses Node sidecar (HyperFrames).

GPU acceleration: when h264_nvenc / qsv / amf is available the encoder is
selected automatically by `xianxia_ai.codec.best_video_encoder()`. On the
reference RTX 4060 this drops a 4-min 1080p render from ~20 min (libx264) to
~1 min (NVENC), with zero VRAM cost (NVENC is dedicated silicon).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder

router = APIRouter()


class ImageBeat(BaseModel):
    image_path: str
    start_seconds: float
    duration_seconds: float


class RenderRequest(BaseModel):
    images: list[ImageBeat]
    narration_path: str
    music_path: str | None = None
    music_volume: float = 0.18  # -14 LUFS approx
    width: int = 1920
    height: int = 1080
    fps: int = 24
    out_dir: str | None = None


class RenderResponse(BaseModel):
    video_path: str
    duration_seconds: float


@router.post("", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    try:
        from moviepy import (  # type: ignore
            ImageClip,
            AudioFileClip,
            CompositeVideoClip,
            concatenate_videoclips,
            vfx,
            afx,
        )
    except Exception as e:
        raise HTTPException(503, f"MoviePy not ready: {e}") from e

    if not Path(req.narration_path).exists():
        raise HTTPException(404, f"narration audio missing: {req.narration_path}")

    clips = []
    for beat in req.images:
        clip = (
            ImageClip(beat.image_path, duration=beat.duration_seconds)
            .with_fps(req.fps)
            .resized(height=req.height)
        )
        # Ken Burns: gentle zoom
        clip = clip.with_effects([vfx.Resize(lambda t: 1 + 0.04 * t / beat.duration_seconds)])
        clips.append(clip)
    video = concatenate_videoclips(clips, method="compose").resized((req.width, req.height))

    narration = AudioFileClip(req.narration_path)
    audio_track = narration
    if req.music_path:
        music = AudioFileClip(req.music_path).with_effects([afx.MultiplyVolume(req.music_volume)])
        from moviepy import CompositeAudioClip  # type: ignore

        audio_track = CompositeAudioClip([narration, music])

    final = video.with_audio(audio_track)
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"video-{uuid.uuid4().hex[:10]}.mp4"

    enc = best_video_encoder()
    final.write_videofile(
        str(out_path),
        fps=req.fps,
        codec=enc.moviepy_codec,
        audio_codec="aac",
        threads=4,
        ffmpeg_params=enc.ffmpeg_args,
    )
    return RenderResponse(video_path=str(out_path), duration_seconds=final.duration)
