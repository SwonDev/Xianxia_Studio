"""Text-to-speech via Qwen3-TTS (qwen-tts package)."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import tts_model

router = APIRouter()


class TTSRequest(BaseModel):
    text: str
    language: str = "English"  # English | Spanish | Chinese | …
    speaker: str = "Vivian"
    instruction: str | None = None
    chunk_chars: int = 600
    out_dir: str | None = None


class TTSResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    chunks: int


@router.post("", response_model=TTSResponse)
async def synthesize(req: TTSRequest) -> TTSResponse:
    try:
        model = tts_model.load()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"TTS model not ready: {e}") from e

    import numpy as np
    import soundfile as sf

    chunks = chunk_text(req.text, req.chunk_chars)
    audio_segments: list[np.ndarray] = []
    sr = 0
    for chunk in chunks:
        wav, sr_returned = model.generate_custom_voice(
            text=chunk,
            language=req.language,
            speaker=req.speaker,
            instruct=req.instruction or "Read in a calm cinematic narrator voice.",
        )
        audio_segments.append(wav[0])
        sr = sr_returned
    full = np.concatenate(audio_segments) if audio_segments else np.zeros(1)
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tts-{uuid.uuid4().hex[:10]}.wav"
    sf.write(str(out_path), full, sr)
    duration = float(len(full)) / float(sr) if sr else 0.0
    return TTSResponse(audio_path=str(out_path), duration_seconds=duration, chunks=len(chunks))


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Naive chunk-by-sentence respecting max_chars budget."""
    import re

    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        if len(cur) + len(s) + 1 > max_chars and cur:
            chunks.append(cur.strip())
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur.strip())
    return chunks
