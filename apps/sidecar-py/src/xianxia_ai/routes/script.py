"""Script generation via Ollama (Gemma 3 / supergemma4-abliterated)."""

from __future__ import annotations

import json
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..prompts import SCRIPT_PROMPT_TEMPLATE, METADATA_PROMPT_TEMPLATE

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"


class ScriptRequest(BaseModel):
    topic: str
    target_minutes: int = 14
    languages: list[str] = ["en"]
    model: str = "gemma3:4b"
    experimental: bool = False


class Marker(BaseModel):
    seq: int
    kind: str  # image | music | chapter
    timestamp_seconds: float
    prompt: str | None = None
    mood: str | None = None
    title: str | None = None


class ScriptResponse(BaseModel):
    script: str
    narration: str  # script with markers removed
    markers: list[Marker]
    word_count: int
    estimated_seconds: float


@router.post("", response_model=ScriptResponse)
async def generate_script(req: ScriptRequest) -> ScriptResponse:
    model = "xianxia-experimental" if req.experimental else req.model
    prompt = SCRIPT_PROMPT_TEMPLATE.format(
        topic=req.topic,
        minutes=req.target_minutes,
    )
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.85, "top_p": 0.92},
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Ollama error: {resp.text}")
        data = resp.json()

    script = data.get("response", "")
    narration, markers = parse_markers(script)
    word_count = len(narration.split())
    # ~150 words per minute narration in English
    estimated_seconds = (word_count / 150.0) * 60.0

    return ScriptResponse(
        script=script,
        narration=narration,
        markers=markers,
        word_count=word_count,
        estimated_seconds=estimated_seconds,
    )


class MetadataRequest(BaseModel):
    script: str
    languages: list[str] = ["en"]
    model: str = "gemma3:4b"


class MetadataResponse(BaseModel):
    title_en: str
    title_zh: str | None = None
    description: dict[str, str]  # lang -> text
    tags: list[str]
    chapters: list[dict]


@router.post("/metadata", response_model=MetadataResponse)
async def generate_metadata(req: MetadataRequest) -> MetadataResponse:
    prompt = METADATA_PROMPT_TEMPLATE.format(script=req.script[:8000])
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": req.model,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.6},
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Ollama error: {resp.text}")
        raw = resp.json().get("response", "{}")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {}
    return MetadataResponse(
        title_en=parsed.get("title_en", ""),
        title_zh=parsed.get("title_zh"),
        description=parsed.get("description", {}),
        tags=parsed.get("tags", []),
        chapters=parsed.get("chapters", []),
    )


# ─── Marker parsing ────────────────────────────────────────────────────────
MARKER_RE = re.compile(
    r"\[(?P<kind>IMAGE|MUSIC|CHAPTER):\s*(?P<body>.+?)\]",
    re.IGNORECASE,
)


def parse_markers(script: str) -> tuple[str, list[Marker]]:
    """Strip [IMAGE:], [MUSIC:], [CHAPTER:] markers and return narration + structured markers.

    Timestamps are estimated assuming 150 wpm narration up to each marker.
    """
    markers: list[Marker] = []
    narration_parts: list[str] = []
    last = 0
    seq = 0

    for match in MARKER_RE.finditer(script):
        # Text before marker
        chunk = script[last : match.start()]
        narration_parts.append(chunk)
        last = match.end()
        # Estimate timestamp from word count up to here
        words_before = len(" ".join(narration_parts).split())
        ts = (words_before / 150.0) * 60.0
        kind = match.group("kind").lower()
        body = match.group("body").strip()
        seq += 1
        if kind == "image":
            markers.append(Marker(seq=seq, kind="image", timestamp_seconds=ts, prompt=body))
        elif kind == "music":
            mood = body.split("=")[-1].strip() if "=" in body else body
            markers.append(Marker(seq=seq, kind="music", timestamp_seconds=ts, mood=mood))
        elif kind == "chapter":
            markers.append(Marker(seq=seq, kind="chapter", timestamp_seconds=ts, title=body))

    narration_parts.append(script[last:])
    narration = "".join(narration_parts).strip()
    narration = re.sub(r"\s{2,}", " ", narration)
    return narration, markers
