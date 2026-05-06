"""Auto-extract viral Shorts from a long-form video.

Two entry points:

  POST /shorts/auto
      Internal pipeline mode — caller passes video + pre-computed words array.
      Used by Phase 10 of the main generation pipeline (no double Whisper pass).

  POST /shorts/from_video
      OpusClip-style standalone mode — caller passes ONLY the MP4 path. We
      transcribe with faster-whisper, score with the local LLM, cut + reframe
      + burn captions ourselves. This is the "upload your existing video and
      get viral shorts" flow.

Pipeline (per Short):
  1. Group words into sentences by silence gaps (>0.4 s).
  2. Sliding window over sentence groups to find candidate segments
     of ~target_duration seconds (default 45 s).
  3. Score each candidate via a local LLM (xianxia-llm / Gemma 4) on:
       - hook_score (does the first sentence grab attention?)
       - climax_score (does it end on a cliffhanger / payoff?)
       - standalone_score (can it be understood without the rest?)
     Weighted total: 0.4·hook + 0.4·climax + 0.2·standalone.
  4. Pick top N non-overlapping segments.
  5. For each: ffmpeg-cut → 1080x1920 vertical crop → burn ASS karaoke
     with TikTok safe zones → sidechaincompress + loudnorm -14 LUFS.
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

from ..codec import best_video_encoder

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"


class Word(BaseModel):
    word: str
    start: float
    end: float


class ShortsAutoRequest(BaseModel):
    video_path: str
    words: list[Word]
    out_dir: str | None = None
    n_shorts: int = 3
    target_duration: float = 45.0
    min_duration: float = 25.0
    max_duration: float = 60.0
    model: str = "xianxia-llm"
    burn_subs: bool = True
    primary_language: str = "en"


class ShortInfo(BaseModel):
    output_path: str
    start_seconds: float
    duration_seconds: float
    hook_score: float
    climax_score: float
    standalone_score: float
    text_preview: str


class ShortsAutoResponse(BaseModel):
    shorts: list[ShortInfo]


def _group_into_sentences(words: list[Word], silence_gap: float = 0.4) -> list[dict]:
    """Group words into sentences by silence gaps. Returns
    [{start, end, text, n_words}, ...]."""
    if not words:
        return []
    sentences: list[dict] = []
    cur_start = words[0].start
    cur_text: list[str] = [words[0].word.strip()]
    last_end = words[0].end
    for w in words[1:]:
        gap = w.start - last_end
        if gap >= silence_gap:
            sentences.append({
                "start": cur_start, "end": last_end,
                "text": " ".join(cur_text).strip(), "n_words": len(cur_text),
            })
            cur_start = w.start
            cur_text = []
        cur_text.append(w.word.strip())
        last_end = w.end
    if cur_text:
        sentences.append({
            "start": cur_start, "end": last_end,
            "text": " ".join(cur_text).strip(), "n_words": len(cur_text),
        })
    return sentences


def _candidate_segments(sentences: list[dict], target: float, min_d: float, max_d: float) -> list[dict]:
    """Sliding window over sentences to build candidate segments. Each candidate
    starts at a sentence boundary and extends until the cumulative duration
    crosses target_duration (or max_duration cap).
    """
    candidates: list[dict] = []
    n = len(sentences)
    for i in range(n):
        start = sentences[i]["start"]
        text_parts: list[str] = []
        for j in range(i, n):
            text_parts.append(sentences[j]["text"])
            dur = sentences[j]["end"] - start
            if dur >= target:
                if dur <= max_d:
                    candidates.append({
                        "start": start, "end": sentences[j]["end"], "duration": dur,
                        "text": " ".join(text_parts), "anchor_idx": i, "end_idx": j,
                    })
                break
            if dur >= min_d and j == n - 1:
                # Final segment: shorter than target but still acceptable.
                candidates.append({
                    "start": start, "end": sentences[j]["end"], "duration": dur,
                    "text": " ".join(text_parts), "anchor_idx": i, "end_idx": j,
                })
    return candidates


async def _score_candidate(client: httpx.AsyncClient, model: str, text: str) -> dict:
    """LLM scoring. Returns dict with hook_score, climax_score, standalone_score
    (all 0-1). Falls back to uniform 0.5 if the LLM call fails."""
    system = (
        "You are an expert at finding viral short-form video segments from "
        "narrative scripts. Score the segment on three dimensions, each 0.0-1.0:\n"
        " - hook_score: does the first sentence grab attention (mystery, conflict, surprise)?\n"
        " - climax_score: does it end on a cliffhanger, revelation, or strong payoff?\n"
        " - standalone_score: can it be understood without the rest of the story?\n"
        "Output ONLY valid JSON with the three keys, no preamble, no explanation."
    )
    prompt = f"Segment text:\n\n{text[:1800]}\n\nReturn JSON now."
    try:
        r = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model, "system": system, "prompt": prompt, "stream": False,
                "format": "json",
                "options": {"temperature": 0.2, "num_predict": 80, "num_ctx": 2048},
            },
            timeout=60.0,
        )
        r.raise_for_status()
        raw = r.json().get("response", "{}")
        scores = json.loads(raw)
        return {
            "hook_score": float(scores.get("hook_score", 0.5)),
            "climax_score": float(scores.get("climax_score", 0.5)),
            "standalone_score": float(scores.get("standalone_score", 0.5)),
        }
    except Exception:
        return {"hook_score": 0.5, "climax_score": 0.5, "standalone_score": 0.5}


def _pick_top_non_overlapping(candidates: list[dict], n: int) -> list[dict]:
    """Greedy: take top-scored, then exclude all overlapping, repeat."""
    sorted_cand = sorted(candidates, key=lambda c: -c["score"])
    picked: list[dict] = []
    for c in sorted_cand:
        overlap = any(
            not (c["end"] <= p["start"] or c["start"] >= p["end"])
            for p in picked
        )
        if not overlap:
            picked.append(c)
            if len(picked) >= n:
                break
    picked.sort(key=lambda c: c["start"])
    return picked


def _cut_short(
    video_path: str,
    out_path: Path,
    start: float,
    duration: float,
    burn_ass_path: Path | None,
) -> None:
    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19",
            "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "4",
            "-pix_fmt", "yuv420p",
        ]
    else:
        encode_args = ["-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p"]

    # Vertical crop: take center column 9:16 from the source 16:9.
    # ih*9/16 = 1080 * 9/16 = 607.5 -> rounded by ffmpeg. For 1920×1080 source,
    # crop is 607x1080 then scale to 1080x1920.
    vf = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos+full_chroma_int+accurate_rnd"
    if burn_ass_path is not None and burn_ass_path.exists():
        # libass needs the file by basename + cwd workaround for Windows drive letters.
        vf += f",subtitles={burn_ass_path.name}"

    # Master loudness for mobile + sidechain ducking (no separate music track here,
    # source already has the mix; we just normalise).
    af = "loudnorm=I=-14:TP=-1.5:LRA=11"

    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-vf", vf,
        "-af", af,
        "-c:v", enc.codec_name,
        *encode_args,
        "-r", "60",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(out_path),
    ]
    cwd = str(burn_ass_path.parent) if burn_ass_path else None
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if proc.returncode != 0:
        raise HTTPException(500, f"shorts cut failed: {proc.stderr[-500:]}")


class ShortsFromVideoRequest(BaseModel):
    """Standalone mode — user supplies an existing MP4. We do everything else."""
    video_path: str
    out_dir: str | None = None
    n_shorts: int = 3
    target_duration: float = 45.0
    min_duration: float = 25.0
    max_duration: float = 60.0
    model: str = "xianxia-llm"
    burn_subs: bool = True
    primary_language: str | None = None  # auto-detect if None
    caption_style: str = "hormozi"  # default to viral style for Shorts


@router.post("/from_video", response_model=ShortsAutoResponse)
async def shorts_from_video(req: ShortsFromVideoRequest) -> ShortsAutoResponse:
    """OpusClip-style: upload an MP4, get N viral Shorts.

    1. Extract audio with FFmpeg → 16 kHz mono WAV (whisper input).
    2. faster-whisper transcribe with word-level timestamps.
    3. LLM-score candidate segments (Gemma 4 / xianxia-llm).
    4. Pick top N non-overlapping.
    5. FFmpeg cut → vertical crop → burn karaoke ASS with `caption_style`.
    """
    from ..models import whisper_model

    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video not found: {req.video_path}")
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out")) / "shorts-from-video"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Extract audio mono 16k for whisper
    audio_path = out_dir / f"audio-{uuid.uuid4().hex[:8]}.wav"
    extract = subprocess.run(
        ["ffmpeg", "-y", "-i", req.video_path,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
         str(audio_path)],
        capture_output=True, text=True,
    )
    if extract.returncode != 0:
        raise HTTPException(500, f"audio extract failed: {extract.stderr[-300:]}")

    # 2. Transcribe with word-level timestamps (auto-detect language if not given)
    try:
        model = whisper_model.load()
    except Exception as e:
        raise HTTPException(503, f"whisper not ready: {e}") from e
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=req.primary_language,  # None = auto-detect
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    segments_list = list(segments_iter)
    words: list[Word] = []
    for seg in segments_list:
        for w in (seg.words or []):
            words.append(Word(word=w.word, start=w.start, end=w.end))
    if not words:
        raise HTTPException(400, "transcription produced no words — is the video silent?")

    # 3-4. Reuse the candidate scoring + picking logic from /shorts/auto
    sentences = _group_into_sentences(words)
    candidates = _candidate_segments(
        sentences, req.target_duration, req.min_duration, req.max_duration,
    )
    if not candidates:
        raise HTTPException(400, "no candidate segments found in transcript")

    if len(candidates) > 12:
        step = len(candidates) // 12
        sampled = candidates[::step][:12]
    else:
        sampled = candidates

    async with httpx.AsyncClient() as client:
        for c in sampled:
            scores = await _score_candidate(client, req.model, c["text"])
            c.update(scores)
            c["score"] = (
                0.4 * c["hook_score"] + 0.4 * c["climax_score"] + 0.2 * c["standalone_score"]
            )
        sampled_starts = sorted([(c["start"], c) for c in sampled])
        for c in candidates:
            if "score" in c:
                continue
            nearest = min(sampled_starts, key=lambda kv: abs(kv[0] - c["start"]))[1]
            c.update(
                hook_score=nearest["hook_score"],
                climax_score=nearest["climax_score"],
                standalone_score=nearest["standalone_score"],
                score=nearest["score"] * 0.85,
            )

    picked = _pick_top_non_overlapping(candidates, req.n_shorts)

    # 5. Cut + reframe + burn each Short
    shorts: list[ShortInfo] = []
    for i, c in enumerate(picked):
        # Word subset for this Short
        seg_words = [
            {"word": w.word, "start": w.start - c["start"], "end": w.end - c["start"]}
            for w in words
            if c["start"] <= w.start <= c["end"]
        ]
        ass_path: Path | None = None
        if req.burn_subs and seg_words:
            from .subtitles import _word_karaoke_ass, LANG_FONTS
            font, size = LANG_FONTS.get(info.language or "en", ("Arial", 64))
            size = int(size * 1.25)  # vertical mode bump
            ass_path = out_dir / f"short-{i + 1:02d}.ass"
            ass_path.write_text(
                _word_karaoke_ass(seg_words, font, size, vertical=True, style=req.caption_style),
                encoding="utf-8",
            )

        out_path = out_dir / f"short-{i + 1:02d}-{uuid.uuid4().hex[:6]}.mp4"
        _cut_short(req.video_path, out_path, c["start"], c["duration"], ass_path)
        preview = c["text"][:120] + ("…" if len(c["text"]) > 120 else "")
        shorts.append(
            ShortInfo(
                output_path=str(out_path),
                start_seconds=c["start"],
                duration_seconds=c["duration"],
                hook_score=c["hook_score"],
                climax_score=c["climax_score"],
                standalone_score=c["standalone_score"],
                text_preview=preview,
            )
        )

    # Cleanup audio
    try: audio_path.unlink()
    except Exception: pass

    return ShortsAutoResponse(shorts=shorts)


@router.post("/auto", response_model=ShortsAutoResponse)
async def auto_shorts(req: ShortsAutoRequest) -> ShortsAutoResponse:
    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video not found: {req.video_path}")
    if not req.words:
        raise HTTPException(400, "words array is empty")

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out")) / "shorts"
    out_dir.mkdir(parents=True, exist_ok=True)

    sentences = _group_into_sentences(req.words)
    candidates = _candidate_segments(
        sentences, req.target_duration, req.min_duration, req.max_duration,
    )
    if not candidates:
        raise HTTPException(400, "no candidate segments found in transcript")

    # Score top candidates only — full enumeration is O(n²) and most segments
    # near each other will have similar scores. Sample evenly across the timeline.
    if len(candidates) > 12:
        step = len(candidates) // 12
        sampled = candidates[::step][:12]
    else:
        sampled = candidates

    async with httpx.AsyncClient() as client:
        for c in sampled:
            scores = await _score_candidate(client, req.model, c["text"])
            c.update(scores)
            c["score"] = (
                0.4 * c["hook_score"]
                + 0.4 * c["climax_score"]
                + 0.2 * c["standalone_score"]
            )
        # Backfill scores for non-sampled candidates using nearest-neighbour
        # heuristic: copy from the closest sampled candidate by start time.
        sampled_starts = sorted([(c["start"], c) for c in sampled])
        for c in candidates:
            if "score" in c:
                continue
            nearest = min(sampled_starts, key=lambda kv: abs(kv[0] - c["start"]))[1]
            c.update(
                hook_score=nearest["hook_score"],
                climax_score=nearest["climax_score"],
                standalone_score=nearest["standalone_score"],
                score=nearest["score"] * 0.85,  # penalty for being interpolated
            )

    picked = _pick_top_non_overlapping(candidates, req.n_shorts)

    shorts: list[ShortInfo] = []
    for i, c in enumerate(picked):
        out_path = out_dir / f"short-{i + 1:02d}-{uuid.uuid4().hex[:6]}.mp4"
        _cut_short(req.video_path, out_path, c["start"], c["duration"], None)
        preview = c["text"][:120] + ("…" if len(c["text"]) > 120 else "")
        shorts.append(
            ShortInfo(
                output_path=str(out_path),
                start_seconds=c["start"],
                duration_seconds=c["duration"],
                hook_score=c["hook_score"],
                climax_score=c["climax_score"],
                standalone_score=c["standalone_score"],
                text_preview=preview,
            )
        )
    return ShortsAutoResponse(shorts=shorts)
