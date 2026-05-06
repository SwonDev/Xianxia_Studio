"""Script generation via Ollama (xianxia-llm = supergemma4-e4b-abliterated, Gemma 4 family)."""

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
    model: str = "xianxia-llm"
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
    # `xianxia-llm` is the registered Ollama model created from the
    # supergemma4-e4b-abliterated GGUF (Gemma 4 family). The `experimental`
    # flag is a no-op kept for backwards compatibility — abliterated IS the
    # default, per project spec.
    model = req.model
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
    model: str = "xianxia-llm"


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

    # Defensive normalization. Gemma sometimes nests `tags` / `chapters`
    # *inside* the `description` dict instead of at the top level (despite
    # the schema in the prompt). Promote them back to the top level and
    # coerce description to the expected dict[str, str] shape so Pydantic
    # validation never explodes.
    description = parsed.get("description")
    if isinstance(description, dict):
        # Pop any non-language nested keys the model accidentally put here.
        for nested_key in ("tags", "chapters"):
            if nested_key in description and nested_key not in parsed:
                parsed[nested_key] = description.pop(nested_key)
        # Filter description to {lang: str} entries only — drop anything else.
        description = {
            k: v if isinstance(v, str) else str(v)
            for k, v in description.items()
            if isinstance(k, str)
        }
    elif isinstance(description, str):
        description = {"en": description}
    else:
        description = {}

    raw_tags = parsed.get("tags", [])
    if isinstance(raw_tags, str):
        # Some models return a comma-separated string instead of an array.
        raw_tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif not isinstance(raw_tags, list):
        raw_tags = []
    tags = [str(t) for t in raw_tags]

    raw_chapters = parsed.get("chapters", [])
    if not isinstance(raw_chapters, list):
        raw_chapters = []
    chapters = [c for c in raw_chapters if isinstance(c, dict)]

    return MetadataResponse(
        title_en=str(parsed.get("title_en", "") or ""),
        title_zh=parsed.get("title_zh") if isinstance(parsed.get("title_zh"), (str, type(None))) else None,
        description=description,
        tags=tags,
        chapters=chapters,
    )


# ─── Marker parsing ────────────────────────────────────────────────────────
# Accept both bracket form `[IMAGE: foo]` and markdown bold `**IMAGE: foo**` —
# small LLMs sometimes prefer the bold format over brackets.
MARKER_RE = re.compile(
    r"(?:\[(?P<kind1>IMAGE|MUSIC|CHAPTER):\s*(?P<body1>[^\]]+?)\])"
    r"|(?:\*\*(?P<kind2>IMAGE|MUSIC|CHAPTER):\s*(?P<body2>[^\*]+?)\*\*)",
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
        # Match either bracket or bold capture group
        kind = (match.group("kind1") or match.group("kind2") or "").lower()
        body = (match.group("body1") or match.group("body2") or "").strip()
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


# ─── Topic suggestions + Hook tester (LLM-driven idea generation) ────

class SuggestRequest(BaseModel):
    niche: str = "xianxia"
    count: int = 6
    model: str = "xianxia-llm"
    language: str = "en"


class TopicIdea(BaseModel):
    title: str
    hook: str
    estimated_minutes: int


class SuggestResponse(BaseModel):
    ideas: list[TopicIdea]


@router.post("/suggest", response_model=SuggestResponse)
async def suggest_topics(req: SuggestRequest) -> SuggestResponse:
    """LLM-driven topic generator. Returns N ideas with title + 1-line hook."""
    system = (
        f"You are a viral YouTube/TikTok content strategist for the {req.niche} niche "
        "(Chinese mythology, cultivation, wuxia, immortals). For each idea, output a "
        "killer title + a 1-sentence hook that grabs attention in <3 seconds. "
        "Output ONLY valid JSON: {\"ideas\": [{\"title\": \"...\", \"hook\": \"...\", "
        "\"estimated_minutes\": 8-15}, ...]}. No preamble, no explanation."
    )
    prompt = (
        f"Generate {req.count} fresh {req.niche} video ideas in {req.language}. "
        "Mix epic battles, cultivation breakthroughs, demon lore, immortal romance, "
        "ancient wisdom, and forbidden techniques. Avoid clichés. Be specific."
    )
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": req.model,
                    "system": system,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.85, "num_predict": 800, "num_ctx": 2048},
                },
            )
            r.raise_for_status()
            raw = r.json().get("response", "{}")
            data = json.loads(raw)
            ideas = []
            for item in (data.get("ideas") or [])[:req.count]:
                ideas.append(TopicIdea(
                    title=str(item.get("title", "")).strip(),
                    hook=str(item.get("hook", "")).strip(),
                    estimated_minutes=int(item.get("estimated_minutes") or 12),
                ))
            return SuggestResponse(ideas=ideas)
    except Exception as e:
        raise HTTPException(503, f"topic suggestion failed: {e}") from e


class HookTestRequest(BaseModel):
    topic: str
    count: int = 3
    model: str = "xianxia-llm"
    language: str = "en"


class Hook(BaseModel):
    text: str
    style: str  # "question" | "shock" | "promise"


class HookTestResponse(BaseModel):
    hooks: list[Hook]


@router.post("/hooks", response_model=HookTestResponse)
async def hook_tester(req: HookTestRequest) -> HookTestResponse:
    """A/B hook generation — produces N alternative opening hooks for a topic
    so the user can pick the highest-retention one before generating the full video.
    """
    system = (
        "You are a YouTube retention specialist. Given a topic, generate alternative "
        "opening hooks (≤15 words each) using three different psychological levers:\n"
        "  - question: provocative open-ended question\n"
        "  - shock:    surprising fact or counterintuitive claim\n"
        "  - promise:  bold value proposition for what they'll learn\n"
        f"Output ONLY JSON in {req.language}: {{\"hooks\": [{{\"text\": \"...\", "
        "\"style\": \"question|shock|promise\"}}, ...]}}"
    )
    prompt = f"Topic: {req.topic}\nGenerate {req.count} hooks, one of each style."
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": req.model, "system": system, "prompt": prompt,
                    "stream": False, "format": "json",
                    "options": {"temperature": 0.9, "num_predict": 400, "num_ctx": 1024},
                },
            )
            r.raise_for_status()
            data = json.loads(r.json().get("response", "{}"))
            hooks = [
                Hook(text=str(h.get("text", "")).strip(), style=str(h.get("style", "promise")))
                for h in (data.get("hooks") or [])[:req.count]
            ]
            return HookTestResponse(hooks=hooks)
    except Exception as e:
        raise HTTPException(503, f"hook test failed: {e}") from e
