"""Audio transcription via faster-whisper."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import whisper_model

router = APIRouter()


class TranscribeRequest(BaseModel):
    audio_path: str
    language: str = "en"
    out_dir: str | None = None
    word_timestamps: bool = True


class TranscribeResponse(BaseModel):
    srt_path: str
    text: str
    duration_seconds: float
    segment_count: int


@router.post("", response_model=TranscribeResponse)
def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    try:
        model = whisper_model.load()
    except Exception as e:
        raise HTTPException(503, f"Whisper not ready: {e}") from e

    if not Path(req.audio_path).exists():
        raise HTTPException(404, f"audio not found: {req.audio_path}")

    segments, info = model.transcribe(
        req.audio_path,
        language=req.language,
        word_timestamps=req.word_timestamps,
        beam_size=5,
    )
    segments = list(segments)

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    srt_path = out_dir / f"subs-{req.language}-{uuid.uuid4().hex[:10]}.srt"

    full_text: list[str] = []
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, start=1):
            f.write(f"{i}\n")
            f.write(f"{srt_ts(seg.start)} --> {srt_ts(seg.end)}\n")
            f.write(f"{seg.text.strip()}\n\n")
            full_text.append(seg.text.strip())

    return TranscribeResponse(
        srt_path=str(srt_path),
        text=" ".join(full_text),
        duration_seconds=float(info.duration),
        segment_count=len(segments),
    )


def srt_ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
