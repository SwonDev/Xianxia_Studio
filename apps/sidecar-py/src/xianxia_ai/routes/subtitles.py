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
import uuid
from pathlib import Path
from typing import Iterable

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import whisper_model

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"

# ASS color format: &HAABBGGRR (alpha + BGR). These map to the Celestial Dark palette.
GOLD_FILL = "&H004CA8C9"        # #c9a84c
GOLD_HIGHLIGHT = "&H006DC9E8"   # #e8c96d (active word during karaoke)
JADE_OUTLINE = "&H001B4332"     # #324a1b → dark jade outline (we use jade-700)
SHADOW = "&H80000000"           # 50% black soft shadow

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
    if not Path(req.audio_path).exists():
        raise HTTPException(404, f"audio not found: {req.audio_path}")

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) Transcribe with faster-whisper (word-level timestamps required for karaoke)
    try:
        model = whisper_model.load()
    except Exception as e:
        raise HTTPException(503, f"whisper not ready: {e}") from e

    segments, info = model.transcribe(
        req.audio_path,
        language=req.source_language,
        word_timestamps=True,
        beam_size=5,
    )
    segments = list(segments)

    # 2) Source SRT
    src_srt = out_dir / f"subs-{req.source_language}.srt"
    src_srt.write_text(_segments_to_srt(segments), encoding="utf-8")

    # 3) Source ASS — word-level karaoke
    words = _flatten_words(segments)
    src_ass = out_dir / f"subs-{req.source_language}.ass"
    src_ass.write_text(
        _word_karaoke_ass(words, *LANG_FONTS.get(req.source_language, ("Arial", 64))),
        encoding="utf-8",
    )

    assets: list[SubtitleAsset] = [
        SubtitleAsset(
            language=req.source_language,
            srt_path=str(src_srt),
            ass_path=str(src_ass),
        )
    ]

    # 4) Translations + per-segment ASS for the rest
    src_entries = _parse_srt(src_srt.read_text(encoding="utf-8"))
    for lang in req.target_languages:
        if lang == req.source_language:
            continue
        translated_entries = await _translate_entries(
            src_entries, target=LANG_NAMES.get(lang, lang), model=req.model
        )
        srt_p = out_dir / f"subs-{lang}.srt"
        srt_p.write_text(_entries_to_srt(translated_entries), encoding="utf-8")
        ass_p = out_dir / f"subs-{lang}.ass"
        font, size = LANG_FONTS.get(lang, ("Arial", 60))
        ass_p.write_text(
            _segment_karaoke_ass(translated_entries, font, size),
            encoding="utf-8",
        )
        assets.append(
            SubtitleAsset(language=lang, srt_path=str(srt_p), ass_path=str(ass_p))
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


class BurnInResponse(BaseModel):
    out_path: str
    bytes: int


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
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf", f"subtitles={ass_path.name}",
        "-c:v", "libx264",
        "-preset", req.preset,
        "-crf", str(req.crf),
        "-c:a", "copy",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(cwd))
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {proc.stderr[-500:]}")
    return BurnInResponse(out_path=str(out_path), bytes=out_path.stat().st_size)


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
    out = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for start, end, body in entries:
            prompt = (
                f"Translate the following English narration sentence into {target}. "
                f"Output ONLY the translation, no preamble, no explanation, "
                f"no quotation marks. Keep the cinematic xianxia register.\n\n"
                f"English: {body}\n{target}:"
            )
            r = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.3, "num_ctx": 2048},
                },
            )
            r.raise_for_status()
            t = r.json().get("response", "").strip()
            t = re.sub(r"^[\"'`]+|[\"'`]+$", "", t)
            t = re.sub(r"^[A-Za-z一-鿿]+\s*[:：]\s*", "", t)
            t = t.split("\n")[0].strip()
            out.append((start, end, t))
    return out


def _ass_header(font: str, size: int) -> str:
    return (
        f"[Script Info]\n"
        f"Title: Xianxia Studio\n"
        f"ScriptType: v4.00+\n"
        f"Collisions: Normal\n"
        f"PlayResX: 1920\n"
        f"PlayResY: 1080\n"
        f"Timer: 100.0000\n"
        f"WrapStyle: 0\n\n"
        f"[V4+ Styles]\n"
        f"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        f"OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        f"ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        f"MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Xianxia,{font},{size},{GOLD_FILL},{GOLD_HIGHLIGHT},"
        f"{JADE_OUTLINE},{SHADOW},-1,0,0,0,100,100,0,0,1,4.5,2.5,2,80,80,90,1\n\n"
        f"[Events]\n"
        f"Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        f"MarginV, Effect, Text\n"
    )


def _word_karaoke_ass(words: list[dict], font: str, size: int, max_chars: int = 42) -> str:
    """Word-level karaoke ASS for source language (exact timestamps)."""
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
    for chunk in chunks:
        start = chunk[0]["start"]
        end = chunk[-1]["end"] + 0.15
        parts = []
        for w in chunk:
            dur_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
            parts.append(f"{{\\kf{dur_cs}}}{w['word'].strip()}")
        text = " ".join(parts)
        events.append(
            f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Xianxia,,0,0,0,,{{\\fad(180,180)}}{text}"
        )
    return _ass_header(font, size) + "\n".join(events) + "\n"


def _segment_karaoke_ass(entries, font: str, size: int) -> str:
    """Segment-level karaoke for translated text (no exact word timing)."""
    events = []
    for start, end, body in entries:
        words = body.split()
        if not words:
            continue
        total_chars = sum(len(w) for w in words) or 1
        total_secs = max(0.1, end - start)
        parts = []
        for w in words:
            dur_cs = max(1, int(round((len(w) / total_chars) * total_secs * 100)))
            parts.append(f"{{\\kf{dur_cs}}}{w}")
        text = " ".join(parts)
        events.append(
            f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end + 0.15)},Xianxia,,0,0,0,,{{\\fad(180,180)}}{text}"
        )
    return _ass_header(font, size) + "\n".join(events) + "\n"
