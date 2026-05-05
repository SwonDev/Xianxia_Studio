"""Music: choose from local Cultivation library or generate via MusicGen."""

from __future__ import annotations

import os
import random
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class MusicRequest(BaseModel):
    mood: str = "epic"
    duration_seconds: float = 60.0
    use_musicgen: bool = False
    library_dir: str | None = None
    out_dir: str | None = None


class MusicResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    source: str  # "library" | "musicgen"


@router.post("", response_model=MusicResponse)
def get_music(req: MusicRequest) -> MusicResponse:
    if req.use_musicgen:
        return _musicgen(req)

    library_dir = Path(req.library_dir or os.environ.get("XIANXIA_MUSIC_DIR", "./assets/music"))
    if not library_dir.exists():
        raise HTTPException(404, f"music library not found: {library_dir}")
    candidates = list(library_dir.glob("*.mp3"))
    if not candidates:
        raise HTTPException(404, "no music in library")
    track = random.choice(candidates)
    return MusicResponse(
        audio_path=str(track),
        duration_seconds=req.duration_seconds,
        source="library",
    )


def _musicgen(req: MusicRequest) -> MusicResponse:
    """Generate fresh ambient music via Meta's MusicGen — heavier path."""
    try:
        from audiocraft.models import MusicGen  # type: ignore
        import torch
        import scipy.io.wavfile as wavfile  # type: ignore
        import uuid
    except Exception as e:
        raise HTTPException(503, f"MusicGen not ready: {e}") from e

    model = MusicGen.get_pretrained("facebook/musicgen-medium")
    model.set_generation_params(duration=req.duration_seconds)
    prompt = mood_to_prompt(req.mood)
    wav = model.generate([prompt])[0]
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"music-{uuid.uuid4().hex[:10]}.wav"
    wavfile.write(str(out_path), 32000, wav.cpu().numpy().T)
    return MusicResponse(
        audio_path=str(out_path),
        duration_seconds=req.duration_seconds,
        source="musicgen",
    )


def mood_to_prompt(mood: str) -> str:
    return {
        "epic": "epic chinese cinematic orchestra, taiko drums, dizi flute, rising tension, qi cultivation",
        "serene": "tranquil guzheng, bamboo flute, mountain stream, meditative xianxia ambient",
        "mystic": "ethereal pads, distant temple bells, mysterious xianxia mood, qi flowing",
        "emotional": "solo erhu over piano, melancholy xianxia, slow heartfelt",
    }.get(mood, "ambient cinematic xianxia")
