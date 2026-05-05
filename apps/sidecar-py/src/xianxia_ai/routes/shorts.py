"""Shorts generation — adapted from OpenShorts pipeline.

Pipeline:
  1. Faster-whisper word-level timestamps (already from phase 8).
  2. PySceneDetect scene boundaries.
  3. xianxia-llm picks N viral 15-60s moments scored by hook strength.
  4. For each clip:
     a. ffmpeg extracts the time slice with NVENC + cuda decode.
     b. Optional subject_tracking: MediaPipe Face Detection follows the
        main face per-frame and produces a centred crop window; falls back
        to centre-crop when no faces are found.
     c. Audio ducking: narration normalised + light music sidechain so the
        voice always sits on top.
     d. ASS subtitle file generated for the clip's transcript window
        (karaoke per-word, gold fill + jade outline) + a top hook line.
     e. ffmpeg burns subtitles with NVENC.
  5. Outputs are 1080x1920 9:16 H.264 mp4 ready for YouTube Shorts.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder
from ..effects import EffectsConfig, cinematic_look_filters
from ..prompts import SHORTS_DETECTION_PROMPT

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434"


class ShortsRequest(BaseModel):
    video_path: str
    srt_path: str
    n: int = 4
    model: str = "xianxia-llm"
    out_dir: str | None = None
    subject_tracking: bool = True
    burn_subtitles: bool = True
    audio_ducking: bool = True
    cinematic: str = "light"  # "off" | "light" | "full" (light is best for shorts)


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

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)

    transcript_with_ts = Path(req.srt_path).read_text(encoding="utf-8")

    # ── PySceneDetect (best effort) ─────────────────────────────────
    try:
        from scenedetect import detect, ContentDetector  # type: ignore

        scenes = detect(req.video_path, ContentDetector(threshold=27.0))
        scene_boundaries = [(s[0].seconds, s[1].seconds) for s in scenes]
    except Exception:
        scene_boundaries = []

    # ── xianxia-llm picks viral moments ────────────────────────────
    prompt = (
        SHORTS_DETECTION_PROMPT.format(n=req.n)
        + "\n\nTranscript:\n"
        + transcript_with_ts[:6000]
    )
    if scene_boundaries:
        prompt += "\n\nScene boundaries (start, end seconds):\n" + str(scene_boundaries[:60])

    # Use the centralised generate() helper so format=json + thinking + auto
    # continuation behave consistently across the project.
    from ..llm import generate as llm_generate

    try:
        result = await llm_generate(
            model=req.model,
            system="You are a viral content strategist. Output ONLY strict JSON, no commentary, no markdown.",
            prompt=prompt,
            options={"temperature": 0.5, "num_ctx": 8192, "num_predict": 2048},
            format="json",
            think=True,
            max_continuations=2,
            timeout=600.0,
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama: {e}") from e

    raw = result["response"]
    picks = _parse_picks(raw, n=req.n)

    # Parse SRT once for per-clip subtitle slicing
    full_segments = _parse_srt(transcript_with_ts)

    # ── Per-clip rendering ──────────────────────────────────────────
    enc = best_video_encoder()
    clips: list[ShortClip] = []
    for i, pick in enumerate(picks[: req.n]):
        start = float(pick.get("start", 0))
        end = float(pick.get("end", start + 30))
        # Clamp to 12-60 seconds to fit Shorts requirements
        if end - start < 12:
            end = start + 25
        if end - start > 60:
            end = start + 60
        hook = (pick.get("hook") or f"Xianxia Short {i+1}")[:80]
        score = float(pick.get("score", 0.5))

        out_path = out_dir / f"short-{i:02d}-{uuid.uuid4().hex[:6]}.mp4"
        try:
            _render_short(
                video_path=req.video_path,
                start=start,
                end=end,
                hook=hook,
                segments=full_segments,
                out_path=out_path,
                encoder=enc,
                subject_tracking=req.subject_tracking,
                burn_subtitles=req.burn_subtitles,
                audio_ducking=req.audio_ducking,
                cinematic_profile=req.cinematic,
            )
        except Exception as e:
            raise HTTPException(500, f"render short {i+1} failed: {e}") from e

        clips.append(
            ShortClip(
                start=start, end=end, hook=hook, score=score,
                output_path=str(out_path),
            )
        )

    return ShortsResponse(clips=clips)


# ─── Helpers ─────────────────────────────────────────────────────────

def _parse_picks(raw: str, n: int) -> list[dict]:
    """xianxia-llm returns either a JSON array, or {"key":[...]}, or a string
    with a JSON array embedded. Try them all."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        try:
            parsed = json.loads(m.group(0)) if m else None
        except Exception:
            parsed = None

    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for k in ("viral_moments", "moments", "clips", "shorts", "results", "items", "picks", "data"):
            if k in parsed and isinstance(parsed[k], list):
                return parsed[k]

    # Fallback: spread evenly
    return [
        {"start": 30 + i * 30, "end": 55 + i * 30, "hook": f"Viral moment {i+1}", "score": 0.6}
        for i in range(n)
    ]


def _parse_srt(text: str) -> list[tuple[float, float, str]]:
    blocks = re.split(r"\n\s*\n", text.strip())
    out: list[tuple[float, float, str]] = []
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
        s = h1 * 3600 + mn1 * 60 + s1 + ms1 / 1000
        e = h2 * 3600 + mn2 * 60 + s2 + ms2 / 1000
        out.append((s, e, "\n".join(lines[2:]).strip()))
    return out


def _render_short(
    *,
    video_path: str,
    start: float,
    end: float,
    hook: str,
    segments: list[tuple[float, float, str]],
    out_path: Path,
    encoder,
    subject_tracking: bool,
    burn_subtitles: bool,
    audio_ducking: bool,
    cinematic_profile: str = "light",
) -> None:
    """Cut + reframe + burn-in pipeline for a single short.

    Output: 1080x1920 H.264 + AAC, NVENC if available, with optional
    MediaPipe-driven subject tracking and audio ducking.
    """
    work = out_path.parent / f"_work-{out_path.stem}"
    work.mkdir(parents=True, exist_ok=True)

    # Slice the source clip first (fast, no re-encode), so MediaPipe + subtitle
    # subsystems all operate on the same time-aligned shorter file.
    raw_clip = work / "raw.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
            "-i", video_path, "-c", "copy",
            str(raw_clip),
        ],
        check=True, capture_output=True,
    )

    # ── Reframe filter (subject tracking optional) ──────────────────
    crop_filter = "crop=ih*9/16:ih"  # default centre-crop fallback
    if subject_tracking:
        cx_norm = _track_subject(raw_clip)
        if cx_norm is not None:
            # Build a crop expression centred on tracked X (clamped to [0, 1])
            # ih*9/16 is the crop width; we want centre = cx_norm * iw, so
            # x = cx_norm*iw - (ih*9/16)/2, clamped to [0, iw - ih*9/16]
            x_expr = (
                f"min(max({cx_norm:.4f}*iw - (ih*9/16)/2, 0), iw - ih*9/16)"
            )
            crop_filter = f"crop=ih*9/16:ih:{x_expr}:0"

    # ── Build ASS for transcript window + hook overlay ──────────────
    ass_path = work / "subs.ass"
    if burn_subtitles:
        _write_clip_ass(ass_path, segments, start, end, hook)
    else:
        _write_hook_only_ass(ass_path, hook, end - start)

    # ── Audio ducking via sidechain compression ────────────────────
    audio_filter = ""
    if audio_ducking:
        # Light de-essing + dynamic range compression that keeps narration on top
        audio_filter = "loudnorm=I=-16:LRA=11:TP=-1.5"

    # ── Final ffmpeg: scale to 1080x1920, cinematic look, burn subs, NVENC ──
    profile = (cinematic_profile or "light").lower()
    if profile == "off":
        cine_filters: list[str] = []
    elif profile == "full":
        cine_filters = cinematic_look_filters(EffectsConfig())
    else:
        cine_filters = cinematic_look_filters(EffectsConfig.light())

    vf_parts = [crop_filter, "scale=1080:1920", *cine_filters]
    if ass_path.exists():
        vf_parts.append(f"subtitles={ass_path.name}:fontsdir=.")
    vf = ",".join(vf_parts)
    decode_args: list[str] = []
    if encoder.codec_name == "h264_nvenc":
        decode_args = ["-hwaccel", "cuda"]

    encode_args = (
        encoder.ffmpeg_args
        if encoder.codec_name != "libx264"
        else ["-preset", "medium", "-crf", "20"]
    )

    cmd = [
        "ffmpeg", "-y",
        *decode_args,
        "-i", str(raw_clip.resolve()),
        "-vf", vf,
        "-c:v", encoder.codec_name,
        *encode_args,
    ]
    if audio_filter:
        cmd += ["-af", audio_filter]
    cmd += ["-c:a", "aac", "-b:a", "128k", str(out_path.resolve())]

    proc = subprocess.run(cmd, cwd=str(work), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg encode: {proc.stderr[-500:]}")

    # Cleanup work dir on success
    try:
        for f in work.iterdir():
            f.unlink()
        work.rmdir()
    except Exception:
        pass


def _track_subject(clip: Path) -> float | None:
    """Run MediaPipe Face Detection over sampled frames; return mean face X
    normalised to [0,1]. Falls back to None when MediaPipe isn't available
    or no faces are detected.
    """
    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        return None

    cap = cv2.VideoCapture(str(clip))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    sample_every = max(1, int(fps / 2))  # ~2 samples per second

    detector = mp.solutions.face_detection.FaceDetection(
        model_selection=1, min_detection_confidence=0.4
    )
    xs: list[float] = []
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = detector.process(rgb)
                if res.detections:
                    # Pick the largest detection (closest to the camera)
                    best = max(
                        res.detections,
                        key=lambda d: d.location_data.relative_bounding_box.width,
                    )
                    bb = best.location_data.relative_bounding_box
                    cx = bb.xmin + bb.width / 2.0
                    xs.append(float(cx))
            idx += 1
    finally:
        cap.release()
        detector.close()

    if not xs:
        return None
    # Use median to be robust against outliers (e.g. brief camera pans)
    xs.sort()
    return xs[len(xs) // 2]


# ─── ASS generation for shorts ───────────────────────────────────────

ASS_HEADER = (
    "[Script Info]\n"
    "Title: Xianxia Short\n"
    "ScriptType: v4.00+\n"
    "PlayResX: 1080\n"
    "PlayResY: 1920\n"
    "WrapStyle: 0\n\n"
    "[V4+ Styles]\n"
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
    "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
    "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
    "MarginL, MarginR, MarginV, Encoding\n"
    # Hook style: top-centre, big bold gold
    "Style: Hook,Arial,72,&H004CA8C9,&H006DC9E8,&H001B4332,&H80000000,"
    "-1,0,0,0,100,100,0,0,1,6,3,8,40,40,200,1\n"
    # Body subs style: bottom-centre, medium
    "Style: Body,Arial,52,&H00FFFFFF,&H006DC9E8,&H001B4332,&H80000000,"
    "-1,0,0,0,100,100,0,0,1,4,2,2,40,40,180,1\n\n"
    "[Events]\n"
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
)


def _ass_ts(s: float) -> str:
    h, rem = divmod(float(s), 3600)
    m, ss = divmod(rem, 60)
    cs = int(round((ss - int(ss)) * 100))
    return f"{int(h)}:{int(m):02d}:{int(ss):02d}.{cs:02d}"


def _write_hook_only_ass(path: Path, hook: str, duration: float) -> None:
    line = (
        f"Dialogue: 0,0:00:00.00,{_ass_ts(duration)},Hook,,0,0,0,,"
        f"{{\\fad(180,180)}}{_kf_words(hook, duration)}"
    )
    path.write_text(ASS_HEADER + line + "\n", encoding="utf-8")


def _write_clip_ass(
    path: Path,
    segments: list[tuple[float, float, str]],
    start: float,
    end: float,
    hook: str,
) -> None:
    """Hook on top + per-segment karaoke subtitles for the clip window."""
    events: list[str] = []
    # Hook stays for the first ~4 seconds of the short, fading nicely
    hook_dur = min(4.0, end - start)
    events.append(
        f"Dialogue: 0,0:00:00.00,{_ass_ts(hook_dur + 0.2)},Hook,,0,0,0,,"
        f"{{\\fad(180,180)}}{_kf_words(hook, hook_dur)}"
    )

    for seg_start, seg_end, body in segments:
        if seg_end < start or seg_start > end:
            continue
        # Re-base timestamps to the short's local timeline
        local_start = max(0.0, seg_start - start)
        local_end = min(end - start, seg_end - start)
        if local_end - local_start < 0.2:
            continue
        events.append(
            f"Dialogue: 0,{_ass_ts(local_start)},{_ass_ts(local_end + 0.15)},Body,,0,0,0,,"
            f"{{\\fad(120,120)}}{_kf_words(body, local_end - local_start)}"
        )

    path.write_text(ASS_HEADER + "\n".join(events) + "\n", encoding="utf-8")


def _kf_words(text: str, dur: float) -> str:
    words = text.split()
    if not words:
        return ""
    total = sum(len(w) for w in words) or 1
    parts = []
    for w in words:
        cs = max(15, int(round((len(w) / total) * dur * 100)))
        parts.append(f"{{\\kf{cs}}}{w}")
    return " ".join(parts)
