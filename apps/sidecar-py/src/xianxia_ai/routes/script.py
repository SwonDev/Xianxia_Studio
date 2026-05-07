"""Script generation via Ollama (xianxia-llm = supergemma4-e4b-abliterated, Gemma 4 family)."""

from __future__ import annotations

import json
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..logging_utils import log_event
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
    # Headroom for: ~250 tokens prompt + ~{minutes}50 words narration + markers.
    # Without explicit num_ctx/num_predict Ollama defaults to num_ctx=2048,
    # which truncates 14-min scripts at ~9 minutes and produces only a handful
    # of [IMAGE: …] markers. Gemma 4 supports 32k context, so we generously
    # size the window and the predict budget so the model finishes the script.
    #   num_ctx    → 8192 covers prompt + 14-min narration + safety margin.
    #   num_predict→ 4096 lets the model emit ~3000 words + markers without
    #                hitting an early stop.
    log_event("info", "script_generate_start", topic=req.topic[:60], minutes=req.target_minutes, model=model)
    async with httpx.AsyncClient(timeout=900.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.85,
                    "top_p": 0.92,
                    "num_ctx": 8192,
                    "num_predict": 4096,
                },
            },
        )
        if resp.status_code != 200:
            log_event("error", "script_generate_failed", status=resp.status_code, body=resp.text[:200])
            raise HTTPException(status_code=502, detail=f"Ollama error: {resp.text}")
        data = resp.json()

    script = data.get("response", "")
    narration, markers = parse_markers(script)
    word_count = len(narration.split())
    # ~150 words per minute narration in English
    estimated_seconds = (word_count / 150.0) * 60.0

    image_markers = [m for m in markers if m.kind == "image"]
    # Density target: one image every ~12 s of narration so every line the
    # viewer hears is illustrated by a fresh visual. The Rust pipeline's
    # `normalise_beat_timeline` will then space these uniformly across the
    # actual TTS duration. Higher counts let the storytelling stay coherent
    # with the script — fewer images means the visuals drift away from
    # what's being narrated.
    expected_min = max(5, req.target_minutes * 5)
    log_event(
        "info",
        "script_generate_done",
        word_count=word_count,
        estimated_minutes=round(estimated_seconds / 60.0, 2),
        markers_total=len(markers),
        markers_image=len(image_markers),
        markers_image_expected_min=expected_min,
        truncated=word_count < req.target_minutes * 100,
    )
    # Safety net: if Gemma produced far fewer image markers than the script
    # length warrants, weave in evenly-spaced auto-markers whose prompt is
    # derived from the surrounding narration sentences.
    if len(image_markers) < expected_min:
        markers, _injected = _inject_auto_image_markers(
            narration=narration,
            existing=markers,
            target_count=expected_min,
        )
        image_markers = [m for m in markers if m.kind == "image"]
        log_event(
            "warning",
            "script_image_markers_autofilled",
            injected=_injected,
            total_after_fill=len(image_markers),
            target=expected_min,
        )

    # ─── Ground every image prompt in the actual narration ──────────────
    # Even when the LLM produces enough markers, its prompts tend to drift
    # towards generic xianxia tropes ("jade peaks, swirling qi, golden light")
    # that don't match what the narration is saying at that moment. Result:
    # 6 markers but all 6 images look the same and none illustrates the
    # sentence playing over them.
    #
    # We post-process EVERY image marker by:
    #   1. Lifting the actual narration sentences played during the next
    #      ~12-25 s after the marker (≈ 60-100 words at 150 wpm) and using
    #      them as the literal subject of the prompt — guarantees the
    #      image tells WHAT IS BEING NARRATED.
    #   2. Forcing a 6-way shot-type rotation (wide / action / closeup /
    #      character / object / architecture) so consecutive images never
    #      share the same composition. Stops the "person centered in
    #      mountains" loop.
    #   3. Rotating the colour palette so two adjacent images don't both
    #      default to jade-green.
    markers = _rewrite_image_prompts_from_narration(narration, markers)
    image_markers = [m for m in markers if m.kind == "image"]
    log_event(
        "info",
        "script_prompts_grounded_in_narration",
        markers_image=len(image_markers),
    )

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


_STYLE_SUFFIX = "cinematic, photorealistic, ultra detailed, dramatic lighting"
_SENTENCE_SPLIT = re.compile(r"(?<=[\.\!\?])\s+")


def _inject_auto_image_markers(
    narration: str,
    existing: list[Marker],
    target_count: int,
) -> tuple[list[Marker], int]:
    """Top up [IMAGE: …] markers when the LLM under-produced.

    Splits the narration into ``target_count`` equal word-windows, takes the
    first sentence of each window as the per-image prompt, appends a style
    suffix, and inserts a Marker at the corresponding timestamp. We never
    overwrite LLM-produced markers — we only fill the gaps.
    """
    words = narration.split()
    if not words:
        return existing, 0
    existing_image_ts = sorted(m.timestamp_seconds for m in existing if m.kind == "image")
    n_words = len(words)
    window = max(1, n_words // target_count)
    auto: list[Marker] = []
    next_seq = max((m.seq for m in existing), default=0) + 1
    min_gap_seconds = 8.0  # don't double up next to an LLM marker

    for i in range(target_count):
        start = i * window
        end = min(n_words, start + window)
        if start >= n_words:
            break
        ts = (start / 150.0) * 60.0
        # Skip if an LLM marker already lives within ±min_gap_seconds.
        if any(abs(ts - t) < min_gap_seconds for t in existing_image_ts):
            continue
        chunk = " ".join(words[start:end])
        sentences = _SENTENCE_SPLIT.split(chunk, maxsplit=1)
        first = sentences[0].strip().rstrip(",;:")
        # Cap length so Z-Image's CLIP tokenizer doesn't truncate at 77 tokens.
        if len(first) > 180:
            first = first[:180].rsplit(" ", 1)[0]
        if not first:
            continue
        prompt = f"{first}, {_STYLE_SUFFIX}"
        auto.append(Marker(seq=next_seq, kind="image", timestamp_seconds=ts, prompt=prompt))
        next_seq += 1

    if not auto:
        return existing, 0
    merged = sorted(existing + auto, key=lambda m: m.timestamp_seconds)
    for idx, m in enumerate(merged, start=1):
        m.seq = idx
    return merged, len(auto)


# ── Shot-type rotation: forces variety so the video doesn't show
#    "a person standing in front of mountains" every single time.
_SHOT_TYPES: list[tuple[str, str, str]] = [
    # (label, composition_hint, palette_hint)
    ("wide_landscape",  "establishing wide shot, landscape only, no people, vast scale",        "soft pastel mist tones"),
    ("character_shot",  "medium full-body shot of one figure, three-quarter angle, contextual setting", "warm earth and gold tones"),
    ("extreme_closeup", "extreme close-up, shallow depth of field, intimate detail",            "high-contrast moody lighting"),
    ("action_moment",   "dynamic action shot, motion blur, low angle, energy effects",          "vivid blue and crimson qi tones"),
    ("symbolic_object", "still-life of a single object, cinematic close-up, no people",         "candlelit chiaroscuro"),
    ("architecture",    "interior or architectural shot, dramatic perspective, no people",      "lantern-glow amber and shadow"),
]


def _rewrite_image_prompts_from_narration(narration: str, markers: list[Marker]) -> list[Marker]:
    """Replace each image prompt with one that literally describes the
    upcoming narration sentence, plus a forced shot-type rotation.

    Why: a small LLM (Gemma 4B abliterated) tends to repeat generic xianxia
    tropes regardless of what the narration is actually saying at that moment.
    By grounding the prompt in the post-marker text, every image illustrates
    the sentence the viewer will be hearing while it's on screen.

    The original LLM-authored prompt is not discarded outright — we keep
    it as a stylistic hint at the end of the new prompt so the model can
    inject xianxia atmosphere on top of the literal scene.
    """
    if not markers:
        return markers
    words = narration.split()
    n_words = len(words)
    if n_words == 0:
        return markers

    # Map each marker's timestamp to a word index (assumes the same
    # 150-wpm convention the parser uses upstream).
    rotation_index = 0
    out: list[Marker] = []
    for m in markers:
        if m.kind != "image":
            out.append(m)
            continue
        # Word index where this image's narration begins.
        word_at = int(m.timestamp_seconds * 150.0 / 60.0)
        word_at = max(0, min(word_at, n_words - 1))
        # Take the next ~70 words (≈ 28 s of narration at 150 wpm) as the
        # source text for the prompt; that's roughly the on-screen time
        # of one image in a uniformly-distributed timeline.
        window = " ".join(words[word_at: word_at + 70])
        sentences = _SENTENCE_SPLIT.split(window, maxsplit=2)
        # Use the first sentence (the line the viewer is hearing right
        # when this image cuts in). Fallback to the second if the first
        # is too short to be evocative.
        literal = sentences[0].strip()
        if len(literal) < 25 and len(sentences) > 1:
            literal = (sentences[0] + " " + sentences[1]).strip()
        literal = literal.rstrip(",;:")
        if len(literal) > 220:
            literal = literal[:220].rsplit(" ", 1)[0]
        if not literal:
            literal = (m.prompt or "").strip()
        # Pick the next shot type in the rotation. Two consecutive image
        # markers will always have DIFFERENT compositions.
        shot_label, shot_hint, palette_hint = _SHOT_TYPES[rotation_index % len(_SHOT_TYPES)]
        rotation_index += 1
        # Compose the final prompt: literal narrated subject + shot type
        # composition cue + palette cue + style suffix. The original
        # LLM-authored prompt is appended in low-weight position so the
        # model can still inject xianxia ambience.
        # Original LLM hint kept only when it adds NEW information not
        # already present in the narration excerpt. Avoids duplicating the
        # same sentence twice in the prompt (which Z-Image's CLIP encoder
        # treats as low signal and clamps off).
        original_hint = ""
        if m.prompt:
            o = m.prompt.strip()
            for tail in (
                ", cinematic, photorealistic, ultra detailed, dramatic lighting",
                "cinematic, photorealistic, ultra detailed, dramatic lighting",
                "cinematic, jade mountains, swirling qi, golden light",
            ):
                if o.lower().endswith(tail.lower()):
                    o = o[: -len(tail)].rstrip(", ")
            o_lower = o.lower()
            literal_lower = literal.lower()
            # Drop if original is a near-substring of the literal narration
            # (the narration already says it) or vice-versa.
            overlap_threshold = 0.6
            words_o = set(o_lower.split())
            words_l = set(literal_lower.split())
            shared = len(words_o & words_l)
            redundant = (
                shared / max(1, min(len(words_o), len(words_l))) >= overlap_threshold
                or o_lower in literal_lower
                or literal_lower in o_lower
            )
            if not redundant:
                if len(o) > 80:
                    o = o[:80].rsplit(" ", 1)[0]
                original_hint = f", {o}"
        prompt = (
            f"{literal}, {shot_hint}{original_hint}, {palette_hint}, "
            f"{_STYLE_SUFFIX}"
        )
        # Z-Image CLIP truncates at ~77 tokens (~300 chars worth).
        if len(prompt) > 320:
            prompt = prompt[:320].rsplit(" ", 1)[0]
        out.append(Marker(
            seq=m.seq,
            kind=m.kind,
            timestamp_seconds=m.timestamp_seconds,
            prompt=prompt,
        ))
    return out


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
