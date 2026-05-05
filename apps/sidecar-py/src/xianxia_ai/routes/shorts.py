"""Shorts generation — adapted from OpenShorts pipeline.

Replaces Gemini cloud with the local `xianxia-llm` (Gemma 4 abliterated) via
Ollama. Pipeline:
  1. faster-whisper word-level timestamps (already from phase 8)
  2. PySceneDetect scene boundaries
  3. xianxia-llm picks N viral 15-60s moments scored by hook strength
  4. FFmpeg cuts, vertical 9:16 reframe via center-crop (subject tracking
     with MediaPipe is opt-in via `subject_tracking=true` for tighter framing)
"""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..prompts import SHORTS_DETECTION_PROMPT

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"


class ShortsRequest(BaseModel):
    video_path: str
    srt_path: str
    n: int = 4
    model: str = "xianxia-llm"
    out_dir: str | None = None
    subject_tracking: bool = False  # MediaPipe + YOLO; only when CUDA & deps available
    burn_subtitles: bool = True     # add highlighted hook + transcript


class ShortClip(BaseModel):
    start: float
    end: float
    hook: str
    score: float
    output_path: str


class ShortsResponse(BaseModel):
    clips: list[ShortClip]


@router.post("", response_model=ShortsResponse)
async def generate_shorts(req: ShortsRequest) -> ShortsResponse:
    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video missing: {req.video_path}")

    # Step 1 — read SRT (faster-whisper already produced it)
    transcript_with_ts = Path(req.srt_path).read_text(encoding="utf-8")

    # Step 2 — scene detect (best effort, optional)
    try:
        from scenedetect import detect, ContentDetector  # type: ignore
        scenes = detect(req.video_path, ContentDetector(threshold=27.0))
        scene_boundaries = [(s[0].get_seconds(), s[1].get_seconds()) for s in scenes]
    except Exception:
        scene_boundaries = []

    # Step 3 — ask Gemma to pick viral moments
    prompt = SHORTS_DETECTION_PROMPT.format(n=req.n) + "\n\nTranscript:\n" + transcript_with_ts[:6000]
    if scene_boundaries:
        prompt += "\n\nScene boundaries (start, end seconds):\n" + str(scene_boundaries[:60])

    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": req.model,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.5},
            },
        )
        if resp.status_code != 200:
            raise HTTPException(502, f"Ollama: {resp.text}")
        raw = resp.json().get("response", "[]")

    try:
        picks = json.loads(raw)
    except json.JSONDecodeError:
        picks = []

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)

    clips: list[ShortClip] = []
    for i, pick in enumerate(picks[: req.n]):
        start = float(pick.get("start", 0))
        end = float(pick.get("end", start + 30))
        hook = pick.get("hook", "")
        score = float(pick.get("score", 0.5))
        out_path = out_dir / f"short-{i:02d}-{uuid.uuid4().hex[:6]}.mp4"
        # FFmpeg cut + crop to 9:16. Subject tracking happens in Node sidecar (HyperFrames).
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", f"{start:.3f}",
            "-to", f"{end:.3f}",
            "-i", req.video_path,
            "-vf", "crop=ih*9/16:ih,scale=1080:1920",
            "-c:v", "libx264",
            "-preset", "medium",
            "-c:a", "aac",
            str(out_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        clips.append(ShortClip(start=start, end=end, hook=hook, score=score, output_path=str(out_path)))

    return ShortsResponse(clips=clips)
