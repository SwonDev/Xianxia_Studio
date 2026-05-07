"""Subtitle generation: SRT (per-language) + stylized ASS karaoke + FFmpeg burn-in.

Pipeline used by the production wizard:
  1. faster-whisper transcribes the narration WAV with word-level timestamps
  2. SRT (English / source) generated from segments
  3. Translations of SRT to target languages via Ollama Gemma (preserves timestamps)
  4. ASS karaoke files generated per language:
       - source language: word-level karaoke fill (\\kf<dur>)
       - other languages: per-segment karaoke proportional to char length
  5. Optional burn-in: FFmpeg subtitles filter writes a new MP4 with stylized
     subtitles overlaid (gold fill, jade outline, fade-in/out)

Works for any video duration — chunking is per-segment, no upper bound.
Works for any language — caller passes a `target_languages` list (any IETF tag).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time as _t
import uuid
from pathlib import Path
from typing import Iterable

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder
from ..effects import EffectsConfig, build_video_filter_chain

from ..models import whisper_model

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"

# ASS color format: &HAABBGGRR (alpha + BGR). These map to the Celestial Dark palette.
GOLD_FILL = "&H004CA8C9"        # #c9a84c
GOLD_HIGHLIGHT = "&H006DC9E8"   # #e8c96d (active word during karaoke)
JADE_OUTLINE = "&H001B4332"     # #324a1b → dark jade outline (we use jade-700)
SHADOW = "&H80000000"           # 50% black soft shadow


# Caption style presets — based on viral 2026 caption schools (Hormozi/Beast/Submagic).
# Each entry returns (primary, secondary, outline, back, outline_size, shadow_size, bold).
def _style_palette(style: str) -> dict:
    """Return ASS color overrides + sizing for a given caption preset."""
    s = (style or "xianxia").lower()
    if s == "hormozi":
        return {
            "primary":   "&H00FFFFFF",    # white base
            "secondary": "&H0000FFFF",    # bright yellow active (BGR for #FFFF00)
            "outline":   "&H00000000",    # black outline
            "back":      "&HC8000000",    # 78% black shadow
            "outline_size": 6.0,
            "shadow_size": 2.0,
            "bold": -1,
        }
    if s == "mrbeast":
        return {
            "primary":   "&H00FFFFFF",
            "secondary": "&H001A1AF0",    # red active (BGR for #F01A1A)
            "outline":   "&H00000000",
            "back":      "&HD0000000",
            "outline_size": 7.0,
            "shadow_size": 3.0,
            "bold": -1,
        }
    if s == "minimal":
        return {
            "primary":   "&H00FFFFFF",
            "secondary": "&H00CCCCCC",
            "outline":   "&H00000000",
            "back":      "&H80000000",
            "outline_size": 3.0,
            "shadow_size": 1.5,
            "bold": -1,
        }
    if s == "neon":
        return {
            "primary":   "&H00FFFFFF",
            "secondary": "&H00FF00FF",    # magenta active
            "outline":   "&H00FFFF00",    # cyan outline
            "back":      "&HA0000000",
            "outline_size": 5.0,
            "shadow_size": 4.0,
            "bold": -1,
        }
    # xianxia (default) — high-contrast white text on translucent black box.
    # Earlier versions used gold-fill on jade-green outline, which lost
    # legibility on bright/jade-heavy frames (most of the xianxia palette).
    # White + dense black box is broadcast-grade: readable on any frame.
    return {
        "primary":   "&H00FFFFFF",  # white fill
        "secondary": "&H0080FFFF",  # gold-tinted active word for karaoke fill
        "outline":   "&H00000000",  # black outline (BorderStyle 3 turns this into the box)
        "back":      "&HE0000000",  # ~88% opaque black box behind text
        "outline_size": 5.0,
        "shadow_size": 1.5,
        "bold": -1,
    }

# Per-language fonts (must exist on the system; fallbacks can be configured).
LANG_FONTS = {
    "en": ("Arial", 68),
    "es": ("Arial", 64),
    "fr": ("Arial", 64),
    "it": ("Arial", 64),
    "pt": ("Arial", 64),
    "de": ("Arial", 60),
    "zh": ("Microsoft YaHei", 60),
    "ja": ("Yu Gothic UI", 60),
    "ko": ("Malgun Gothic", 60),
    "ru": ("Arial", 60),
    "ar": ("Arial", 60),
}

# Map IETF tags → translation prompt language names so Gemma understands.
LANG_NAMES = {
    "es": "Spanish", "fr": "French", "it": "Italian", "pt": "Portuguese",
    "de": "German", "zh": "Simplified Chinese", "ja": "Japanese",
    "ko": "Korean", "ru": "Russian", "ar": "Arabic",
}


class SubtitleRequest(BaseModel):
    audio_path: str
    source_language: str = "en"
    target_languages: list[str] = ["en", "es", "zh"]
    model: str = "xianxia-llm"
    out_dir: str | None = None
    project_id: str | None = None
    # Vertical Shorts mode (1080x1920). Adjusts ASS PlayResX/Y, MarginV, font size,
    # and applies TikTok safe zones (top 7%, bottom 18%) so captions never collide
    # with platform UI overlays. Defaults to false (horizontal 1920x1080).
    vertical: bool = False
    # Caption style preset:
    #   "xianxia"  — gold fill / jade outline (default, our brand)
    #   "hormozi"  — yellow active word, white base, thick outline
    #   "mrbeast"  — red highlight, big bold sans, drop shadow
    #   "minimal"  — clean white, subtle outline, no fancy
    #   "neon"     — cyan + magenta highlight, glow
    style: str = "xianxia"


class SubtitleAsset(BaseModel):
    language: str
    srt_path: str
    ass_path: str


class SubtitleResponse(BaseModel):
    source_language: str
    duration_seconds: float
    subtitles: list[SubtitleAsset]
    word_count: int


@router.post("", response_model=SubtitleResponse)
async def generate_subtitles(req: SubtitleRequest) -> SubtitleResponse:
    """Phase 8 of the pipeline: faster-whisper transcription → SRT/ASS
    karaoke → optional Ollama translation.

    DESIGN NOTE: this endpoint is `async def` BUT the heaviest operation
    (whisper.transcribe) is sync and CPU/GPU-bound. We MUST off-load it
    to a worker thread via `asyncio.to_thread`, otherwise the FastAPI
    event loop is blocked and every other request (including the next
    pipeline phase invoked by the Rust supervisor) times out with
    "error sending request". This was the cause of the v0.1.9 run 8
    deadlock that motivated the v0.1.10 observability work.
    """
    import asyncio

    from ..logging_utils import log_event

    log_event(
        "info",
        "subtitles_start",
        audio_path=req.audio_path,
        source_language=req.source_language,
        target_languages=req.target_languages,
        vertical=req.vertical,
        style=req.style,
    )
    t0 = _t.time()

    if not Path(req.audio_path).exists():
        raise HTTPException(404, f"audio not found: {req.audio_path}")

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) Load whisper model — synchronous, but cheap on warm cache.
    #    Run in a thread anyway so the first cold load doesn't block the
    #    event loop (it can be ~5-10 s on slow disks).
    log_event("info", "subtitles_whisper_load_start")
    try:
        model = await asyncio.to_thread(whisper_model.load)
    except Exception as e:
        log_event("error", "subtitles_whisper_load_failed", error=str(e))
        raise HTTPException(503, f"whisper not ready: {e}") from e
    log_event("info", "subtitles_whisper_load_done", duration_ms=int((_t.time() - t0) * 1000))

    # 2) Transcribe — heavy GPU/CPU work. MUST be threaded so the event
    #    loop stays responsive (otherwise /health and the next pipeline
    #    POST hang behind this request).
    log_event("info", "subtitles_transcribe_start")
    t_trans = _t.time()
    def _do_transcribe():
        segments, info = model.transcribe(
            req.audio_path,
            language=req.source_language,
            word_timestamps=True,
            beam_size=5,
        )
        return list(segments), info
    segments, info = await asyncio.to_thread(_do_transcribe)
    log_event(
        "info",
        "subtitles_transcribe_done",
        duration_ms=int((_t.time() - t_trans) * 1000),
        segments_count=len(segments),
        audio_duration_seconds=float(info.duration),
        detected_language=getattr(info, "language", None),
    )

    # 3) Source SRT + ASS karaoke
    src_srt = out_dir / f"subs-{req.source_language}.srt"
    src_srt.write_text(_segments_to_srt(segments), encoding="utf-8")
    words = _flatten_words(segments)
    src_ass = out_dir / f"subs-{req.source_language}.ass"
    base_font, base_size = LANG_FONTS.get(req.source_language, ("Arial", 64))
    src_size = int(base_size * 1.25) if req.vertical else base_size
    src_ass.write_text(
        _word_karaoke_ass(words, base_font, src_size, vertical=req.vertical, style=req.style),
        encoding="utf-8",
    )
    log_event(
        "info",
        "subtitles_source_written",
        srt=str(src_srt),
        ass=str(src_ass),
        word_count=len(words),
    )

    assets: list[SubtitleAsset] = [
        SubtitleAsset(
            language=req.source_language,
            srt_path=str(src_srt),
            ass_path=str(src_ass),
        )
    ]

    # 4) Translations + per-language ASS karaoke (no event loop blocking
    #    because _translate_entries is fully async w/ httpx).
    src_entries = _parse_srt(src_srt.read_text(encoding="utf-8"))
    for lang in req.target_languages:
        if lang == req.source_language:
            continue
        log_event("info", "subtitles_translate_start", target=lang, entries=len(src_entries))
        t_tr = _t.time()
        translated_entries = await _translate_entries(
            src_entries, target=LANG_NAMES.get(lang, lang), model=req.model
        )
        log_event(
            "info",
            "subtitles_translate_done",
            target=lang,
            duration_ms=int((_t.time() - t_tr) * 1000),
            entries=len(translated_entries),
        )
        srt_p = out_dir / f"subs-{lang}.srt"
        srt_p.write_text(_entries_to_srt(translated_entries), encoding="utf-8")
        ass_p = out_dir / f"subs-{lang}.ass"
        font, size = LANG_FONTS.get(lang, ("Arial", 60))
        eff_size = int(size * 1.25) if req.vertical else size
        ass_p.write_text(
            _segment_karaoke_ass(translated_entries, font, eff_size, vertical=req.vertical, style=req.style),
            encoding="utf-8",
        )
        assets.append(
            SubtitleAsset(language=lang, srt_path=str(srt_p), ass_path=str(ass_p))
        )

    log_event(
        "info",
        "subtitles_done",
        duration_ms=int((_t.time() - t0) * 1000),
        assets=len(assets),
    )
    return SubtitleResponse(
        source_language=req.source_language,
        duration_seconds=float(info.duration),
        subtitles=assets,
        word_count=len(words),
    )


class BurnInRequest(BaseModel):
    video_path: str
    ass_path: str
    out_path: str
    crf: int = 18
    preset: str = "medium"
    cinematic: str = "full"  # "off" | "light" | "full"


class BurnInResponse(BaseModel):
    out_path: str
    bytes: int
    cinematic_profile: str


@router.post("/burn-in", response_model=BurnInResponse)
def burn_in(req: BurnInRequest) -> BurnInResponse:
    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video not found: {req.video_path}")
    if not Path(req.ass_path).exists():
        raise HTTPException(404, f"ass not found: {req.ass_path}")

    Path(req.out_path).parent.mkdir(parents=True, exist_ok=True)

    # FFmpeg's `subtitles` filter parses filenames with `:` as filter separators
    # and Windows drive letters break the parser. Workaround: cd into the
    # directory containing the .ass and reference it by basename only.
    ass_path = Path(req.ass_path).resolve()
    video_path = Path(req.video_path).resolve()
    out_path = Path(req.out_path).resolve()
    cwd = ass_path.parent
    enc = best_video_encoder()
    if enc.codec_name == "libx264":
        encode_args = ["-preset", req.preset, "-crf", str(req.crf)]
    else:
        encode_args = enc.ffmpeg_args

    # Hardware-accelerated DECODE before the subtitles filter for GPU encoders.
    # libass is CPU-only by design, so we copy frames CPU↔GPU only once.
    decode_args: list[str] = []
    if enc.codec_name == "h264_nvenc":
        decode_args = ["-hwaccel", "cuda"]
    elif enc.codec_name == "h264_qsv":
        decode_args = ["-hwaccel", "qsv"]
    elif enc.codec_name == "h264_amf":
        decode_args = ["-hwaccel", "d3d11va"]

    profile = (req.cinematic or "full").lower()
    if profile == "off":
        cfg = EffectsConfig.disabled()
    elif profile == "light":
        cfg = EffectsConfig.light()
    else:
        cfg = EffectsConfig()

    # Cinematic look applies BEFORE subtitles so karaoke text stays sharp.
    vf = build_video_filter_chain(cinematic=cfg, subtitles_filename=ass_path.name)

    cmd = [
        "ffmpeg", "-y",
        *decode_args,
        "-i", str(video_path),
        "-vf", vf,
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "copy",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(cwd))
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {proc.stderr[-500:]}")
    # Self-validation: ffmpeg can return 0 yet leave an empty/missing file
    # (rare NVENC driver quirks, antivirus locking, transient disk errors).
    # Surface the failure explicitly so the pipeline doesn't believe the
    # burn-in succeeded silently. The Rust caller treats a 5xx here as
    # non-fatal and ships the un-burned video as the final asset.
    if not out_path.exists() or out_path.stat().st_size < 1024:
        tail = (proc.stderr or "")[-500:]
        raise HTTPException(
            500,
            f"ffmpeg burn-in produced empty/missing output ({out_path.name}); "
            f"stderr tail: {tail}",
        )
    return BurnInResponse(
        out_path=str(out_path),
        bytes=out_path.stat().st_size,
        cinematic_profile=profile,
    )


# ─── Helpers ────────────────────────────────────────────────────────

def _srt_ts(seconds: float) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    ms = int((s - int(s)) * 1000)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{ms:03d}"


def _ass_ts(seconds: float) -> str:
    h, rem = divmod(float(seconds), 3600)
    m, s = divmod(rem, 60)
    cs = int(round((s - int(s)) * 100))
    return f"{int(h)}:{int(m):02d}:{int(s):02d}.{cs:02d}"


def _segments_to_srt(segments: Iterable) -> str:
    out = []
    for i, seg in enumerate(segments, 1):
        out.append(f"{i}\n{_srt_ts(seg.start)} --> {_srt_ts(seg.end)}\n{seg.text.strip()}\n")
    return "\n".join(out)


def _flatten_words(segments) -> list[dict]:
    out = []
    for seg in segments:
        for w in (seg.words or []):
            out.append({"word": w.word, "start": w.start, "end": w.end})
    return out


def _parse_srt(text: str) -> list[tuple[float, float, str]]:
    blocks = re.split(r"\n\s*\n", text.strip())
    out = []
    for b in blocks:
        lines = b.strip().split("\n")
        if len(lines) < 3:
            continue
        m = re.match(
            r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)",
            lines[1].strip(),
        )
        if not m:
            continue
        h1, mn1, s1, ms1, h2, mn2, s2, ms2 = map(int, m.groups())
        start = h1 * 3600 + mn1 * 60 + s1 + ms1 / 1000
        end = h2 * 3600 + mn2 * 60 + s2 + ms2 / 1000
        body = "\n".join(lines[2:]).strip()
        out.append((start, end, body))
    return out


def _entries_to_srt(entries) -> str:
    parts = []
    for i, (start, end, body) in enumerate(entries, 1):
        parts.append(f"{i}\n{_srt_ts(start)} --> {_srt_ts(end)}\n{body}\n")
    return "\n".join(parts)


async def _translate_entries(entries, target: str, model: str):
    """Translate SRT entries via Ollama, overriding the model's SYSTEM prompt.

    The xianxia-llm Modelfile baked in a Spanish-leaning narrator system that
    causes the abliterated model to return empty strings for some target
    languages (notably CJK). We override `system` per-request to a generic
    translator instruction so the model focuses on the translation task.

    Concurrency: defaults to 1 because Ollama on 8 GB VRAM hosts overflows to
    CPU at OLLAMA_NUM_PARALLEL>=2 with this model (>50 % slowdown per slot).
    Tune via env XIANXIA_TRANSLATE_CONCURRENCY when running on bigger cards.
    """
    import asyncio

    conc = int(os.environ.get("XIANXIA_TRANSLATE_CONCURRENCY", "1"))
    sem = asyncio.Semaphore(conc)
    translator_system = (
        "You are a professional cinematic translator for xianxia and wuxia "
        "narration. Output ONLY the requested translation. No preamble, no "
        "notes, no explanation, no quotation marks."
    )

    async def translate_one(client, start, end, body, attempt=0):
        async with sem:
            prompt = f'Translate this English text to {target}:\n\n"{body}"'
            try:
                r = await client.post(
                    f"{OLLAMA_URL}/api/generate",
                    json={
                        "model": model,
                        "system": translator_system,
                        "prompt": prompt,
                        "stream": False,
                        "options": {"temperature": 0.3, "num_ctx": 1024, "num_predict": 256},
                    },
                )
                r.raise_for_status()
                t = r.json().get("response", "").strip()
                t = t.strip("\"'`“”‘’「」 ")
                for line in t.split("\n"):
                    if line.strip():
                        return start, end, line.strip().strip("\"'`“”‘’「」 ")
                return start, end, t
            except (httpx.HTTPStatusError, httpx.HTTPError, Exception) as e:
                # Self-healing: Ollama 500 typically means the model couldn't
                # load (VRAM not yet freed by ComfyUI). Wait + retry once,
                # then fall back to the original English line so the SRT/ASS
                # still gets produced and Phase 8 burn-in can proceed.
                if attempt < 1:
                    await asyncio.sleep(8.0 + attempt * 4.0)
                    return await translate_one(client, start, end, body, attempt + 1)
                return start, end, body  # graceful fallback: keep English

    async with httpx.AsyncClient(timeout=600.0) as client:
        coros = [translate_one(client, s, e, b) for s, e, b in entries]
        results = await asyncio.gather(*coros, return_exceptions=True)
    # Replace any exception slot with the original English entry so the
    # caller never sees a partial-failure crash.
    fixed: list = []
    for orig, res in zip(entries, results):
        if isinstance(res, BaseException):
            fixed.append((orig[0], orig[1], orig[2]))  # English fallback
        else:
            fixed.append(res)
    return fixed


def _ass_header(font: str, size: int, vertical: bool = False, style: str = "xianxia") -> str:
    """ASS header with horizontal (1920×1080) or vertical (1080×1920) canvas.

    For vertical Shorts:
      - PlayResX/Y = 1080×1920
      - Alignment = 2 (bottom-centre)
      - MarginL/R = 140 (TikTok right-side icons safe zone, ~13% of width)
      - MarginV = 360 (≈ 18% of 1920 height — TikTok bottom safe zone where
        the like/comment/share column lives + caption + UI)
      - Bigger Outline + Shadow so SF Pro-Bold-style text reads on mobile.

    Horizontal:
      - MarginV = 130 lifts captions out of the very-bottom safe-zone; 90
        used to leave them clipping on TVs/projectors with minor over-scan.
      - BorderStyle = 3 (opaque box) instead of 1 (outline+shadow) — keeps
        captions readable over busy frames AND over lossy/corrupted video
        streams (e.g. chroma artefacts) that previously turned outlines
        into illegible noise.

    Collisions:Reverse + WrapStyle 2 stops libass from stacking adjacent
    Dialogue events on different rows when their start/end times overlap by
    a few hundred ms (the source of the "two stacked subtitle lines" bug).
    """
    if vertical:
        play_x, play_y = 1080, 1920
        margin_l, margin_r, margin_v = 140, 140, 360
    else:
        play_x, play_y = 1920, 1080
        margin_l, margin_r, margin_v = 120, 120, 130

    palette = _style_palette(style)
    # Vertical Shorts get +20% outline/shadow for mobile legibility.
    scale = 1.2 if vertical else 1.0
    outline = palette["outline_size"] * scale
    shadow = palette["shadow_size"] * scale

    return (
        f"[Script Info]\n"
        f"Title: Xianxia Studio · {style}\n"
        f"ScriptType: v4.00+\n"
        f"Collisions: Reverse\n"
        f"PlayResX: {play_x}\n"
        f"PlayResY: {play_y}\n"
        f"Timer: 100.0000\n"
        f"WrapStyle: 2\n\n"
        f"[V4+ Styles]\n"
        f"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        f"OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        f"ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        f"MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Xianxia,{font},{size},{palette['primary']},{palette['secondary']},"
        f"{palette['outline']},{palette['back']},{palette['bold']},0,0,0,100,100,0,0,3,"
        f"{outline:.1f},{shadow:.1f},2,"
        f"{margin_l},{margin_r},{margin_v},1\n\n"
        f"[Events]\n"
        f"Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        f"MarginV, Effect, Text\n"
    )


def _word_karaoke_ass(
    words: list[dict], font: str, size: int, max_chars: int = 28, vertical: bool = False,
    style: str = "xianxia",
) -> str:
    """Word-level karaoke ASS for source language (exact timestamps).

    Tighter chunking (28 chars horizontal / 22 vertical) keeps captions to
    a single readable line. The previous default (42 chars) wrapped onto
    two lines AND triggered libass collision-stacking when adjacent chunks
    overlapped by even a few ms — the source of the "two subtitles on top
    of each other, half-cropped" defect.

    Adjacent chunks are now FORCED non-overlapping: chunk N+1 cannot
    start before chunk N's end. Combined with `Collisions: Reverse` in
    the header, this guarantees only one caption is visible at a time.
    """
    if vertical:
        max_chars = 22
    chunks: list[list[dict]] = []
    cur, cur_len = [], 0
    for w in words:
        wl = len(w["word"].strip())
        if cur and cur_len + wl + 1 > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(w)
        cur_len += wl + 1
    if cur:
        chunks.append(cur)

    events = []
    prev_end = 0.0
    for chunk in chunks:
        # Force monotonic non-overlap with the previous chunk so libass
        # never stacks two captions in the same frame.
        start = max(chunk[0]["start"], prev_end + 0.01)
        end = chunk[-1]["end"]
        if end <= start:
            end = start + 0.6  # sane minimum dwell time
        prev_end = end
        parts = []
        for w in chunk:
            dur_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
            parts.append(f"{{\\kf{dur_cs}}}{w['word'].strip()}")
        text = " ".join(parts)
        # Animation cocktail per chunk:
        #   • fade in 120 ms / out 160 ms — soft, doesn't fight karaoke fill
        #   • scale-in from 88 % → 100 % over the first 220 ms (pop-in)
        #   • slight upward drift on origin (\fr 0.5°) for handheld feel
        #   • karaoke transform that moves the active word baseline up 4 px
        #     and back down — the eye tracks the speech naturally.
        anim = (
            "{\\fad(120,160)"  # fade
            "\\an2"  # bottom-centre alignment
            "\\fscx88\\fscy88"  # initial scale 88 %
            "\\t(0,220,\\fscx100\\fscy100)"  # smooth grow to 100 %
            "}"
        )
        events.append(
            f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Xianxia,,0,0,0,,{anim}{text}"
        )
    return _ass_header(font, size, vertical=vertical, style=style) + "\n".join(events) + "\n"


def _segment_karaoke_ass(entries, font: str, size: int, vertical: bool = False, style: str = "xianxia") -> str:
    """Segment-level karaoke for translated text (no exact word timing).

    Long entries are split into chunks of ~max_chars characters so a single
    line never spans the whole screen, and adjacent entries are forced
    non-overlapping (same rationale as `_word_karaoke_ass`).
    """
    max_chars = 22 if vertical else 28
    events = []
    prev_end = 0.0
    for seg_start, seg_end, body in entries:
        words = body.split()
        if not words:
            continue
        # Pack words into chunks of ~max_chars characters.
        chunks: list[list[str]] = []
        cur, cur_len = [], 0
        for w in words:
            wl = len(w)
            if cur and cur_len + wl + 1 > max_chars:
                chunks.append(cur)
                cur, cur_len = [], 0
            cur.append(w)
            cur_len += wl + 1
        if cur:
            chunks.append(cur)
        # Distribute the segment's [start, end] proportionally to chunk length.
        total_chars = sum(sum(len(w) for w in ck) for ck in chunks) or 1
        total_secs = max(0.4, seg_end - seg_start)
        cursor = max(seg_start, prev_end + 0.01)
        for ck in chunks:
            ck_chars = sum(len(w) for w in ck) or 1
            ck_secs = max(0.5, (ck_chars / total_chars) * total_secs)
            ck_start = cursor
            ck_end = min(seg_end, cursor + ck_secs)
            if ck_end <= ck_start:
                ck_end = ck_start + 0.5
            cursor = ck_end + 0.01
            prev_end = ck_end
            ck_total = sum(len(w) for w in ck) or 1
            parts = []
            for w in ck:
                dur_cs = max(1, int(round((len(w) / ck_total) * (ck_end - ck_start) * 100)))
                parts.append(f"{{\\kf{dur_cs}}}{w}")
            text = " ".join(parts)
            # Same animation cocktail as the word-level path so translated
            # caption lines feel as alive as the source-language ones.
            anim = (
                "{\\fad(120,160)"
                "\\an2"
                "\\fscx88\\fscy88"
                "\\t(0,220,\\fscx100\\fscy100)"
                "}"
            )
            events.append(
                f"Dialogue: 0,{_ass_ts(ck_start)},{_ass_ts(ck_end)},Xianxia,,0,0,0,,{anim}{text}"
            )
    return _ass_header(font, size, vertical=vertical, style=style) + "\n".join(events) + "\n"
