"""Script generation via the active LLM backend (Ollama or llama.cpp).

The default GGUF is `xianxia-llm` (= supergemma4-e4b-abliterated, Gemma 4
family). On Ollama it's registered as a named model; on llama.cpp the same
GGUF is loaded directly by llama-server. The `model` field on each request
is therefore an *alias* — the backend resolves it to whatever weights the
user picked in Settings → LLM Model Browser.
"""

from __future__ import annotations

import json
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..llm import generate as llm_generate
from ..logging_utils import log_event
from ..chapters import chapter_count_for, parse_outline
from ..prompts import (
    SCRIPT_PROMPT_TEMPLATE,
    METADATA_PROMPT_TEMPLATE,
    OUTLINE_PROMPT_TEMPLATE,
    CHAPTER_PROMPT_TEMPLATE,
    SUMMARY_PROMPT_TEMPLATE,
    build_script_prompt,
)
from ..presets import get_preset, IMAGE_STYLE_BIAS

router = APIRouter()

# Kept for legacy imports (parity-check, tooling). All new code MUST route
# through `llm_generate(...)` → `llm_backend.get_backend()` instead of
# touching this URL directly.
OLLAMA_URL = "http://127.0.0.1:11434"


class ScriptRequest(BaseModel):
    topic: str
    target_minutes: int = 14
    languages: list[str] = ["en"]
    model: str = "xianxia-llm"
    experimental: bool = False
    # v0.7.0 — Tipo de vídeo. Default "narrative_epic" → byte-identical
    # behaviour to v0.6.x for any client that omits the field.
    preset_id: str = "narrative_epic"


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
    # v0.1.38: expose the LLM-generated setting tag so the supervisor
    # can pass it down to /music as a style_hint (era + culture + palette).
    setting_tag: str | None = None


class OutlineRequest(BaseModel):
    topic: str
    target_minutes: int
    language: str = "es"
    model: str = "xianxia-llm"
    context_facts: str = ""
    # v0.7.0 — surfaced for parity with /script. The outline template
    # itself is unchanged in v0.7.0; the preset is recorded and passed
    # through so downstream phases (script/chapter/image/music/tts)
    # can read it. v0.7.x can add per-preset outline structure later.
    preset_id: str = "narrative_epic"


class OutlineResponse(BaseModel):
    chapters: list[dict]


@router.post("/outline", response_model=OutlineResponse)
async def generate_outline(req: OutlineRequest) -> OutlineResponse:
    language_name = _LANG_TO_NAME.get(req.language, "English")
    n = chapter_count_for(req.target_minutes)
    prompt = OUTLINE_PROMPT_TEMPLATE.format(
        topic=req.topic,
        minutes=req.target_minutes,
        language_name=language_name,
        n_chapters=n,
        context_facts=req.context_facts or "(write from general knowledge, stay faithful to the topic)",
    )
    system_prompt = (
        f"YOU MUST WRITE THE ENTIRE OUTLINE IN {language_name.upper()}. "
        f"No exceptions."
    )
    log_event("info", "outline_start", topic=req.topic[:60], chapters=n)
    async with httpx.AsyncClient(timeout=900.0) as client:
        for attempt in (1, 2):
            try:
                result = await llm_generate(
                    model=req.model,
                    system=system_prompt,
                    prompt=prompt,
                    options={
                        "temperature": 0.4,
                        "top_p": 0.9,
                        "num_ctx": 8192,
                        "num_predict": 1800,
                    },
                    think=False,
                    max_continuations=0,
                    client=client,
                    timeout=900.0,
                )
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
            raw = result.get("response") or ""
            try:
                chapters = parse_outline(raw)
                log_event("info", "outline_ok", chapters=len(chapters), attempt=attempt)
                return OutlineResponse(chapters=chapters)
            except ValueError as e:
                log_event("warn", "outline_parse_failed", attempt=attempt, error=str(e)[:160])
    raise HTTPException(status_code=422, detail="outline could not be parsed after 2 attempts")


# ── /chapter ────────────────────────────────────────────────────────────────

class ChapterRequest(BaseModel):
    topic: str
    language: str = "es"
    outline: list[dict]
    chapter_index: int          # 1-based
    running_summary: str = ""
    is_final: bool = False
    model: str = "xianxia-llm"


class ChapterResponse(BaseModel):
    text: str
    running_summary: str
    words: int


def _outline_block(outline: list[dict]) -> str:
    return "\n".join(
        f'{c.get("index")}. {c.get("title", "")} — {c.get("synopsis", "")}' for c in outline
    )


@router.post("/chapter", response_model=ChapterResponse)
async def generate_chapter(req: ChapterRequest) -> ChapterResponse:
    language_name = _LANG_TO_NAME.get(req.language, "English")
    ch = next((c for c in req.outline if c.get("index") == req.chapter_index), None)
    if ch is None:
        raise HTTPException(status_code=422, detail="chapter_index not in outline")
    final_clause = (
        "This IS the final chapter: after the beats, deliver a narrative "
        f"resolution that echoes the opening, then a short {language_name} "
        "audience CTA (like, share, subscribe, thanks)."
        if req.is_final else
        "This is NOT the final chapter: keep building, do not close."
    )
    prompt = CHAPTER_PROMPT_TEMPLATE.format(
        topic=req.topic,
        language_name=language_name,
        outline_block=_outline_block(req.outline),
        running_summary=req.running_summary or "(this is the first chapter)",
        chapter_index=req.chapter_index,
        chapter_title=ch.get("title", ""),
        chapter_synopsis=ch.get("synopsis", ""),
        chapter_beats="; ".join(ch.get("beats", [])) or "(use your judgement)",
        target_words=ch.get("target_words", 0) or 350,
        final_clause=final_clause,
    )
    system_prompt = (
        f"YOU MUST WRITE THE ENTIRE NARRATION IN {language_name.upper()}. "
        f"Marker bodies (IMAGE, MUSIC, CHAPTER) stay in English; narration "
        f"prose is in {language_name}. No exceptions."
    )
    log_event(
        "info", "chapter_start",
        topic=req.topic[:60], chapter=req.chapter_index, is_final=req.is_final,
    )
    async with httpx.AsyncClient(timeout=900.0) as client:
        try:
            result = await llm_generate(
                model=req.model,
                system=system_prompt,
                prompt=prompt,
                options={
                    "temperature": 0.85,
                    "top_p": 0.92,
                    "num_ctx": 16384,
                    "num_predict": 4096,
                },
                think=False,
                max_continuations=0,
                client=client,
                timeout=900.0,
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
        chapter_text = (result.get("response") or "").strip()
        if "[CHAPTER:" not in chapter_text:
            chapter_text = f'[CHAPTER: {ch.get("title", "")}]\n' + chapter_text

        summary_prompt = SUMMARY_PROMPT_TEMPLATE.format(
            chapter_index=req.chapter_index,
            running_summary=req.running_summary or "(nothing yet)",
            new_chapter=chapter_text[-4000:],
        )
        try:
            s = await llm_generate(
                model=req.model,
                system=None,
                prompt=summary_prompt,
                options={
                    "temperature": 0.3,
                    "num_ctx": 8192,
                    "num_predict": 700,
                },
                think=False,
                max_continuations=0,
                client=client,
                timeout=900.0,
            )
            new_summary = (s.get("response") or "").strip()
        except httpx.HTTPError:
            new_summary = req.running_summary  # graceful: keep previous
    log_event(
        "info", "chapter_done",
        chapter=req.chapter_index, words=len(chapter_text.split()), has_summary=bool(new_summary),
    )
    return ChapterResponse(
        text=chapter_text,
        running_summary=new_summary or req.running_summary,
        words=len(chapter_text.split()),
    )


_LANG_TO_NAME = {
    "en": "English",
    "es": "Spanish",
    "zh": "Simplified Chinese",
    "zh-CN": "Simplified Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "it": "Italian",
    "pt": "Portuguese",
    "pt-BR": "Brazilian Portuguese",
    "ru": "Russian",
    "ar": "Arabic",
}


@router.post("", response_model=ScriptResponse)
async def generate_script(req: ScriptRequest) -> ScriptResponse:
    # `xianxia-llm` is the registered Ollama model created from the
    # supergemma4-e4b-abliterated GGUF (Gemma 4 family). The `experimental`
    # flag is a no-op kept for backwards compatibility — abliterated IS the
    # default, per project spec.
    #
    # `languages[0]` drives the narration language. Earlier versions hard-coded
    # English in the prompt template, so even when the UI selected Spanish the
    # TTS ended up reading English text with a Spanish voice (jarring
    # pronunciation). We now substitute {language_name} into the prompt and
    # ask the model explicitly to write the script in that language.
    model = req.model
    lang_tag = (req.languages or ["en"])[0]
    language_name = _LANG_TO_NAME.get(lang_tag, "English")

    # v0.1.37+v0.1.38: TWO-PASS narrative grounding.
    #   Pass 1 — gather rich Wikipedia brief (multi-page, full extracts).
    #   Pass 2 — ask the LLM to DISTIL that brief into a bullet list of
    #            verifiable specific facts (names, dates, places, quotes).
    # The bullet list is what we inject as `context_facts` into the main
    # script prompt, so Gemma writes about real events instead of vague
    # poetic abstractions ("symbol of responsibility, eternal hero").
    raw_brief = await _gather_topic_facts(req.topic, lang_tag)
    distilled_facts = ""
    if raw_brief:
        distilled_facts = await _extract_key_facts(
            req.topic, raw_brief, language_name, model=model,
        )
    # Final context block: prefer the distilled bullet list (best signal)
    # but always also include the raw brief as supporting context. If
    # neither exists, fall back to a "no external sources" note.
    if distilled_facts and raw_brief:
        context_facts = (
            "KEY FACTS (use these as your narrative skeleton — "
            "cite names, dates, places, quotes verbatim):\n"
            f"{distilled_facts}\n\n"
            "RAW REFERENCE (additional supporting context):\n"
            f"{raw_brief}"
        )
    elif raw_brief:
        context_facts = f"REFERENCE TEXT:\n{raw_brief}"
    else:
        context_facts = (
            "(no external sources available — write from general knowledge "
            "but stay strictly faithful to the topic and avoid inventing "
            "specific names, dates or quotes)"
        )

    # v0.7.0 — preset-aware system prompt. For narrative_epic this is
    # byte-identical to the v0.6.x SCRIPT_PROMPT_TEMPLATE.format(...)
    # call (the helper short-circuits to the legacy template for that
    # preset). Other presets get the dynamically-assembled template
    # with their llm_style_directive substituted into the STORY BEATS
    # slot.
    prompt = build_script_prompt(
        req.preset_id,
        topic=req.topic,
        minutes=req.target_minutes,
        language_name=language_name,
        context_facts=context_facts,
    )
    # Headroom for: ~250 tokens prompt + ~{minutes}50 words narration + markers.
    # Without explicit num_ctx/num_predict Ollama defaults to num_ctx=2048,
    # which truncates 14-min scripts at ~9 minutes and produces only a handful
    # of [IMAGE: …] markers. Gemma 4 supports 32k context, so we generously
    # size the window and the predict budget so the model finishes the script.
    #   num_ctx    → 8192 covers prompt + 14-min narration + safety margin.
    #   num_predict→ 4096 lets the model emit ~3000 words + markers without
    #                hitting an early stop.
    log_event(
        "info", "script_generate_start",
        topic=req.topic[:60], minutes=req.target_minutes,
        model=model, language=language_name,
    )
    # Gemma 4 4B abliterated tends to default back to English even when the
    # body of the prompt requests another language. We override the system
    # role with a non-negotiable single-sentence instruction in capitals so
    # the model commits to the requested language from token 0.
    system_prompt = (
        f"YOU MUST WRITE THE ENTIRE NARRATION IN {language_name.upper()}. "
        f"Marker bodies (IMAGE, MUSIC, CHAPTER) stay in English; narration "
        f"prose is in {language_name}. No exceptions."
    )
    # v0.1.38 — adaptive budget. Gemma 4B reliably produces ~600-900 words
    # per single call regardless of how big you set num_predict. For long-
    # form (8+ minute videos targeting YouTube monetisation) we generate in
    # PASSES: a first call drafts the opening + setup + part of the body,
    # then up to 2 continuation calls extend the narration until we hit
    # the word target. Each continuation receives the partial script as
    # context and is told to KEEP WRITING from where the previous output
    # left off, in the same {language_name}, then deliver the closing CTA
    # only on the FINAL pass.
    target_words = max(180, req.target_minutes * 150)  # 150 wpm spoken pace
    min_acceptable_words = int(target_words * 0.85)
    multi_pass = req.target_minutes >= 7
    num_ctx = 16384 if multi_pass else 8192
    num_predict_first = 4096 if multi_pass else 3072

    async def _llm_generate_pass(client: httpx.AsyncClient, the_prompt: str, np: int) -> str:
        try:
            result = await llm_generate(
                model=model,
                system=system_prompt,
                prompt=the_prompt,
                options={
                    "temperature": 0.85,
                    "top_p": 0.92,
                    "num_ctx": num_ctx,
                    "num_predict": np,
                },
                think=False,
                max_continuations=0,
                client=client,
                timeout=900.0,
            )
        except httpx.HTTPError as e:
            log_event("error", "script_generate_failed", error=str(e)[:200])
            raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
        return (result.get("response") or "")

    async with httpx.AsyncClient(timeout=900.0) as client:
        script = await _llm_generate_pass(client, prompt, num_predict_first)
        word_count_so_far = len(script.split())
        log_event(
            "info", "script_pass_1_done",
            words=word_count_so_far, target_words=target_words,
            multi_pass=multi_pass,
        )

        # Continuation passes — only when target_minutes is long-form AND
        # the first pass undershot. Each call uses a CONTINUATION prompt
        # that injects the trailing 1200 chars of the current script as
        # context so the model picks up the same voice, facts and pacing
        # without restarting. Gemma 4B reliably adds ~200-400 words per
        # call, so we budget enough passes to reach the word target:
        #   target_minutes 7-8  → 2 continuations
        #   target_minutes 9-12 → 4 continuations
        #   target_minutes 13+  → 6 continuations
        max_continuations = (
            6 if req.target_minutes >= 13 else
            4 if req.target_minutes >= 9 else
            2 if multi_pass else 0
        )
        cont_idx = 0
        while (
            multi_pass
            and cont_idx < max_continuations
            and word_count_so_far < min_acceptable_words
        ):
            cont_idx += 1
            # Final pass = the one where we tell the LLM to deliver the
            # rounded closing + CTA. Trigger on the LAST scheduled pass
            # OR as soon as we've hit 90 % of target (don't drag it out).
            is_final = (
                cont_idx == max_continuations
                or word_count_so_far >= int(target_words * 0.90)
            )
            tail = script[-1200:]
            continuation_instruction = (
                f"You previously wrote the following script in {language_name}. "
                f"Keep writing — pick up EXACTLY where it left off. Stay in "
                f"{language_name}, stay strictly on topic ({req.topic}), keep the "
                f"narrative beats moving forward (NEVER repeat what you already wrote). "
                f"Continue inserting [IMAGE: ...] markers every 25-40 words and a "
                f"[CHAPTER: ...] marker when a new beat starts.\n\n"
                f"Word target so far: {word_count_so_far}. Aim to add at least "
                f"{max(300, target_words - word_count_so_far)} more words "
                f"of new prose."
            )
            if is_final:
                continuation_instruction += (
                    "\n\nThis is the FINAL pass. After advancing the narrative, "
                    "deliver the two-part closing: (1) narrative resolution that "
                    "echoes the opening hook, (2) audience CTA in "
                    f"{language_name} (like, share, subscribe, thanks). Do NOT "
                    "stop before delivering both."
                )
            else:
                continuation_instruction += (
                    "\n\nThis is NOT the final pass. Do NOT deliver the closing "
                    "yet — keep building toward the reveal. There will be one "
                    "more continuation after this."
                )
            cont_prompt = (
                f"{continuation_instruction}\n\n"
                f"PREVIOUS OUTPUT (continue immediately after this — do not "
                f"include it in your reply):\n---\n{tail}\n---\n\n"
                f"Continue now in {language_name}:"
            )
            extension = await _llm_generate_pass(client, cont_prompt, 4096)
            extension = extension.strip()
            # Defensive: if the model echoed the tail, drop the duplicate prefix.
            if extension.startswith(tail[-200:].strip()[:80]):
                extension = extension[80:]
            if extension:
                # Insert a single space-newline between segments so parse_markers
                # doesn't merge sentences across the boundary.
                separator = "\n\n" if not script.endswith("\n") else ""
                script = script + separator + extension
            word_count_so_far = len(script.split())
            log_event(
                "info", f"script_continuation_{cont_idx}_done",
                added_words=len(extension.split()),
                total_words=word_count_so_far,
                is_final_pass=is_final,
            )
            if is_final:
                break

    return await _finalize_script(
        script, req.topic, language_name, req.target_minutes, model,
        raw_brief or distilled_facts,
        preset_id=req.preset_id,
    )


async def _finalize_script(
    script: str,
    topic: str,
    language_name: str,
    target_minutes: int,
    model: str,
    context_brief: str = "",
    *,
    preset_id: str = "narrative_epic",
) -> ScriptResponse:
    """Shared post-processing block for both /script and /script/postprocess.

    Accepts the raw assembled script text plus the minimal context needed to
    run every post-processing step (setting_tag, image-prompt grounding,
    auto-marker injection, subject diversification) and returns the fully
    processed ScriptResponse.  The short path (/script) is byte-identical to
    its previous behaviour — this is a pure extract-method refactor.
    """
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
    expected_min = max(5, target_minutes * 5)
    log_event(
        "info",
        "script_generate_done",
        word_count=word_count,
        estimated_minutes=round(estimated_seconds / 60.0, 2),
        markers_total=len(markers),
        markers_image=len(image_markers),
        markers_image_expected_min=expected_min,
        truncated=word_count < target_minutes * 100,
    )
    # Safety net: if Gemma produced far fewer image markers than the script
    # length warrants, weave in evenly-spaced auto-markers whose prompt is
    # derived from the surrounding narration sentences.
    # v0.1.38: ask the LLM ONCE for a topic-specific setting tag, using
    # the same Wikipedia brief that grounds the script. The brief gives
    # Gemma the topic's actual era + culture + iconography facts, so
    # whatever topic the user types — Atlantis, Pygmies, deep space,
    # Renaissance — the setting tag matches THAT world. No hardcoded
    # culture list, no examples of other topics that could bleed in.
    setting_tag = await _generate_setting_tag(
        topic, model=model, context_brief=context_brief,
    )

    # v0.7.0 — resolve the image-style suffix once from the preset.
    # narrative_epic → IMAGE_STYLE_BIAS["cinematic"] which is BYTE-IDENTICAL
    # to the legacy _STYLE_SUFFIX (asserted by parity invariant). Other
    # presets get their own bias ("documentary", "editorial_illustrative"…)
    # which biases Z-Image away from cinematic-photoreal.
    _preset_resolved = get_preset(preset_id)
    style_suffix = IMAGE_STYLE_BIAS.get(_preset_resolved.image_style, _STYLE_SUFFIX)

    if len(image_markers) < expected_min:
        markers, _injected = _inject_auto_image_markers(
            narration=narration,
            existing=markers,
            target_count=expected_min,
            topic=topic,
            setting_tag=setting_tag,
            style_suffix=style_suffix,
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
    # toward whatever aesthetic the model was last trained on, regardless of
    # the user's topic. Without grounding, an "Egyptian gods" video could
    # end up with a Chinese dragon shot or a Roman empire video with sci-fi
    # imagery. Result: markers exist but the images don't illustrate the
    # actual sentence — and worse, they betray the topic itself.
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
    markers = await _rewrite_image_prompts_from_narration(
        narration, markers,
        topic=topic,
        setting_tag=setting_tag,
        context_brief=context_brief,
        language_name=language_name,
        model=model,
        style_suffix=style_suffix,
    )
    # v0.1.42: post-process sanity check — flag (but don't fail) the
    # script when the LLM has drifted into a fictional adaptation of
    # the topic. We only log a warning so downstream still gets a
    # video; the prompt template should have already prevented this,
    # but the metric lets us track regression rate.
    adaptation_hits = _ADAPTATION_LEAK_PATTERNS.findall(narration)
    if adaptation_hits:
        log_event(
            "warning", "narration_adaptation_leak_detected",
            topic=topic,
            hits=len(adaptation_hits),
            samples=list({h.lower() for h in adaptation_hits})[:6],
        )
    # v0.1.35: observational pass to detect when consecutive image markers
    # share too many content nouns (sign that the LLM is repeating the
    # same subject in every shot, e.g. "all images are T-Rex" for Jurassic
    # Park). Logs a warning so we can measure how often the new diversity
    # rule is violated.
    markers = _diversify_subjects(markers)
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
        setting_tag=setting_tag or None,
    )


class PostprocessRequest(BaseModel):
    script: str
    topic: str
    languages: list[str] = ["es"]
    target_minutes: int
    model: str = "xianxia-llm"
    # v0.7.0 — preset propagated through the finaliser so the image
    # style suffix matches what /script used for this preset.
    preset_id: str = "narrative_epic"


@router.post("/postprocess", response_model=ScriptResponse)
async def postprocess_script(req: PostprocessRequest) -> ScriptResponse:
    language_name = _LANG_TO_NAME.get((req.languages or ["en"])[0], "English")
    return await _finalize_script(
        req.script, req.topic, language_name, req.target_minutes,
        req.model, "",
        preset_id=req.preset_id,
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
        try:
            result = await llm_generate(
                model=req.model,
                prompt=prompt,
                format="json",
                options={"temperature": 0.6},
                think=False,
                max_continuations=0,
                client=client,
                timeout=300.0,
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
        raw = result.get("response") or "{}"
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


# v0.1.35: 12 topic-agnostic palettes that rotate per image so consecutive
# frames don't share dominant tones. NOT culture-specific — the setting tag
# from the LLM already carries the cultural palette; this layer only adds
# lighting/mood variation so visuals don't feel monotonous.
def _extract_subject_keywords(prompt: str) -> set[str]:
    """Extract content nouns (≥4 chars) from a prompt to detect repeated
    primary subjects across consecutive images. Strips style/composition
    boilerplate that's identical across all prompts (cinematic, detailed,
    photorealistic, etc.) so what's left is the actual SCENE content.
    """
    boilerplate = {
        "cinematic", "photorealistic", "detailed", "dramatic", "lighting",
        "composition", "shot", "angle", "view", "scene", "image", "frame",
        "ultra", "high", "quality", "scale", "wide", "medium", "extreme",
        "close", "closeup", "subject", "focus", "field", "shallow", "depth",
        "warm", "cool", "soft", "hard", "tones", "tone", "palette", "light",
        "setting", "iconography", "period", "correct", "faithful", "topic",
        "moody", "atmospheric", "establishing",
    }
    words = re.findall(r"[a-zA-Z]{4,}", prompt.lower())
    return {w for w in words if w not in boilerplate}


def _diversify_subjects(markers: list[Marker]) -> list[Marker]:
    """v0.1.35: log a warning when consecutive image markers share too
    many content nouns — that's the LLM repeating the same subject.
    For now we only LOG it (so we can measure how often the new prompt
    rule is violated); future versions can mutate the prompt or re-ask
    the LLM. Keeping it observational first to avoid breaking variety
    that would otherwise be fine.
    """
    image_markers = [m for m in markers if m.kind == "image"]
    if len(image_markers) < 2:
        return markers
    repeat_warnings = 0
    for i in range(1, len(image_markers)):
        prev_kw = _extract_subject_keywords(image_markers[i - 1].prompt or "")
        curr_kw = _extract_subject_keywords(image_markers[i].prompt or "")
        if not prev_kw or not curr_kw:
            continue
        overlap = len(prev_kw & curr_kw)
        smaller = min(len(prev_kw), len(curr_kw))
        if smaller > 0 and overlap / smaller >= 0.5:
            repeat_warnings += 1
    if repeat_warnings:
        log_event(
            "warning",
            "image_subject_repeat_detected",
            consecutive_pairs=repeat_warnings,
            total_images=len(image_markers),
            note="LLM is repeating subjects across consecutive images despite the diversity rule.",
        )
    return markers


_PALETTE_ROTATION: tuple[str, ...] = (
    "warm golden hour lighting",
    "cool blue twilight tones",
    "high-contrast moody chiaroscuro",
    "soft overcast diffused light",
    "rich saturated noon daylight",
    "moonlit silver and indigo",
    "candlelit amber and shadow",
    "stormy desaturated grey-green",
    "neon-accent rim lighting",
    "earthy sepia and brown",
    "crisp morning haze, pale sunlight",
    "blood-red sunset gradient",
)


def _topic_setting_prefix(topic: str, context_brief: str = "") -> str:
    """Last-resort fallback when the LLM-generated setting tag fails after
    retries. NO hardcoded list of cultures/eras.

    v0.2.8 — derive a REAL anchor from the Wikipedia brief we already
    fetched, not the old generic placeholder. The previous fallback was
    "<topic> setting (period-correct iconography, scene-appropriate
    palette, faithful to the topic)" — meaningless filler that gave CLIP
    nothing to grip, so when the LLM tag failed (~50% with Gemma 4B
    abliterated) every image converged to the same generic look (real
    user complaint on the 2026-05-15 Sun Wukong run). The brief's first
    sentence is a Wikipedia definitional sentence and almost always
    carries era + culture + place (e.g. "...16th-century Chinese novel
    Journey to the West..."). Embedding it gives the diffusion model a
    strong topic anchor even without the LLM.
    """
    if not (topic or "").strip():
        return ""
    cleaned_topic = topic.strip().rstrip(".,;:")
    if len(cleaned_topic) > 80:
        cleaned_topic = cleaned_topic[:80].rsplit(" ", 1)[0]

    descriptor = ""
    brief = (context_brief or "").strip()
    if brief:
        # First 1-2 sentences of the brief carry the real era/culture.
        # Split on sentence enders; keep enough for cultural cues but
        # bounded so the prompt prefix stays compact.
        sents = re.split(r'(?<=[.!?])\s+', brief)
        descriptor = " ".join(s.strip() for s in sents[:2] if s.strip())
        # Strip a leading "<Topic> is/was/refers to" so we keep the
        # substance ("a 16th-century Chinese mythic novel ...").
        descriptor = re.sub(
            r'^\s*' + re.escape(cleaned_topic.split(",")[0]) +
            r'\b[^,.]*?\b(?:is|was|are|were|refers? to|means?)\b\s*',
            '', descriptor, flags=re.IGNORECASE,
        ).strip()
        descriptor = descriptor.strip('"\'` ')
        if len(descriptor) > 220:
            descriptor = descriptor[:220].rsplit(" ", 1)[0]

    if descriptor:
        return (
            f"{cleaned_topic} — {descriptor} — cinematic setting "
            "(period-accurate iconography, era-true palette, rich "
            "production detail)"
        )
    # No brief at all → still better than pure filler: lean on the topic.
    return (
        f"{cleaned_topic} setting "
        "(period-accurate iconography, era-true palette, "
        "cinematic production detail faithful to the topic)"
    )


# Pattern used to clean up the LLM-generated setting tag (which sometimes
# arrives wrapped in quotes, with a leading "Setting: " label, etc.)
_SETTING_TAG_CLEANUP = re.compile(
    r'^\s*(?:setting\s*[:\-]\s*|"|\'|\*|`)+|(?:"|\'|\*|`)+\s*$',
    re.IGNORECASE,
)


# v0.6.8 — Concrete-object nouns that NEVER belong in a style anchor.
# If Gemma's setting tag dumps any of these as the first parenthetical
# segment (e.g. "burning world-tree" instead of "ash-grey palette"),
# the entire segment is rejected and only the era/culture head is kept
# so the icon doesn't get stamped on every image.
_STYLE_ANCHOR_HAS_OBJECT = re.compile(
    r"\b(?:"
    r"tree|trees|world-tree|oak|trunk|root|roots|leaf|leaves|forest|"
    r"hammer|sword|axe|shield|spear|bow|dagger|crown|"
    r"throne|altar|temple|pyramid|tomb|palace|castle|tower|cathedral|"
    r"dragon|serpent|wyrm|wolf|wolves|eagle|raven|lion|tiger|bear|horse|"
    r"rune|runes|tablet|scroll|sigil|glyph|"
    r"volcano|volcan|mountain|cliff|desert|jungle|ocean|"
    r"warrior|warriors|knight|monk|priest|shaman|wizard|sorcerer|king|queen|god|goddess"
    r")\b",
    re.IGNORECASE,
)


def _style_anchor(setting: str) -> str:
    """v0.2.9 — extract a THIN style anchor (era + culture + PALETTE
    only) from a full setting tag, dropping the concrete iconography
    objects.

    Why: the full tag is e.g.
        "Ancient Greek classical mythic setting (deep ultramarine and
         gold, marble temples, olive groves, thunderbolts, celestial
         feasts)"
    Injecting that — prefix AND suffix — into EVERY image prompt baked
    `marble temples`/`thunderbolts`/`olive groves` into every frame,
    regardless of what that beat actually narrates (real user complaint:
    "muchas con un rayo detrás, todas parecen iguales en algún
    elemento", 2026-05-15 Olympian gods run). The era/culture/palette
    must stay (anti-drift + colour cohesion); the OBJECTS must not be
    stamped on all — the distiller already varies subject per beat.

    Strategy: keep everything before "(" + only the FIRST parenthetical
    segment (the palette, e.g. "deep ultramarine and gold"). Drop the
    remaining comma-separated object nouns. Returns a compact anchor:
        "Ancient Greek classical mythic setting, deep ultramarine and
         gold palette"
    """
    s = (setting or "").strip()
    if not s:
        return ""
    head, _, rest = s.partition("(")
    head = head.strip().rstrip(".,;: ")
    if not rest:
        return head  # no parenthetical → already thin
    inside = rest.split(")", 1)[0]
    palette = inside.split(",")[0].strip().strip(".,;: ")
    # v0.6.8 — CRITICAL ICONOGRAPHY BLEED FIX. The previous code assumed
    # the first parenthetical segment was always palette. It isn't:
    # Gemma frequently dumps a concrete OBJECT first ("burning world-tree,
    # ash-grey palette, ember sparks") so this prefix got stamped on
    # EVERY beat → every image rendered the same icon regardless of the
    # narrated subject (real user complaint, Norse mythology run: 8/15
    # frames were the same burning tree). Reject any first-segment that
    # contains a concrete-object noun and fall back to the bare head.
    if palette and _STYLE_ANCHOR_HAS_OBJECT.search(palette):
        log_event(
            "warning", "style_anchor_iconography_dropped",
            rejected=palette[:80],
            setting_preview=s[:120],
        )
        return head
    if palette:
        # Avoid "... palette palette" if the model already said it.
        tail = "" if palette.lower().endswith("palette") else " palette"
        return f"{head}, {palette}{tail}"
    return head


# v0.1.38 — NO hardcoded culture lists. The setting tag is generated
# by the LLM at request time using the user's literal topic plus the
# topic-specific Wikipedia brief gathered earlier in generate_script.
# That gives Gemma the same factual grounding the script uses, so the
# era / culture / palette flow from the topic itself, not from a
# hardcoded catalog.


# Wikipedia RAG — light retrieval for grounding facts.
# v0.1.37: the LLM (Gemma 4B abliterated) tends to write generic / vague
# narrations because it doesn't have specific facts about the topic in
# its small parameter budget. We pull a Wikipedia summary + 1-2 related
# pages and inject them as `context_facts` in the prompt template. This
# lifts the script from "ambiguous" to "anchored in real facts".
_WIKI_LANG_BY_SCRIPT = {
    "es": "es", "en": "en", "zh": "zh", "ja": "ja", "ko": "ko",
    "pt": "pt", "fr": "fr", "de": "de", "ru": "ru", "it": "it",
}

# Wikipedia robot policy requires a custom User-Agent that identifies the
# tool + a way to contact the maintainer. (Plain default httpx UA → 403.)
_WIKI_HEADERS = {
    "User-Agent": "XianxiaStudio/0.1 (https://github.com/SwonDev/Xianxia_Studio; xianxia-studio-bot) httpx/0.27"
}


async def _wiki_search(query: str, lang: str, limit: int = 3) -> list[str]:
    """Return up to `limit` matching page titles from Wikipedia search."""
    url = f"https://{lang}.wikipedia.org/w/api.php"
    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_WIKI_HEADERS) as client:
            r = await client.get(url, params={
                "action": "query", "list": "search", "format": "json",
                "srsearch": query, "srlimit": limit, "utf8": 1,
            })
            r.raise_for_status()
            return [
                hit["title"]
                for hit in (r.json().get("query", {}).get("search", []) or [])
            ][:limit]
    except Exception as exc:
        log_event("warning", "wiki_search_fail", err=str(exc)[:120], lang=lang, q=query[:60])
        return []


async def _wiki_summary(title: str, lang: str) -> str:
    """Return the lead-section summary of a Wikipedia page (clean text)."""
    title_safe = title.replace(" ", "_")
    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title_safe}"
    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_WIKI_HEADERS) as client:
            r = await client.get(url)
            if r.status_code != 200:
                return ""
            data = r.json()
            extract = (data.get("extract") or "").strip()
            return extract[:1200]  # cap so context stays focused
    except Exception as exc:
        log_event("warning", "wiki_summary_fail", err=str(exc)[:120], title=title[:60])
        return ""


async def _wiki_full_extract(title: str, lang: str, max_chars: int = 2500) -> str:
    """Pull the full prose extract of a Wikipedia article (lead + sections),
    not just the summary. Strips wiki markup tags. Used to give the LLM
    enough material to anchor a 1-15 minute narration in real facts.
    """
    url = f"https://{lang}.wikipedia.org/w/api.php"
    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_WIKI_HEADERS) as client:
            r = await client.get(url, params={
                "action": "query", "prop": "extracts", "explaintext": 1,
                "format": "json", "titles": title, "redirects": 1,
                "exsectionformat": "plain",
            })
            if r.status_code != 200:
                return ""
            pages = (r.json().get("query", {}) or {}).get("pages", {}) or {}
            for _pid, page in pages.items():
                extract = (page.get("extract") or "").strip()
                if extract:
                    extract = re.sub(r"\n{3,}", "\n\n", extract)
                    return extract[:max_chars]
    except Exception as exc:
        log_event("warning", "wiki_extract_fail", err=str(exc)[:120], title=title[:60])
    return ""


# v0.1.38 fix: pages whose lead paragraph starts with these patterns are
# fictional / pop-culture pieces (episode of Doctor Who, novel, film,
# videogame, comic-book issue). When the user's topic is a real-world
# subject we want the encyclopaedic article, not the fictional namesake
# whose title happens to match.
_FICTIONAL_LEAD_PATTERNS = (
    "es el ", "es la ",
    "es un episodio", "es una pelicula", "es una película", "es una novela",
    "es un videojuego", "es un cómic", "es un comic", "es una serie",
    "is an episode", "is a film", "is a movie", "is a novel",
    "is a video game", "is a comic", "is a tv series",
    "is the ninth episode", "is the eighth episode", "is the seventh episode",
    "is the sixth episode", "is the fifth episode", "is the fourth episode",
    "is the third episode", "is the second episode", "is the first episode",
)
_LEADING_ARTICLES = ("la ", "el ", "las ", "los ", "the ", "a ", "an ", "le ", "les ")


def _topic_search_variants(topic: str) -> list[str]:
    """Build robust search query variants. Strips a leading definite article
    so 'La Guerra Fría' matches 'Guerra Fría' (the encyclopaedic article)
    instead of the Doctor Who episode whose title is 'La Guerra Fría'.
    """
    t = topic.strip()
    variants = [t]
    low = t.lower()
    for art in _LEADING_ARTICLES:
        if low.startswith(art):
            variants.append(t[len(art):].strip())
            break
    # Dedupe while preserving order
    seen = set()
    out = []
    for v in variants:
        k = v.lower()
        if k and k not in seen:
            seen.add(k)
            out.append(v)
    return out


def _looks_fictional(extract_lead: str) -> bool:
    """Heuristic: the first sentence betrays a fictional / pop-culture
    page when it opens with 'es el episodio…' / 'is a novel…' etc.
    """
    head = extract_lead.lstrip()[:240].lower()
    # Strip leading bracketed page-title prefix our caller adds.
    if head.startswith("["):
        nl = head.find("\n")
        if nl > 0:
            head = head[nl + 1:].lstrip()
    return any(p in head for p in _FICTIONAL_LEAD_PATTERNS)


async def _gather_topic_facts(topic: str, lang_tag: str) -> str:
    """v0.1.38: gather a RICH factual brief for the topic.

    Strategy:
      - Try search variants (literal + article-stripped) so 'La Guerra
        Fría' resolves to the encyclopaedic 'Guerra Fría' article, not
        the Doctor Who episode of the same Spanish title.
      - For each top hit, pull the FULL prose extract (not just lead
        summary). If the lead paragraph reveals a fictional / pop-culture
        page (episode, novel, film, etc.) skip it — except when the user's
        topic is itself fictional, in which case we do want it.
      - Cap the combined brief at 5000 chars.
    """
    if not topic.strip():
        return ""
    primary_lang = _WIKI_LANG_BY_SCRIPT.get(lang_tag.lower()[:2], "en")
    variants = _topic_search_variants(topic)
    facts_blocks: list[str] = []
    seen_titles: set[str] = set()
    char_budget = 5000

    for lang in ((primary_lang, "en") if primary_lang != "en" else ("en",)):
        for query in variants:
            titles = await _wiki_search(query, lang, limit=5)
            for title in titles:
                key = (lang, title.lower())
                if key in seen_titles:
                    continue
                seen_titles.add(key)
                extract = await _wiki_full_extract(
                    title, lang,
                    max_chars=max(800, char_budget - sum(len(b) for b in facts_blocks)),
                )
                if not extract:
                    extract = await _wiki_summary(title, lang)
                if not extract:
                    continue
                # Skip fictional-looking pages — unless we've already
                # gathered nothing better and the search is exhausted.
                if _looks_fictional(extract):
                    log_event(
                        "info", "topic_facts_skipped_fiction",
                        title=title[:60], lang=lang,
                    )
                    continue
                facts_blocks.append(f"[{lang}] {title}\n{extract}")
                if sum(len(b) for b in facts_blocks) >= char_budget:
                    break
            if sum(len(b) for b in facts_blocks) >= 2000:
                break
        if sum(len(b) for b in facts_blocks) >= 2000:
            break  # enough from primary language

    if not facts_blocks:
        log_event("info", "topic_facts_empty", topic=topic[:60], lang=primary_lang)
        return ""
    brief = "\n\n".join(facts_blocks)[:char_budget]
    log_event(
        "info", "topic_facts_gathered",
        topic=topic[:60], lang=primary_lang,
        sources=len(facts_blocks), brief_len=len(brief),
    )
    return brief


async def _extract_key_facts(
    topic: str,
    raw_brief: str,
    language_name: str,
    model: str = "xianxia-llm",
) -> str:
    """v0.1.38 — Two-pass narrative grounding.

    Gemma 4B by itself paraphrases a Wikipedia summary into vague poetic
    abstractions ("eternal hero, symbol of responsibility") instead of
    telling the actual story. The fix is a CHEAP first pass that just
    asks the LLM to extract a structured list of NAMES, DATES, PLACES,
    EVENTS and QUOTES from the raw brief — and then we hand THAT to the
    main script generator as the skeleton it must use.

    Output is a plain-text bulleted list (NOT JSON — Gemma is unreliable
    with strict schemas). Returns empty string on failure; caller falls
    back to the raw brief.
    """
    if not raw_brief.strip():
        return ""
    system = (
        "You are a documentary research assistant. Given raw reference "
        f"text, extract the most NARRATIVELY USEFUL FACTS in {language_name} "
        "as a flat bulleted list. Each bullet must be one specific fact: "
        "a name, a date, a place, a quote, a turning-point event, a "
        "famous line, a relationship. NO general descriptions, NO "
        "abstractions. ONLY concrete facts that a documentary narrator "
        "could cite verbatim. Output ONLY the bullet list, no preamble."
    )
    prompt = (
        f"Topic: {topic}\n\n"
        "RAW REFERENCE:\n"
        f"{raw_brief}\n\n"
        "Now extract 12-18 narratively useful facts (names, dates, "
        "places, events, quotes, relationships). Each on its own line, "
        "starting with '- '. Be specific. NO abstractions like 'symbol of "
        "responsibility' — only verifiable concrete details from the text "
        f"above. Use {language_name} for the bullet text but keep proper "
        "names (people, titles, places) in their original spelling.\n\n"
        "Output:"
    )
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                result = await llm_generate(
                    model=model,
                    system=system,
                    prompt=prompt,
                    options={
                        "temperature": 0.3,  # tight: we want extraction, not creativity
                        # v0.1.38: 400 is enough for 12-18 short bullets
                        "num_predict": 400,
                        "num_ctx": 6144,
                    },
                    think=False,
                    max_continuations=0,
                    client=client,
                    timeout=120.0,
                )
            except httpx.HTTPError as exc:
                log_event("warning", "key_facts_llm_http_fail",
                          error=str(exc)[:120], topic=topic[:60])
                return ""
            raw = (result.get("response") or "").strip()
            # Keep only lines that look like bullets (start with - or • or *)
            kept = []
            for line in raw.splitlines():
                s = line.strip()
                if not s:
                    continue
                if s.startswith(("- ", "• ", "* ")) or (len(s) > 5 and s[0].isdigit() and s[1] in (".", ")")):
                    kept.append(s if s.startswith("- ") else f"- {s.lstrip('-•*0123456789.) ')}")
            if len(kept) < 4:
                log_event("warning", "key_facts_too_short",
                          topic=topic[:60], n=len(kept))
                return ""
            distilled = "\n".join(kept[:20])
            log_event("info", "key_facts_extracted",
                      topic=topic[:60], n_facts=len(kept), chars=len(distilled))
            return distilled
    except Exception as exc:
        log_event("warning", "key_facts_llm_exception",
                  err=str(exc)[:120], topic=topic[:60])
        return ""


async def _generate_setting_tag(
    topic: str,
    model: str = "xianxia-llm",
    context_brief: str = "",
) -> str:
    """Ask the LLM to produce a single-line "setting tag" describing the
    visual world the topic lives in: era, culture, palette, iconic elements.

    The tag is prepended (and suffixed) to EVERY image prompt so the diffusion
    model anchors its output in the user's actual topic instead of drifting
    toward whatever aesthetic the model was last fine-tuned on.

    v0.1.31: NO HARDCODED TOPIC LIST. The user's topic drives everything;
    the LLM is responsible for producing the setting tag. We retry up to
    3 times with progressively higher temperature if the response is short.
    Only on outright LLM failure do we fall back to a tag built straight
    from the user's literal topic — never a pre-curated list.

    Output contract: a single line ≤ 200 chars in this exact form:
        "<Era> <Culture> setting (<palette>, <iconic elements>)"
    """
    if not topic.strip():
        return ""
    # v0.1.38 — ZERO hardcoded examples, ZERO culture catalogues.
    # We rely on (1) the user's literal topic and (2) the Wikipedia
    # brief already gathered for that topic. The LLM reads the brief
    # — which contains the topic's real era, culture, geography,
    # iconography — and writes a setting line anchored on those facts.
    # Whatever topic the user types (Atlantis, Pygmies, deep space,
    # Renaissance, Power Rangers, etc.), the brief carries the right
    # context, so the LLM never has to guess based on examples.
    system = (
        "You are a visual director. Read the user's topic AND the "
        "factual brief about it. Return ONE LINE describing the visual "
        "setting that every shot of the video must match.\n\n"
        "Strict format:\n"
        "    <Era> <Culture> setting (<palette>, <iconic elements>)\n\n"
        "Rules:\n"
        " - Anchor era + culture + palette + iconography in what the "
        "brief actually says. If the brief mentions Atlantis as a "
        "submerged Mediterranean civilization, your output is "
        "Mediterranean, not Egyptian.\n"
        " - If the topic is purely fictional / sci-fi / future, invent "
        "iconography matching the topic's own world (the brief usually "
        "tells you what world).\n"
        " - Never substitute the topic's culture for a famous one you "
        "happen to know (Egyptian, Chinese, Roman, etc.) unless the "
        "brief literally says it.\n"
        " - The line MUST contain the word 'setting' and a parenthesis "
        "with at least a palette and one iconic element.\n"
        " - Output ONLY the single setting line. No preamble, no quotes, "
        "no markdown, no explanation.\n\n"
        "Examples (follow this shape EXACTLY):\n"
        "Topic: Journey to the West / Sun Wukong\n"
        "Setting: Ming-dynasty Chinese mythic fantasy setting "
        "(jade-green, cinnabar red and imperial gold, cloud-wreathed "
        "mountain monasteries, celestial courts, Buddhist relics)\n"
        "Topic: The pyramids of ancient Egypt\n"
        "Setting: Ancient Egyptian Old Kingdom setting (sand-gold, "
        "ochre and lapis-lazuli blue, hieroglyph-carved limestone, "
        "Nile reeds, sun-disc iconography)\n"
        "Topic: Cyberpunk megacity heist\n"
        "Setting: Near-future neon dystopia setting (electric magenta "
        "and cyan on wet black, holographic signage, rain-slick "
        "megastructures, chrome implants)"
    )
    brief_block = ""
    if context_brief:
        # Cap to ~1200 chars — enough for cultural cues, small enough
        # to keep latency low (this is a single-call sidecar prompt).
        snippet = context_brief.strip()[:1200]
        brief_block = f"\nFactual brief about the topic:\n{snippet}\n"
    prompt = f"Topic: {topic}{brief_block}\nSetting:"
    # v0.2.8 — was [(0.4,80),(0.7,120),(1.0,160)] with a hard len>=15
    # gate that rejected legitimate compact tags and fell back to a
    # generic placeholder ~50% of the time (Gemma 4B abliterated is
    # non-deterministic). More attempts + a smarter line picker + a
    # relaxed floor make the LLM path land far more often.
    attempts: list[tuple[float, int]] = [
        (0.35, 110), (0.6, 150), (0.85, 190), (1.1, 220)
    ]
    last_raw_len = 0
    for attempt_idx, (temp, npred) in enumerate(attempts, start=1):
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    result = await llm_generate(
                        model=model,
                        system=system,
                        prompt=prompt,
                        options={
                            "temperature": temp,
                            "num_predict": npred,
                            "num_ctx": 1024,
                        },
                        think=False,
                        max_continuations=0,
                        client=client,
                        timeout=60.0,
                    )
                except httpx.HTTPError as exc:
                    log_event("warning", "setting_tag_llm_http_fail",
                              error=str(exc)[:120],
                              attempt=attempt_idx,
                              topic=topic[:60])
                    continue
                raw = (result.get("response") or "").strip()
                last_raw_len = len(raw)
                # v0.2.8 — smarter line picker. The old code took the
                # FIRST non-empty line, which broke when the model
                # emitted "Setting:" on its own line, a preamble, or a
                # markdown bullet first. Now: clean every line, then
                # prefer the best candidate (one containing 'setting'
                # AND a parenthesis), else the longest cleaned line.
                cand: list[str] = []
                for ln in raw.splitlines():
                    c = _SETTING_TAG_CLEANUP.sub("", ln.strip()).strip()
                    # Drop a bare leading "Setting:" label line.
                    c = re.sub(r'^\s*setting\s*[:\-]\s*', '', c,
                               flags=re.IGNORECASE).strip()
                    if len(c) >= 12:
                        cand.append(c)
                line = ""
                strong = [c for c in cand
                          if 'setting' in c.lower() and '(' in c]
                if strong:
                    line = max(strong, key=len)
                elif cand:
                    line = max(cand, key=len)
                if len(line) > 220:
                    line = line[:220].rsplit(" ", 1)[0]
                # Relaxed floor (was 15): a compact but real tag like
                # "Edo Japan setting (indigo, washi, ukiyo-e)" is ~40
                # chars; anything ≥ 18 with a parenthesis is usable.
                ok = bool(line) and (
                    (len(line) >= 18 and '(' in line)
                    or len(line) >= 28
                )
                if ok:
                    log_event("info", "setting_tag_generated",
                              topic=topic[:60],
                              tag=line[:120],
                              attempt=attempt_idx)
                    return line
                log_event("warning", "setting_tag_llm_short_response",
                          attempt=attempt_idx,
                          topic=topic[:60],
                          raw_len=len(raw),
                          line_len=len(line))
        except Exception as exc:
            log_event("warning", "setting_tag_llm_exception",
                      attempt=attempt_idx,
                      err=str(exc)[:120],
                      topic=topic[:60])
    # All retries exhausted — fall back to a brief-derived anchor
    # (v0.2.8) instead of meaningless generic filler.
    fallback = _topic_setting_prefix(topic, context_brief)
    log_event("warning", "setting_tag_all_attempts_failed",
              topic=topic[:60],
              last_raw_len=last_raw_len,
              fallback=fallback[:120])
    return fallback


def _inject_auto_image_markers(
    narration: str,
    existing: list[Marker],
    target_count: int,
    *,
    topic: str = "",
    setting_tag: str = "",
    style_suffix: str | None = None,
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
        # v0.7.0 — preset-aware suffix; None falls back to the legacy
        # _STYLE_SUFFIX (which equals IMAGE_STYLE_BIAS["cinematic"] for
        # narrative_epic → byte-identical for existing callers).
        _suffix = style_suffix if style_suffix is not None else _STYLE_SUFFIX
        prompt = f"{first}, {_suffix}"
        # v0.2.9 — inject only the THIN style anchor (era+culture+
        # palette), PREFIX ONLY. The old code injected the full setting
        # tag (with concrete objects like "thunderbolts, marble temples")
        # as prefix AND suffix → every image shared those objects
        # regardless of the narrated beat. The distiller already varies
        # subject per beat; the anchor only needs to hold era + palette.
        setting = setting_tag or _topic_setting_prefix(topic)
        anchor = _style_anchor(setting)
        if anchor:
            prompt = f"{anchor}. {prompt}"
        # v0.1.30: cap raised from 320 to 480 to fit prefix+content+suffix
        # of the setting tag without truncating into mid-sentence. Z-Image's
        # CLIP tokenizer truncates at 77 tokens (~300 chars of plain text);
        # we let the leading setting tag + literal narration land within
        # that budget, and let the trailing setting tag overflow — CLIP
        # takes the first 77 tokens, so the suffix may be cut, but the
        # PREFIX still carries the topic anchor.
        if len(prompt) > 480:
            prompt = prompt[:480].rsplit(" ", 1)[0]
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
# v0.1.40 — visual variety WITHOUT overriding the scene content.
#
# Earlier versions tried to enforce a 6-type shot rotation (wide /
# action / closeup / character / object / architecture) that REWROTE
# the prompt's subject regardless of what the narration said in that
# moment. That fought against the user's core requirement: the image
# must illustrate exactly what the narrator is describing right now —
# if the line is "the priest raised the staff", the image is a priest
# raising a staff, not a forced "no-people landscape" because the
# rotation said so.
#
# The right approach: keep the narrated subject UNTOUCHED and only
# layer variations that change camera angle, focal length, time of day,
# atmosphere, etc. so consecutive beats look distinct without losing
# faithfulness to the story.
_CAMERA_VARIATIONS: list[str] = [
    "establishing wide shot, sweeping landscape framing",
    "medium three-quarter shot, balanced composition",
    "extreme close-up, shallow depth of field, intimate detail",
    "low-angle hero shot, looking up, dramatic perspective",
    "high-angle bird's-eye view, top-down composition",
    "Dutch tilt, off-balance kinetic energy",
    "over-the-shoulder shot, character in foreground silhouette",
    "telephoto compression, distant subject pulled close",
    "ultra-wide lens, exaggerated foreground depth",
    "macro detail shot, texture and material focus",
    "side profile shot, silhouette against sky",
    "two-shot framing, subject and environment in dialogue",
]

_LIGHTING_VARIATIONS: list[str] = [
    "dawn light, low golden sun, long shadows",
    "midday harsh overhead light, deep contrast",
    "golden hour, warm rim-light from the side",
    "blue hour twilight, cool tones",
    "overcast diffuse sky, soft even light",
    "stormy dramatic sky, dark heavy clouds",
    "nightfall, moonlight, deep cool shadows",
    "interior candle / firelight, warm flicker",
    "shaft of sunlight through window or opening",
    "fog and mist diffusion, atmospheric haze",
    "backlit silhouette, halo rim of light",
    "harsh sidelight, half-face in shadow",
]


# v0.1.40 — universal NO-TEXT clause. Z-Image-Turbo (and most diffusion
# models) sometimes hallucinate fake letters on signs, banners, books,
# inscriptions, runes carved into stone, etc. The user reported text
# bleeding into rendered images — that's never wanted in our pipeline
# (it's always gibberish and breaks the cinematic illusion). We append
# this clause to every image prompt and rely on Z-Image's CLIP encoder
# treating the explicit "no text" tokens as a strong negation in the
# positive-prompt-only flow.
_NO_TEXT_CLAUSE = (
    "no text, no letters, no words, no writing, no inscriptions, no runes, "
    "no symbols, no logos, no signs, no captions, no subtitles, no watermarks"
)


# Fictional-adaptation contamination guard. When the topic has a famous
# movie / TV / book / game adaptation, Gemma sometimes regurgitates the
# adaptation's protagonist names and plot beats verbatim into the
# narration ("Milo Thatch", "El regreso de Milo", "la franquicia de
# Disney", "DC Comics", "Disney Dreamlight Valley", etc.). Catching every
# possible name is impossible, but a few generic phrases reliably signal
# that the script has drifted from the real topic into a synopsis of a
# pop-culture work — and we want to warn (and ideally re-prompt) when
# they appear.
_ADAPTATION_LEAK_PATTERNS = re.compile(
    r"\b("
    r"disney|pixar|dreamworks|marvel|dc\s+comics?|warner\s+bros|"
    r"netflix|prime\s+video|hbo|"
    r"la\s+pel[ií]cula|the\s+movie|the\s+film|the\s+series|the\s+show|"
    r"la\s+franquicia|the\s+franchise|"
    r"el\s+regreso\s+de|"
    r"dreamlight\s+valley|kingdom\s+hearts"
    r")\b",
    re.IGNORECASE,
)


# v0.2.4 — Anti-repetition Jaccard helpers para diversidad de sujetos
# entre items consecutivos. La forced injection (shot/palette/tod) varía
# la composición pero los SUJETOS se repiten ("aztec warrior" en 5 items
# seguidos). Después del distill calculamos Jaccard(item_i, item_{i-1})
# y si > 0.55 pivotamos el sujeto inyectando un noun extraído del
# setting_tag (azteca, mesoamerican, feathered, regalia, temple, pyramid,
# etc.). Topic-agnóstico: usa los nouns de la propia descripción de
# setting que generó el LLM en _generate_setting_tag.
_NOUN_SPLIT = re.compile(r"[\s,;:.\-]+")
_STOPWORDS = {
    "the", "a", "an", "of", "and", "with", "in", "on", "at", "to", "for",
    "by", "is", "are", "this", "that", "its", "over", "under",
}


def _noun_set(text: str) -> set[str]:
    return {
        w for w in (t.lower() for t in _NOUN_SPLIT.split(text) if t)
        if len(w) > 2 and w not in _STOPWORDS
    }


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


# v0.6.5 — deterministic SUBJECT diversification.
#
# Root cause of the chronic "muchas imágenes iguales" complaint: the
# per-beat pipeline rotates camera/palette/time-of-day by index but the
# distilled SUBJECT stays whatever the narration sentence says. For a
# single-subject / abstract topic (black holes, relativity, a person…)
# every sentence repeats the headline noun, so every image is the same
# subject re-coloured. `_diversify_subjects` only LOGGED this; it never
# acted. These two helpers ACT on it, deterministically (no reliance on
# Gemma following soft rules — the documented history shows that always
# regresses; deterministic index rotation is what worked in v0.2.1).

# Words that are never useful as a distinct visual facet.
_FACET_STOP = {
    "the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "by",
    "is", "was", "are", "were", "be", "been", "as", "it", "its", "this",
    "that", "these", "those", "with", "for", "from", "into", "than",
    "then", "also", "however", "which", "who", "whom", "whose", "what",
    "when", "where", "while", "his", "her", "their", "there", "here",
    "they", "them", "one", "two", "first", "known", "called", "named",
    "century", "year", "years", "such", "other", "some", "many", "most",
}


def _facet_pool(context_brief: str, setting_tag: str, topic: str) -> list[str]:
    """Build an ordered, de-duplicated pool of CONCRETE distinct facets
    of the topic, mined deterministically (no LLM) from the Wikipedia
    brief we already fetched plus the iconography parenthetical of the
    setting tag.

    A "facet" is a proper-noun phrase ("Albert Einstein", "Cygnus X-1",
    "Event Horizon Telescope", "General Relativity") or a concrete
    iconography noun the setting tag lists. These are the alternative
    subjects we rotate in when the narration would otherwise force the
    same headline subject onto every beat.

    Returns first-seen order so the rotation tracks the brief's own
    narrative arc. Excludes the topic's own head words (those are the
    over-used subject we are trying to get AWAY from) and stopwords.
    """
    topic_head = {
        w for w in re.findall(r"[a-zA-Z]{3,}", (topic or "").lower())
    }
    seen: set[str] = set()
    pool: list[str] = []

    def _add(phrase: str) -> None:
        p = phrase.strip().strip("\"'`.,;:()[]").strip()
        if len(p) < 4 or len(p) > 48:
            return
        low = p.lower()
        words = [w for w in re.findall(r"[a-zA-Z]{3,}", low)]
        if not words:
            return
        # Skip if every content word is a stopword or part of the topic
        # head (that's the repetitive subject we are escaping).
        if all(w in _FACET_STOP or w in topic_head for w in words):
            return
        if low in seen:
            return
        seen.add(low)
        pool.append(p)

    # 1) Iconography list inside the setting tag parenthetical, e.g.
    #    "Ancient Greek setting (marble temples, thunderbolts, …)".
    if setting_tag:
        m = re.search(r"\(([^)]+)\)", setting_tag)
        if m:
            for chunk in m.group(1).split(","):
                _add(chunk)

    # 2) Proper-noun phrases from the brief (1-4 capitalised words).
    brief = (context_brief or "").strip()
    if brief:
        for m in re.finditer(
            r"\b([A-Z][\w-]+(?:\s+(?:of\s+|the\s+)?[A-Z][\w-]+){0,3})\b",
            brief,
        ):
            _add(m.group(1))

    return pool[:24]


def _enforce_subject_diversity(
    distilled: list[str],
    facet_pool: list[str],
    *,
    window: int = 4,
    thresh: float = 0.55,
) -> list[str]:
    """For each distilled phrase whose subject nouns overlap too much
    with the previous `window` (already-emitted) phrases, prepend the
    next unused facet as the LEADING subject (CLIP weights leading
    tokens, so the rendered image diverges). Deterministic index
    rotation through `facet_pool` — never calls the LLM.

    Same length out as in. If the pool is empty it returns the input
    unchanged (graceful: degrades to prior behaviour, no regression).
    """
    if not distilled or not facet_pool:
        return list(distilled)
    out: list[str] = []
    history: list[set[str]] = []
    facet_ptr = 0
    rewritten = 0
    for phrase in distilled:
        subj = _extract_subject_keywords(phrase)
        max_j = 0.0
        for prev in history[-window:]:
            j = _jaccard(subj, prev)
            if j > max_j:
                max_j = j
        if max_j >= thresh and subj:
            facet = facet_pool[facet_ptr % len(facet_pool)]
            facet_ptr += 1
            new_phrase = f"{facet}: {phrase}"
            rewritten += 1
            out.append(new_phrase)
            history.append(_extract_subject_keywords(new_phrase))
        else:
            out.append(phrase)
            history.append(subj)
    if rewritten:
        log_event(
            "info",
            "image_subject_diversity_enforced",
            rewritten=rewritten,
            total=len(distilled),
            pool_size=len(facet_pool),
            note="repeated subjects pivoted to distinct topic facets (deterministic).",
        )
    return out


async def _distill_visual_phrases(
    sentences: list[str],
    topic: str,
    setting_tag: str,
    language_name: str,
    model: str,
) -> list[str]:
    """Convert N raw narration sentences (any language) into N English
    visual phrases of 6-12 concrete nouns each.

    Why: passing the full Spanish narration verbatim to Z-Image as the
    image subject made the diffusion model render the sentence as
    on-screen subtitle text (a literal subtitle baked into the frame —
    a recurring v0.1.41 bug). The CLIP-text encoder treats long prose
    as content to draw, especially with cfg=1 and no negative prompt.

    By distilling to a short English noun list, we keep the per-beat
    fidelity (the image still shows what's being narrated at that
    moment) WITHOUT giving the model a sentence to copy as text.

    Returns a list of the same length as `sentences`. If the LLM call
    fails the fallback is the original sentence (degrades gracefully
    to the v0.1.41 behaviour).
    """
    if not sentences:
        return []
    n = len(sentences)
    # v0.1.47: batch in groups of 6 for reliability. The single-batch
    # call for 18 sentences would frequently truncate or return a JSON
    # with only 1 fully-formed item (observed: distilled=1/18 on
    # "Azteca" run despite num_predict=1980). Smaller batches let
    # Gemma finish each JSON cleanly. The PER-ITEM retry below then
    # mops up any holes individually.
    return await _distill_in_batches(
        sentences, topic, setting_tag, language_name, model,
    )


async def _distill_in_batches(
    sentences: list[str],
    topic: str,
    setting_tag: str,
    language_name: str,
    model: str,
) -> list[str]:
    """Drive _distill_one_batch in chunks of <=6 sentences. Anything
    that comes back missing or empty gets a final per-item retry so we
    don't fall back to raw Spanish (which Z-Image bakes as on-screen
    subtitle text — the recurring 'text quemado en imágenes' bug)."""
    n = len(sentences)
    BATCH = 6
    by_index: dict[int, str] = {}
    for start in range(0, n, BATCH):
        block = sentences[start:start + BATCH]
        parsed = await _distill_one_batch(
            block, topic, setting_tag, language_name, model,
            start_idx=start + 1,
        )
        for k, v in parsed.items():
            by_index[k] = v
    # Per-item retry for anything missing.
    missing = [i for i in range(1, n + 1) if i not in by_index]
    if missing:
        log_event("info", "visual_distill_retry_missing", count=len(missing))
        for i in missing:
            single = await _distill_one_batch(
                [sentences[i - 1]], topic, setting_tag, language_name, model,
                start_idx=i,
            )
            for k, v in single.items():
                by_index[k] = v
    # Compose final list. ANY remaining hole gets a topic-anchored
    # generic visual phrase — NEVER the raw Spanish sentence (which
    # Z-Image renders as on-screen subtitle text).
    generic = _generic_visual_fallback(setting_tag, topic)
    distilled = 0
    fallback = 0
    out: list[str] = []
    for i in range(1, n + 1):
        if i in by_index:
            out.append(by_index[i])
            distilled += 1
        else:
            out.append(generic)
            fallback += 1
    log_event(
        "info", "visual_distill_done",
        sentences=n, distilled=distilled, fallback=fallback,
    )
    return out


def _generic_visual_fallback(setting_tag: str, topic: str) -> str:
    """Topic-anchored generic visual phrase used only when the LLM
    completely fails for a specific item. Never contains the raw
    narration sentence (which Z-Image would burn as subtitles)."""
    seed = setting_tag.strip() or topic.strip()
    return f"establishing landscape of {seed}, atmospheric lighting, photorealistic"


async def _distill_one_batch(
    sentences: list[str],
    topic: str,
    setting_tag: str,
    language_name: str,
    model: str,
    start_idx: int = 1,
) -> dict[int, str]:
    """Single batched LLM call. Returns {abs_index: english_phrase} for
    every sentence we managed to parse out of the JSON response."""
    if not sentences:
        return {}
    n = len(sentences)
    # v0.1.43: switched from free-form numbered list to JSON-formatted
    # output. Reason: with `xianxia-llm` (Gemma 4B abliterated) on
    # /api/generate the free-form prompt frequently returned an EMPTY
    # body with done_reason="length" (the model burned its num_predict
    # budget on hidden reasoning tokens that never made it into the
    # output stream — a known Gemma quirk). Ollama's `format=json`
    # enables grammar-constrained sampling so the model is forced to
    # emit a valid JSON object from the first token. Tested with the
    # exact 18-sentence Atlantis batch that failed in v0.1.42: all 18
    # items now distill correctly in ~5 s.
    # v0.2.1 — deterministic per-item rotation hints. The LLM was
    # ignoring our soft "Vary the SUBJECT" rule (user complaint: 20
    # near-identical Aztec warrior headshots). Solution: PRE-COMPUTE
    # a {shot, palette, time_of_day} triplet for each item via index
    # rotation, send it INSIDE the input JSON, and require the model
    # to incorporate those tokens verbatim in the output. Z-Image
    # responds strongly to these axes so the resulting frames vary
    # in composition + colour + lighting without us touching the
    # diffusion side.
    _SHOTS = (
        "wide_landscape_aerial",
        "medium_action_motion",
        "closeup_face_intense",
        "object_macro_detail",
        "architecture_interior",
        "crowd_overhead",
        "low_angle_silhouette",
        "over_the_shoulder",
    )
    _PALETTES = (
        "cobalt_blue_dominant",
        "crimson_red_dominant",
        "amber_gold_dominant",
        "jade_green_dominant",
        "monochrome_charcoal",
        "sunset_orange_pink",
        "ivory_bone_pale",
        "ink_indigo_violet",
    )
    _TIMES_OF_DAY = (
        "dawn_mist",
        "noon_harsh_sun",
        "golden_hour",
        "blue_hour_dusk",
        "moonlit_night",
        "stormy_overcast",
        "torchlit_interior",
        "lightning_flash",
    )
    items_in = []
    for i, s in enumerate(sentences):
        abs_i = start_idx + i
        items_in.append({
            "i": abs_i,
            "es": s.strip(),
            "shot": _SHOTS[(abs_i - 1) % len(_SHOTS)],
            "palette": _PALETTES[(abs_i - 1) % len(_PALETTES)],
            "tod": _TIMES_OF_DAY[(abs_i - 1) % len(_TIMES_OF_DAY)],
        })
    first_idx = start_idx
    last_idx = start_idx + n - 1
    instruction = (
        f"You are a visual prompt converter. Convert each {language_name} "
        f"narration sentence into a SHORT English visual phrase of 8-14 "
        f"concrete visible nouns each.\n\n"
        f"Topic: {topic.strip()}\n"
        f"Visual style anchor: {setting_tag.strip()}\n\n"
        "OUTPUT a single JSON object with this exact shape (no extra "
        "keys, no nesting beyond this):\n"
        '{"items":[{"i":1,"v":"<english noun list>"},'
        '{"i":2,"v":"<english noun list>"},...]}\n\n'
        "Rules for every v field:\n"
        "  • ENGLISH only — translate any Spanish/French/etc. proper "
        "nouns naturally (Atlántida → Atlantis, Platón → Plato).\n"
        "  • Plain comma-separated nouns and short adjectives. "
        "No verbs. No full sentences. No quotation marks inside v.\n"
        "  • STRICT VISIBILITY RULE: at least 4 of your 8-14 items "
        "MUST be physically photographable subjects — a place, a "
        "person doing something specific, an object, a piece of "
        "architecture, an animal, a weather event, a specific colour. "
        "BANNED token types (the diffusion model can't render them): "
        "'philosophical exercise', 'open debate', 'human endeavor', "
        "'collective memory', 'cultural legacy', 'pure speculation' "
        "— these are CONCEPTS, not images. If the input sentence is "
        "itself abstract, INVENT a concrete scene that metaphorically "
        "illustrates it.\n"
        "  • v0.2.1 STRICT DIVERSITY RULE — each input item carries "
        "three rotation tokens: `shot` (composition type), `palette` "
        "(colour dominance), `tod` (time-of-day lighting). YOU MUST "
        "incorporate ALL THREE tokens explicitly into the v field — "
        "e.g. if shot=closeup_face_intense, palette=crimson_red_dominant, "
        "tod=torchlit_interior, your v should look like 'close-up face, "
        "intense gaze, crimson red dominant, deep shadows, torchlit "
        "interior, …'. This guarantees Z-Image renders DIFFERENT "
        "compositions and colour moods across consecutive frames "
        "instead of 20 nearly-identical portrait shots (user complaint: "
        "'imágenes extremadamente iguales').\n"
        "  • ANTI-REPETITION: do not reuse the same primary subject "
        "noun across items i and i-1 (e.g. don't write 'aztec warrior' "
        "as the lead subject in two consecutive items).\n"
        "  • Stay faithful to the topic and the visual style anchor. "
        "If a sentence drifts into a fictional adaptation (movie, TV, "
        "book, video game), describe the underlying REAL subject "
        "instead — never include a copyrighted character name.\n\n"
        f"INPUT:\n{json.dumps(items_in, ensure_ascii=False)}\n\n"
        f"Output the JSON object for all {n} items, using indices "
        f"{first_idx} through {last_idx} EXACTLY."
    )
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            result = await llm_generate(
                model=model,
                prompt=instruction,
                # Grammar-constrained JSON output — bypasses the Gemma
                # "empty response" bug that v0.1.42 hit. On llama.cpp this
                # is enforced via GBNF; on Ollama via its native format=json.
                format="json",
                options={
                    "temperature": 0.4,
                    "top_p": 0.9,
                    "num_ctx": 8192,
                    # v0.1.47: each item ≈ 80 tokens for safety
                    # (JSON wrapping + 12 English nouns + some
                    # Gemma "thinking" overhead that counts but
                    # may not appear in `response`). Floor at 2048
                    # — enough for the 6-item max batch with head
                    # room. Cap 4096 to bound pathological cases.
                    "num_predict": min(4096, max(2048, n * 200)),
                },
                think=False,
                max_continuations=0,
                client=client,
                timeout=180.0,
            )
        text = (result.get("response") or "")
    except Exception as exc:  # pragma: no cover — network only
        log_event("warning", "visual_distill_exception", exc=str(exc)[:200])
        return {}

    # Parse the JSON object. Even with format=json Ollama occasionally
    # produces minor stragglers (trailing commas, an extra closing
    # brace, leading prose). We try strict json first, then fall back
    # to extracting the largest balanced {...} substring.
    by_index: dict[int, str] = {}
    parsed: dict | None = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Find the outermost {…} and try again. Defensive only — most
        # responses come back as valid JSON when format=json is set.
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except json.JSONDecodeError:
                parsed = None
    # v0.2.3 — FORCED rotation injection.
    # Small models (Gemma 4B abliterated) keep ignoring the soft prompt
    # rule that asks them to incorporate shot/palette/tod tokens into the
    # output `v`. Result: 16 visually near-identical frames in v0.2.2 of
    # the "Civilización Azteca" run despite the in-prompt hints. We now
    # POST-PROCESS each parsed v by APPENDING the rotation triplet
    # verbatim, in natural-language form Z-Image responds to strongly.
    # This guarantees diversity regardless of LLM obedience.
    _SHOT_TO_PHRASE = {
        "wide_landscape_aerial": "wide landscape shot, aerial view, vast horizon",
        "medium_action_motion": "medium shot, dynamic action motion, motion blur",
        "closeup_face_intense": "close-up face, intense gaze, shallow depth of field",
        "object_macro_detail": "macro object detail, sharp focus, extreme close-up",
        "architecture_interior": "architectural interior, symmetrical composition",
        "crowd_overhead": "crowd from overhead, top-down view, many figures",
        "low_angle_silhouette": "low angle silhouette, dramatic backlight",
        "over_the_shoulder": "over-the-shoulder shot, foreground figure",
    }
    _PALETTE_TO_PHRASE = {
        "cobalt_blue_dominant": "cobalt blue dominant colour palette",
        "crimson_red_dominant": "crimson red dominant colour palette",
        "amber_gold_dominant": "amber and gold dominant colour palette",
        "jade_green_dominant": "jade green dominant colour palette",
        "monochrome_charcoal": "monochrome charcoal tones, desaturated",
        "sunset_orange_pink": "sunset orange and pink palette",
        "ivory_bone_pale": "ivory and pale bone palette",
        "ink_indigo_violet": "ink indigo and violet palette",
    }
    _TOD_TO_PHRASE = {
        "dawn_mist": "dawn mist, soft golden first light",
        "noon_harsh_sun": "noon harsh overhead sunlight, hard shadows",
        "golden_hour": "golden hour warm side light, long shadows",
        "blue_hour_dusk": "blue hour dusk, cool ambient sky",
        "moonlit_night": "moonlit night, cool blue tones, low key",
        "stormy_overcast": "stormy overcast sky, diffuse grey light",
        "torchlit_interior": "torchlit interior, warm flickering shadows",
        "lightning_flash": "lightning flash, high-contrast dramatic strobe",
    }
    hints_by_idx = {it["i"]: it for it in items_in}
    if isinstance(parsed, dict):
        items_out = parsed.get("items")
        if isinstance(items_out, list):
            for it in items_out:
                if not isinstance(it, dict):
                    continue
                try:
                    idx = int(it.get("i") or it.get("index") or 0)
                except (TypeError, ValueError):
                    continue
                v = it.get("v") or it.get("value") or it.get("prompt") or ""
                if not isinstance(v, str):
                    continue
                body = v.strip().strip('"').strip("'").rstrip(",;:.")
                if first_idx <= idx <= last_idx and len(body) >= 6:
                    src = hints_by_idx.get(idx)
                    if src is not None:
                        shot_phrase = _SHOT_TO_PHRASE.get(src["shot"], "")
                        palette_phrase = _PALETTE_TO_PHRASE.get(src["palette"], "")
                        tod_phrase = _TOD_TO_PHRASE.get(src["tod"], "")
                        # Append regardless of whether the LLM already
                        # included similar wording — the extra tokens are
                        # cheap and Z-Image weights later tokens slightly
                        # higher in CLIP-style encoders so they nudge
                        # composition without polluting the noun list.
                        extra = ", ".join(p for p in (shot_phrase, palette_phrase, tod_phrase) if p)
                        if extra:
                            body = f"{body}, {extra}"
                    by_index[idx] = body

    # v0.2.4 — Anti-repetition Jaccard pivot. La forced injection
    # (shot/palette/tod) varía composición pero los SUJETOS se repiten
    # ("aztec warrior" en items consecutivos). Si Jaccard de nouns entre
    # item_i e item_{i-1} > 0.55, prefijamos el body con un noun extraído
    # del setting_tag (topic-agnóstico) para forzar diversidad. El prefijo
    # da más peso al pivot en CLIP-style encoders.
    setting_nouns_list = sorted(_noun_set(setting_tag)) if setting_tag else []
    if setting_nouns_list:
        prev_set: set[str] | None = None
        prev_idx: int | None = None
        for idx in sorted(by_index.keys()):
            body = by_index[idx]
            cur_set = _noun_set(body)
            if prev_set is not None:
                j = _jaccard(cur_set, prev_set)
                if j > 0.55:
                    pivot_noun = setting_nouns_list[idx % len(setting_nouns_list)]
                    # Solo pivotamos si el noun NO está ya en el body
                    # (evita "azteca, azteca warrior, …").
                    if pivot_noun not in cur_set:
                        body = f"{pivot_noun}, {body}"
                        by_index[idx] = body
                        cur_set = _noun_set(body)
                        log_event(
                            "info", "image_diversity_pivot",
                            idx=idx, jaccard=round(j, 2), pivot=pivot_noun,
                        )
            prev_set = cur_set
            prev_idx = idx
    return by_index


async def _rewrite_image_prompts_from_narration(
    narration: str,
    markers: list[Marker],
    topic: str = "",
    setting_tag: str = "",
    context_brief: str = "",
    language_name: str = "English",
    model: str = "xianxia-llm",
    style_suffix: str | None = None,
) -> list[Marker]:
    """Replace each image prompt with one that literally describes the
    upcoming narration sentence, plus a forced shot-type rotation.

    Why: a small LLM (Gemma 4B abliterated) tends to drift into generic
    tropes regardless of the actual topic. By grounding the prompt in the
    post-marker text, every image illustrates the sentence the viewer is
    hearing while it's on screen — and stays faithful to the user's topic
    (egyptian, norse, sci-fi, etc.) instead of drifting toward a default
    aesthetic.

    The original LLM-authored prompt is appended (in low-weight position)
    only when it adds NEW information not already in the narration excerpt.
    """
    if not markers:
        return markers
    words = narration.split()
    n_words = len(words)
    if n_words == 0:
        return markers

    # v0.6.8 — log the actual setting_tag + extracted style_anchor so
    # future "imágenes iguales" complaints have hard evidence instead of
    # theory. The setting_tag is what dominates the CLIP prefix on every
    # beat; if it leaks iconography ("burning world-tree, ash palette")
    # the new _STYLE_ANCHOR_HAS_OBJECT guard now drops it and emits a
    # style_anchor_iconography_dropped warning here.
    _resolved_setting = setting_tag or _topic_setting_prefix(topic)
    log_event(
        "info",
        "image_prompt_rewrite_start",
        setting_tag=(setting_tag or "")[:200],
        topic_setting_fallback=bool(not setting_tag),
        style_anchor=_style_anchor(_resolved_setting)[:160],
    )

    # ── Pass 1 ─ collect the literal narration sentence for every
    # image marker, in order. Indexed parallel to `image_marker_indices`
    # so we can map distilled phrases back to the right markers.
    image_marker_indices: list[int] = []
    raw_literals: list[str] = []
    for idx, m in enumerate(markers):
        if m.kind != "image":
            continue
        word_at = int(m.timestamp_seconds * 150.0 / 60.0)
        word_at = max(0, min(word_at, n_words - 1))
        # v0.2.4 — ventana 35 words (~14 s a 150 wpm) en vez de 70. El window
        # anterior mezclaba 28 s de narración con sub-temas distintos, así que
        # el v field salía genérico ("aztec warrior temple ritual…"). 35 words
        # limita el contexto al sub-tema que el espectador realmente oye mientras
        # esta imagen está en pantalla.
        window = " ".join(words[word_at: word_at + 35])
        sentences = _SENTENCE_SPLIT.split(window, maxsplit=1)
        literal = sentences[0].strip()
        literal = literal.rstrip(",;:")
        if len(literal) > 220:
            literal = literal[:220].rsplit(" ", 1)[0]
        if not literal:
            literal = (m.prompt or "").strip()
        image_marker_indices.append(idx)
        raw_literals.append(literal)

    # ── Distillation step (v0.1.42) ─ convert the Spanish (or other
    # language) narration sentences into short English visual phrases.
    # This prevents Z-Image from rendering the Spanish sentence as
    # on-screen subtitle text (a recurring v0.1.41 bug) AND it lets us
    # naturally drop adaptation-leak keywords (Milo Thatch, Disney…)
    # before they ever reach the diffusion model.
    distilled = await _distill_visual_phrases(
        raw_literals, topic=topic, setting_tag=setting_tag,
        language_name=language_name, model=model,
    )
    # Safety: distillation must return the same number of phrases as
    # inputs (the helper falls back per-line on parse failure). If
    # somehow it diverges, drop back to raw literals.
    if len(distilled) != len(raw_literals):
        distilled = list(raw_literals)
    # v0.6.5 — deterministic SUBJECT diversification. The distiller is
    # faithful to each narration sentence; for a single-subject/abstract
    # topic that means the SAME headline subject every beat (the chronic
    # "muchas imágenes iguales" complaint). Pivot over-repeated beats to
    # distinct concrete facets mined from the Wikipedia brief + setting
    # tag — no LLM, deterministic index rotation.
    distilled = _enforce_subject_diversity(
        distilled, _facet_pool(context_brief, setting_tag, topic),
    )
    literal_by_marker_idx: dict[int, str] = {
        m_idx: distilled[i]
        for i, m_idx in enumerate(image_marker_indices)
    }

    # ── Pass 2 ─ compose the final prompt for each image marker.
    rotation_index = 0
    out: list[Marker] = []
    for idx, m in enumerate(markers):
        if m.kind != "image":
            out.append(m)
            continue
        literal = literal_by_marker_idx.get(idx, raw_literals[0] if raw_literals else "")
        # v0.1.40 — visual variety only via camera + lighting; NEVER
        # override what the narration is describing in this beat. The
        # camera/lighting indices walk asynchronously so two adjacent
        # images don't share both axes.
        camera_hint = _CAMERA_VARIATIONS[rotation_index % len(_CAMERA_VARIATIONS)]
        lighting_hint = _LIGHTING_VARIATIONS[
            (rotation_index * 7 + 4) % len(_LIGHTING_VARIATIONS)
        ]
        rotation_index += 1
        # Compose the final prompt: literal narrated subject + camera
        # variation + lighting variation + palette cue + style + NO-TEXT.
        #
        # v0.1.41 — the LLM-authored image marker body is DROPPED entirely.
        # In v0.1.40 we kept it as "supporting context" but Gemma kept
        # injecting shot-type labels ("CHARACTER SHOT —"), pop-culture
        # character archetypes ("Milo Thatch archetype"), and style
        # suffixes ("cinematic, photorealistic, …") into every marker.
        # Those tokens were the dominant signal in CLIP's encoding, so
        # every image came out as the same "young man portrait" or the
        # same "wide landscape". The literal narration sentence is
        # already in the prompt as the actual subject; we don't need
        # the LLM's prose noise on top.
        original_hint = ""
        # v0.1.35: vary palette per image. Earlier the palette_hint came
        # from the shot type tuple, which produced only 6 unique palettes
        # for the entire video. Now we rotate through a fuller set so
        # consecutive images don't share dominant tones (the "all images
        # look the same" complaint).
        palette_variant = _PALETTE_ROTATION[rotation_index % len(_PALETTE_ROTATION)]
        # v0.1.40 — narration-led prompt. The literal narrated subject
        # leads, so the diffusion model paints exactly what the viewer
        # is hearing. Setting tag anchors the world. Camera + lighting
        # variations sit AFTER the subject (CLIP still picks them up,
        # but they don't override the scene). NO-TEXT clause closes
        # every prompt to suppress diffusion's tendency to invent
        # fake inscriptions / signs / runes.
        # Order: setting → narrated subject → camera → lighting →
        #        original LLM hint → palette → style → no-text.
        # v0.2.9 — thin style anchor only (era+culture+palette), so the
        # concrete iconography objects don't get stamped on every beat.
        setting = setting_tag or _topic_setting_prefix(topic)
        head = _style_anchor(setting)
        body_parts = [literal]
        if original_hint:
            body_parts.append(original_hint.lstrip(", "))
        body_parts.append(camera_hint)
        body_parts.append(lighting_hint)
        body_parts.append(palette_variant)
        # v0.7.0 — preset-aware style suffix; None → legacy _STYLE_SUFFIX.
        _final_suffix = (style_suffix if style_suffix is not None else _STYLE_SUFFIX)
        body_parts.append(_final_suffix.rstrip(", "))
        body_parts.append(_NO_TEXT_CLAUSE)
        body = ", ".join(p for p in body_parts if p)
        prompt = f"{head}. {body}" if head else body
        # Z-Image CLIP truncates at ~77 tokens (~300 chars). Leave a bit
        # of headroom for the prefix to land cleanly inside the budget.
        if len(prompt) > 360:
            prompt = prompt[:360].rsplit(" ", 1)[0]
        out.append(Marker(
            seq=m.seq,
            kind=m.kind,
            timestamp_seconds=m.timestamp_seconds,
            prompt=prompt,
        ))
    return out


# ─── Topic suggestions + Hook tester (LLM-driven idea generation) ────

class SuggestRequest(BaseModel):
    # v0.1.28: default neutral. The UI passes the user's typed topic when
    # available; if it's empty we use a generic prompt that lets the LLM
    # propose mixed-genre ideas instead of falling back to xianxia.
    niche: str = "diverse storytelling"
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
    """LLM-driven topic generator. Returns N ideas with title + 1-line hook.

    v0.1.28: niche-aware. The previous version forced "Chinese mythology,
    cultivation, wuxia" into the system prompt regardless of `req.niche`,
    so a user typing "egyptian gods" got xianxia-flavoured suggestions
    back. Now the niche is honoured literally.
    """
    niche_clean = (req.niche or "diverse storytelling").strip()
    is_xianxia = any(
        h in niche_clean.lower()
        for h in ("xianxia", "wuxia", "cultivation", "daoist",
                  "chinese mytholog", "immortal sect")
    )
    if is_xianxia:
        flavour_hint = (
            "Mix epic battles, cultivation breakthroughs, demon lore, "
            "immortal romance, ancient wisdom, and forbidden techniques."
        )
    else:
        flavour_hint = (
            f"Stay strictly within the '{niche_clean}' theme. Mix iconic "
            "moments, lesser-known stories, dramatic conflicts, mysterious "
            "figures, turning points, and surprising facts that fit the topic."
        )
    system = (
        f"You are a viral YouTube/TikTok content strategist. The user's niche "
        f"is: {niche_clean}. For each idea, output a killer title + a "
        "1-sentence hook that grabs attention in <3 seconds. Every idea must "
        "be ON-TOPIC for that niche — do NOT drift into another genre or "
        "culture. Output ONLY valid JSON: "
        "{\"ideas\": [{\"title\": \"...\", \"hook\": \"...\", "
        "\"estimated_minutes\": 8-15}, ...]}. No preamble, no explanation."
    )
    prompt = (
        f"Generate {req.count} fresh video ideas in {req.language} about: {niche_clean}. "
        f"{flavour_hint} Avoid clichés. Be specific. Stay on topic."
    )
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            result = await llm_generate(
                model=req.model,
                system=system,
                prompt=prompt,
                format="json",
                options={"temperature": 0.85, "num_predict": 800, "num_ctx": 2048},
                think=False,
                max_continuations=0,
                client=client,
                timeout=180.0,
            )
            raw = result.get("response") or "{}"
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
            result = await llm_generate(
                model=req.model, system=system, prompt=prompt,
                format="json",
                options={"temperature": 0.9, "num_predict": 400, "num_ctx": 1024},
                think=False,
                max_continuations=0,
                client=client,
                timeout=120.0,
            )
            data = json.loads(result.get("response") or "{}")
            hooks = [
                Hook(text=str(h.get("text", "")).strip(), style=str(h.get("style", "promise")))
                for h in (data.get("hooks") or [])[:req.count]
            ]
            return HookTestResponse(hooks=hooks)
    except Exception as e:
        raise HTTPException(503, f"hook test failed: {e}") from e
