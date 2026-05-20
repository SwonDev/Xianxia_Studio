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

import asyncio
import logging

log = logging.getLogger("xianxia.shorts")

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


# Terminal punctuation that ends a spoken sentence (incl. CJK + ES ¿¡).
_SENTENCE_END = tuple(".!?…。！？")


def _group_into_sentences(
    words: list[Word],
    silence_gap: float = 0.4,
    max_sentence_dur: float = 12.0,
) -> list[dict]:
    """Group words into sentences. Returns [{start,end,text,n_words}, ...].

    v0.2.12 — split on THREE signals, not just silence:
      1. silence gap ≥ `silence_gap` (original behaviour)
      2. the previous word ends with terminal punctuation (. ! ? …)
      3. the running sentence would exceed `max_sentence_dur`

    Why: continuous TTS-clone narration has almost no ≥0.4 s pauses, so
    the old gap-only split collapsed a whole 4-min video into 1-3
    mega-"sentences" each LONGER than a short's max_duration (60 s).
    `_candidate_segments` then could not fit a single window and the
    route 400'd with "no candidate segments found in transcript" (real
    failure 2026-05-16). Punctuation gives true sentence boundaries
    regardless of TTS fluency; the duration cap is a content-agnostic
    safety net so sentences are ALWAYS short enough to window.
    """
    if not words:
        return []

    def _ends_sentence(tok: str) -> bool:
        t = tok.strip().strip('"\'»”’)')
        return bool(t) and t.endswith(_SENTENCE_END)

    sentences: list[dict] = []
    cur_start = words[0].start
    cur_text: list[str] = [words[0].word.strip()]
    last_end = words[0].end
    prev_word = words[0].word
    for w in words[1:]:
        gap = w.start - last_end
        running_dur = last_end - cur_start
        boundary = (
            gap >= silence_gap
            or _ends_sentence(prev_word)
            or running_dur >= max_sentence_dur
        )
        if boundary and cur_text:
            sentences.append({
                "start": cur_start, "end": last_end,
                "text": " ".join(cur_text).strip(), "n_words": len(cur_text),
            })
            cur_start = w.start
            cur_text = []
        cur_text.append(w.word.strip())
        last_end = w.end
        prev_word = w.word
    if cur_text:
        sentences.append({
            "start": cur_start, "end": last_end,
            "text": " ".join(cur_text).strip(), "n_words": len(cur_text),
        })
    return sentences


def _candidate_segments(sentences: list[dict], target: float, min_d: float, max_d: float) -> list[dict]:
    """Sliding window over sentences. v0.1.22 final: instead of one
    candidate of length ≈ `target` per anchor, emit MULTIPLE candidates
    of varying durations (≈ 18 s, 28 s, 40 s, 52 s, ≤ max_d). The
    scoring layer then picks the one that maximises viral score
    × visual coherence (face presence × scene-cut density), so the
    final length is whatever the CONTENT calls for, not a hard-coded
    target. The user explicitly asked for this — "los shorts duran lo
    que tengan que durar para ser generados según el contenido lo
    mejor posible".
    """
    bucket_targets = sorted(set([
        max(min_d, 18.0),
        max(min_d, 28.0),
        max(min_d, 40.0),
        max(min_d, 52.0),
        min(max_d, max(min_d + 0.1, target)),
    ]))
    bucket_targets = [t for t in bucket_targets if min_d <= t <= max_d]

    candidates: list[dict] = []
    seen: set[tuple[int, int]] = set()
    n = len(sentences)
    for i in range(n):
        start_t = sentences[i]["start"]
        text_parts: list[str] = []
        for bucket in bucket_targets:
            text_parts = []
            best_j = -1
            best_dur = 0.0
            for j in range(i, n):
                text_parts.append(sentences[j]["text"])
                dur = sentences[j]["end"] - start_t
                if dur > max_d:
                    break
                if dur >= bucket:
                    best_j = j
                    best_dur = dur
                    break
                if j == n - 1 and dur >= min_d:
                    best_j = j
                    best_dur = dur
            if best_j < 0:
                continue
            key = (i, best_j)
            if key in seen:
                continue
            seen.add(key)
            candidates.append({
                "start": start_t,
                "end": sentences[best_j]["end"],
                "duration": best_dur,
                "text": " ".join(s["text"] for s in sentences[i:best_j + 1]),
                "anchor_idx": i,
                "end_idx": best_j,
            })

    # v0.2.12 — safety net: never return empty when there IS a usable
    # transcript. If the sliding window produced nothing (e.g. every
    # sentence longer than max_d on a pathological transcript), build
    # ONE best-effort candidate by accumulating sentences from the start
    # up to max_d (or all of them), as long as it clears min_d. The
    # scorer/reframer handle the rest. Beats a hard 400 that kills the
    # whole Shorts feature.
    if not candidates and sentences:
        acc_end_idx = 0
        for j in range(n):
            if sentences[j]["end"] - sentences[0]["start"] <= max_d:
                acc_end_idx = j
            else:
                break
        dur = sentences[acc_end_idx]["end"] - sentences[0]["start"]
        if dur >= min_d or acc_end_idx == n - 1:
            candidates.append({
                "start": sentences[0]["start"],
                "end": sentences[acc_end_idx]["end"],
                "duration": dur,
                "text": " ".join(
                    s["text"] for s in sentences[: acc_end_idx + 1]
                ),
                "anchor_idx": 0,
                "end_idx": acc_end_idx,
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
        from ..llm import generate as llm_generate
        result = await llm_generate(
            model=model, system=system, prompt=prompt,
            format="json",
            options={"temperature": 0.2, "num_predict": 80, "num_ctx": 2048},
            think=False,
            max_continuations=0,
            client=client,
            timeout=60.0,
        )
        raw = result.get("response") or "{}"
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


def _detect_scene_cuts(video_path: str, threshold: float = 18.0) -> list[float]:
    """v0.1.22 A3: list scene-cut timestamps (in seconds) using
    PySceneDetect's content detector. We use these later to snap
    candidate clip starts/ends to natural visual boundaries — instead
    of cold-opening mid-shot or cutting mid-action.

    Returns an empty list if scene detection fails (the function is
    purely a quality multiplier; the pipeline still works without it).
    """
    try:
        from scenedetect import open_video, SceneManager, ContentDetector  # type: ignore
        video = open_video(video_path)
        sm = SceneManager()
        sm.add_detector(ContentDetector(threshold=threshold))
        sm.detect_scenes(video=video, show_progress=False)
        scene_list = sm.get_scene_list()
        # scene_list is [(FrameTimecode start, FrameTimecode end), ...]
        cuts: list[float] = []
        for s_start, _ in scene_list:
            cuts.append(float(s_start.get_seconds()))
        cuts = sorted(set(round(c, 3) for c in cuts))
        try:
            log.info("shorts.scenes detected %d scene cuts", len(cuts))
        except Exception:
            pass
        return cuts
    except Exception as exc:
        try:
            log.warning("shorts.scenes detection failed (%s) - skipping snap", exc)
        except Exception:
            pass
        return []


# ── v0.2.15: black cold-open guard ─────────────────────────────────────────
# A viral Short lives or dies in its first second. Narrative videos open
# with a ~6 s animated title card over PURE BLACK (render.ts INTRO_SEC) and
# the first illustrative image stays dark a beat longer, so a clip cut from
# the start cold-opens on black → instant swipe. This guard probes the
# candidate's opening with ffmpeg `blackdetect` and advances the start past
# any near-black lead-in so every Short opens on a bright frame. Fully
# content-agnostic (works for ANY uploaded video, not just ours) and
# best-effort (any failure leaves the candidate untouched).
def _black_leadin_seconds(video_path: str, start: float, max_probe: float) -> float:
    """Seconds of near-black at [start, …). 0.0 if it already opens bright
    or detection fails. Only counts a black run that begins AT the clip
    start (a fade-from-black / dark intro) — never a mid-clip dark beat."""
    if max_probe <= 0.2:
        return 0.0
    try:
        cmd = [
            "ffmpeg", "-hide_banner", "-nostats",
            "-ss", f"{max(0.0, start):.3f}",
            "-t", f"{max_probe:.3f}",
            "-i", video_path,
            # pix_th = per-pixel luma ceiling (0-1); default pic_th=0.98
            # means ≥98 % of pixels under that luma → a near-black frame.
            # (NOT pic_th here — that's the picture fraction, not the
            # pixel threshold; conflating them flags every dim frame.)
            "-vf", "blackdetect=d=0.10:pix_th=0.10",
            "-an", "-f", "null", "-",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        out = (proc.stderr or "") + (proc.stdout or "")
        best_end = 0.0
        for m in re.finditer(r"black_start:([0-9.]+)\s+black_end:([0-9.]+)", out):
            bs = float(m.group(1))
            be = float(m.group(2))
            if bs <= 0.35 and be > best_end:  # a lead-in, not a mid beat
                best_end = be
        return best_end
    except Exception as exc:  # noqa: BLE001
        try:
            log.warning("shorts.black-guard probe failed (%s) - skipping", exc)
        except Exception:
            pass
        return 0.0


def _guard_black_open(
    video_path: str,
    c: dict,
    words: list | None,
    min_dur: float,
) -> None:
    """Advance a candidate past a near-black lead-in so the Short OPENS on
    a bright frame. Mutates `c` in place (start, duration, text). Caps the
    trim so we never eat the payload: ≤ half the clip, ≤ 8 s, and the
    remainder must stay ≥ min_dur. Never raises."""
    try:
        start = float(c["start"])
        end = float(c["end"])
        dur = end - start
        if dur < 8.0:
            return
        cap = min(8.0, dur * 0.5, max(0.0, dur - float(min_dur)))
        if cap < 0.4:
            return
        lead = _black_leadin_seconds(video_path, start, cap + 0.5)
        lead = min(lead, cap)
        if lead < 0.4:
            return
        new_start = start + lead
        c["start"] = new_start
        c["duration"] = end - new_start
        # Re-derive the visible text from the words that survive the trim
        # so the LLM hook reflects the REAL opening line, not a sentence
        # that's now off-screen before the clip even starts.
        if words:
            kept = [
                w.word for w in words
                if new_start <= w.start <= end
            ]
            if kept:
                c["text"] = " ".join(kept).strip()
        try:
            log.info(
                "shorts.black-guard trimmed %.2fs dark cold-open "
                "(start %.2f→%.2f dur=%.2f)",
                lead, start, new_start, c["duration"],
            )
        except Exception:
            pass
    except Exception as exc:  # noqa: BLE001
        try:
            log.warning("shorts.black-guard skipped (%s)", exc)
        except Exception:
            pass


def _snap_to_scene_cuts(
    cuts: list[float],
    t_start: float,
    t_end: float,
    tolerance: float = 2.0,
) -> tuple[float, float]:
    """Snap a candidate's [start, end] to the nearest scene-cut
    boundary inside ±tolerance seconds. If no cut is in range, the
    original timestamps are returned unchanged.

    Snapping the START is the high-value win (avoids cold-opening
    mid-shot). Snapping the END is gentler (gives the audio a natural
    breath at sentence finale) — only snapped when a cut sits AFTER
    the proposed end, never before, so we never truncate the speaker.
    """
    if not cuts:
        return t_start, t_end
    new_start = t_start
    best = min(cuts, key=lambda c: abs(c - t_start))
    if abs(best - t_start) <= tolerance:
        new_start = best
    new_end = t_end
    candidates_after = [c for c in cuts if c > t_end and c - t_end <= tolerance]
    if candidates_after:
        new_end = candidates_after[0]
    return new_start, new_end


def _face_presence_map(
    video_path: str,
    duration: float,
    sample_hz: float = 1.0,
) -> dict[float, bool]:
    """Sample the video every 1 s with the same Haar cascade used in
    smart-reframe and return {timestamp_seconds: True/False} for face
    presence. Used to penalise candidate segments that sit entirely
    over face-less stretches (this is what produced the user's "first
    image of mountains and a guy with no head" complaint — the picked
    clip had zero faces during its first 30 s).
    """
    presence: dict[float, bool] = {}
    try:
        # cv2 is imported lazily inside the function so the FastAPI
        # boot path doesn't crash when the OpenCV wheel is missing
        # (still allows everything else in this router to load).
        import cv2  # type: ignore
        cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        profile = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_profileface.xml"
        )
        if cascade.empty():
            return {}
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {}
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        step = max(1, int(round(fps / max(0.1, sample_hz))))
        idx = 0
        # Read sequentially, sample every `step` frames. Same anti-hang
        # pattern as Pass 1 of _smart_reframe_to_vertical.
        while idx < total_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                ts = round(idx / fps, 3)
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                gray = cv2.equalizeHist(gray)
                faces = cascade.detectMultiScale(
                    gray, scaleFactor=1.20, minNeighbors=4,
                    minSize=(80, 80), flags=cv2.CASCADE_SCALE_IMAGE,
                )
                if len(faces) == 0 and not profile.empty():
                    faces = profile.detectMultiScale(
                        gray, scaleFactor=1.20, minNeighbors=4,
                        minSize=(80, 80),
                    )
                presence[ts] = len(faces) > 0
            idx += 1
        cap.release()
        try:
            n_with = sum(1 for v in presence.values() if v)
            log.info(
                "shorts.face_presence sampled %d ts, %d with face (%.0f%%)",
                len(presence), n_with,
                100.0 * n_with / max(1, len(presence)),
            )
        except Exception:
            pass
        return presence
    except Exception as exc:
        try:
            log.warning("shorts.face_presence failed (%s)", exc)
        except Exception:
            pass
        return {}


def _scene_cut_density_score(
    scene_cuts: list[float],
    t_start: float,
    t_end: float,
) -> float:
    """v0.1.22 final: penalises segments with too many scene cuts
    inside them. A 60 s candidate that crosses 9 cuts (i.e. 0.15
    cuts/s) reads as "imágenes que no tienen que ver con lo que se
    está hablando" because each shot lasts only ~6 s before the
    image jumps to something else while the narrator keeps talking.

    Returns a multiplier:
      - cuts/s ≤ 0.05 → 1.10 (visual stability bonus)
      - 0.05 < cuts/s ≤ 0.15 → linear 1.10 → 0.85
      - cuts/s > 0.15 → 0.55 (heavy penalty)
    """
    if not scene_cuts:
        return 1.0
    inside = sum(1 for c in scene_cuts if t_start < c < t_end)
    duration = max(0.1, t_end - t_start)
    rate = inside / duration
    if rate <= 0.05:
        return 1.10
    if rate >= 0.20:
        return 0.55
    if rate <= 0.15:
        # 0.05 → 1.10, 0.15 → 0.85
        return 1.10 - (rate - 0.05) * 2.5
    # 0.15 → 0.85, 0.20 → 0.55
    return 0.85 - (rate - 0.15) * 6.0


def _face_presence_score(
    presence: dict[float, bool],
    t_start: float,
    t_end: float,
) -> float:
    """Fraction of sampled timestamps inside [t_start, t_end] that
    contain a face. 0.0 = no faces in clip, 1.0 = faces every sample.
    Used as a multiplicative bonus to avoid picking face-less stretches.
    """
    if not presence:
        return 0.5  # neutral when we don't have data
    samples = [v for ts, v in presence.items() if t_start <= ts <= t_end]
    if not samples:
        return 0.0
    return sum(1 for v in samples if v) / float(len(samples))


NODE_SIDECAR_URL = "http://127.0.0.1:8732"


def _cut_short(
    video_path: str,
    out_path: Path,
    start: float,
    duration: float,
    burn_ass_path: Path | None,
    *,
    enhanced_words: list[dict] | None = None,
    enhanced_hook: str | None = None,
    enhanced_cta_title: str | None = None,
    enhanced_cta_sub: str | None = None,
    scene_cuts: list[float] | None = None,
) -> None:
    """Cut a vertical Short out of a horizontal source.

    OpusClip-style smart reframing: per-frame ROI tracking (mediapipe
    face detection + OpenCV saliency fallback), EMA-smoothed pan
    trajectory, adaptive zoom (1.0×–1.4× depending on ROI size). Falls
    back to the legacy center-crop when the source is already vertical
    or when CV libs aren't available.

    Two finishing modes after the smart reframe:

    1. **Enhanced (preferred)** — when `enhanced_words` is provided
       (Whisper word-level timings on the clip's local timeline) and
       the Node sidecar is reachable. Pipes the reframed clip into the
       HyperFrames `short.html` v2 composition: animated word-by-word
       captions with active-token highlight, hook overlay with pop-in,
       progress bar, and CTA card. Captions are NATIVELY rendered by
       Chromium (no libass quemado) for crisper edges.

    2. **Legacy ASS burn-in** — when no enhanced payload is given.
       Burns the supplied ASS karaoke into the reframed clip with a
       second FFmpeg pass.

    On any error in mode 1 the function falls back to mode 2 (or the
    plain center-crop if the smart reframe itself fails) so a Short is
    always produced — never silently broken.
    """
    src_w, src_h = _probe_dimensions(video_path)
    target_ar = 9.0 / 16.0
    src_ar = src_w / src_h if src_h else 1.0
    use_enhanced = bool(enhanced_words)

    if src_ar <= target_ar * 1.05:
        # Source is already 9:16 (or close). Center crop is fine here.
        _cut_short_center_crop(video_path, out_path, start, duration, burn_ass_path)
        return

    try:
        # First try the smart path (mediapipe + saliency tracking).
        # On any failure (missing libs, codec issue, etc.) we fall
        # through to the legacy center-crop so a Short is always
        # produced — never silently broken.
        intermediate = out_path.with_suffix(".reframed.mp4")
        _smart_reframe_to_vertical(
            video_path,
            intermediate,
            start=start,
            duration=duration,
            src_w=src_w,
            src_h=src_h,
            scene_cuts=scene_cuts,
        )
        if not intermediate.exists() or intermediate.stat().st_size < 1024:
            raise RuntimeError("smart reframe produced empty file")

        if use_enhanced:
            try:
                _render_enhanced_short_via_hyperframes(
                    clip_path=intermediate,
                    out_path=out_path,
                    duration=duration,
                    words=enhanced_words or [],
                    hook=enhanced_hook or "",
                    cta_title=enhanced_cta_title,
                    cta_sub=enhanced_cta_sub,
                )
                try:
                    intermediate.unlink()
                except OSError:
                    pass
                return
            except Exception as exc:
                log.warning(
                    "enhanced HyperFrames render failed (%s); "
                    "falling back to ASS burn-in",
                    exc,
                )

        # Burn-in pass on the already-vertical reframed clip.
        if burn_ass_path is not None and burn_ass_path.exists():
            _burn_subs_into_vertical(intermediate, out_path, burn_ass_path)
            try:
                intermediate.unlink()
            except OSError:
                pass
        else:
            intermediate.replace(out_path)
        return
    except Exception as exc:
        log.warning(
            "smart reframe failed (%s); falling back to center crop", exc
        )
        _cut_short_center_crop(video_path, out_path, start, duration, burn_ass_path)


def _render_enhanced_short_via_hyperframes(
    *,
    clip_path: Path,
    out_path: Path,
    duration: float,
    words: list[dict],
    hook: str,
    cta_title: str | None,
    cta_sub: str | None,
) -> None:
    """POST the smart-reframed clip + word timings + hook to the Node
    sidecar so HyperFrames can compose the animated captions and hook
    overlay. Times in `words` are CLIP-LOCAL (starting at 0 = clip
    start), not source-video-absolute — the caller already shifted them.
    """
    import httpx

    payload: dict = {
        "clip_path": str(clip_path),
        "duration": float(duration),
        "hook": hook[:80],
        "out_path": str(out_path),
        "words": [
            {
                "w": str(w.get("word", "")).strip(),
                "s": max(0.0, float(w.get("start", 0.0))),
                "e": max(
                    float(w.get("start", 0.0)) + 0.05,
                    float(w.get("end", 0.0)),
                ),
            }
            for w in words
            if str(w.get("word", "")).strip()
        ],
    }
    if cta_title:
        payload["cta_title"] = cta_title[:40]
    if cta_sub:
        payload["cta_sub"] = cta_sub[:90]

    with httpx.Client(timeout=httpx.Timeout(60 * 30.0, connect=10.0)) as client:
        r = client.post(f"{NODE_SIDECAR_URL}/render/short", json=payload)
        r.raise_for_status()

    if not out_path.exists() or out_path.stat().st_size < 1024:
        raise RuntimeError(
            "Node /render/short returned 200 but output file is empty/missing",
        )


_CTA_DEFAULTS: dict[str, dict[str, str]] = {
    # title (≤40 chars) + sub (≤90 chars) per detected source language.
    "en": {"title": "FOLLOW",     "sub": "▶ Watch the full story on the channel"},
    "es": {"title": "SUSCRÍBETE", "sub": "▶ Más historias en el canal"},
    "zh": {"title": "关注一下",   "sub": "▶ 完整故事在频道"},
    "ja": {"title": "登録する",   "sub": "▶ 完全な物語はチャンネルで"},
    "ko": {"title": "구독하기",   "sub": "▶ 채널에서 전체 이야기 보기"},
    "de": {"title": "ABONNIEREN", "sub": "▶ Die ganze Geschichte im Kanal"},
    "fr": {"title": "S'ABONNER",  "sub": "▶ L'histoire complète sur la chaîne"},
    "it": {"title": "ISCRIVITI",  "sub": "▶ La storia completa sul canale"},
    "pt": {"title": "INSCREVA-SE","sub": "▶ A história completa no canal"},
    "ru": {"title": "ПОДПИСКА",   "sub": "▶ Полная история на канале"},
}


_HOOK_SYSTEM_PROMPT = (
    "You are a viral YouTube Shorts hook writer. Given a transcript "
    "snippet of a clip, output ONE attention-grabbing hook line of "
    "4 to 8 words MAXIMUM in the SAME LANGUAGE as the transcript. "
    "Use shock, curiosity, or a bold promise — never a polite intro. "
    "Output ONLY the hook line, no quotes, no preamble, no markdown."
)


async def _generate_short_hook(
    client: httpx.AsyncClient, model: str, transcript: str, fallback: str = "",
) -> str:
    """Ask Gemma for a 4–8 word viral hook in the transcript's language.

    Returns the cleaned hook string or `fallback` (typically the first
    sentence of the clip) on any error so a Short is always produced.
    """
    snippet = (transcript or "").strip()[:600]
    if not snippet:
        return fallback
    try:
        from ..llm import generate as llm_generate
        result = await llm_generate(
            model=model,
            system=_HOOK_SYSTEM_PROMPT,
            prompt=f"Transcript: {snippet}\n\nHook:",
            options={
                "temperature": 0.9,
                "num_predict": 64,
                "num_ctx": 1024,
            },
            think=False,
            max_continuations=0,
            client=client,
            timeout=60.0,
        )
        text = (result.get("response") or "").strip()
        # Strip surrounding quotes / brackets / preamble fragments the
        # model sometimes leaks in despite the system prompt.
        for prefix in ("Hook:", "HOOK:", "hook:", "•", "-", "*"):
            if text.startswith(prefix):
                text = text[len(prefix):].strip()
        text = text.strip("\"'`“”‘’«»()[]{}")
        # Take the first non-empty line; Gemma occasionally appends a
        # second alternative.
        text = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        # Cap to ~80 chars so the on-screen hook always fits one line.
        if len(text) > 80:
            text = text[:80].rsplit(" ", 1)[0]
        return text or fallback
    except Exception as exc:
        log.warning("hook generation failed (%s); using fallback", exc)
        return fallback


def _probe_dimensions(video_path: str) -> tuple[int, int]:
    """Return (width, height) of the source. Uses ffprobe to avoid
    spinning up an OpenCV cap for a single property read."""
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0",
                video_path,
            ],
            text=True,
        ).strip()
        w, h = (int(x) for x in out.split(","))
        return w, h
    except Exception:
        return 1920, 1080


def _cut_short_center_crop(
    video_path: str,
    out_path: Path,
    start: float,
    duration: float,
    burn_ass_path: Path | None,
) -> None:
    """Legacy fallback — naive center crop. Kept for safety when smart
    reframing isn't available (no mediapipe / no saliency / etc.)."""
    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19",
            "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "4",
            "-pix_fmt", "yuv420p",
        ]
    else:
        encode_args = ["-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p"]

    # v0.1.22 B2: replace the naive center-crop with a "GENERAL"
    # blur-fill composition. Two streams from the same source:
    #   [bg] = scaled-up cover, hard cropped to 1080×1920, then a
    #          20 px box-blur. Looks like a soft cinematic backdrop.
    #   [fg] = original aspect, scaled to 1080 px wide, centered.
    # The eye reads the blurred bg as ambient background and the
    # sharp fg as the actual content — way more cinematic than a
    # cropped subject with the sides chopped off.
    vf_filter = (
        "[0:v]split=2[bg][fg];"
        "[bg]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,boxblur=20:1[blurred];"
        "[fg]scale=1080:-2:flags=lanczos[centered];"
        "[blurred][centered]overlay=(W-w)/2:(H-h)/2[v]"
    )
    if burn_ass_path is not None and burn_ass_path.exists():
        vf_filter = vf_filter.replace("[v]", "[v0]") + f";[v0]subtitles={burn_ass_path.name}[v]"

    af = "loudnorm=I=-14:TP=-1.5:LRA=11"

    cmd = [
        "ffmpeg", "-y",
        "-hide_banner", "-nostats", "-loglevel", "error",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-filter_complex", vf_filter,
        "-map", "[v]",
        "-map", "0:a:0?",
        "-af", af,
        "-c:v", enc.codec_name,
        *encode_args,
        "-r", "60",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        str(out_path),
    ]
    cwd = str(burn_ass_path.parent) if burn_ass_path else None
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if proc.returncode != 0:
        raise HTTPException(500, f"shorts cut failed: {proc.stderr[-500:]}")


def _smart_reframe_to_vertical(
    src_video: str,
    out_video: Path,
    *,
    start: float,
    duration: float,
    src_w: int,
    src_h: int,
    scene_cuts: list[float] | None = None,
) -> None:
    """OpusClip-style smart vertical reframe.

    Pass 1: sample ~5 fps, detect dominant ROI (face → saliency fallback),
    record (cx, cy, roi_size) per sample.
    Smooth: EMA alpha=0.15 on (cx, cy, zoom). Zoom = 1.0 + 0.4*(1-ROI),
    clamped to [1.0, 1.45].
    Pass 2: re-read frames in order, crop window = (src_h/zoom)*9/16 ×
    (src_h/zoom), centered on smoothed (cx, cy), Lanczos-resize to
    1080×1920, pipe rawvideo into ffmpeg which muxes the source audio
    slice. NVENC encoded; the burn-in is a separate ffmpeg pass on the
    output of this function.

    All vertical ROI vertical movement clamped to inside the source frame
    (no black bars, no stretching).
    """
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    OUT_W, OUT_H = 1080, 1920
    TARGET_AR = OUT_W / OUT_H  # 0.5625

    cap = cv2.VideoCapture(src_video)
    if not cap.isOpened():
        raise RuntimeError(f"cv2 cannot open {src_video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if fps <= 0 or fps > 240:
        fps = 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    start_f = max(0, int(round(start * fps)))
    end_f = min(total - 1 if total > 0 else int((start + duration) * fps),
                int(round((start + duration) * fps)))

    # ── Face detection via OpenCV Haar cascades (v0.1.22). Mediapipe's
    #    legacy `mp.solutions` API was removed in 0.10.x and the new
    #    Tasks API needs a separate .tflite asset; meanwhile the user's
    #    test video had subjects with cabezas cortadas because the
    #    detector silently failed and the centered fallback produced
    #    bad crops. Haar cascades are bundled with cv2 (zero install),
    #    fast on CPU (~3-8 ms per 1080p frame), and accurate enough to
    #    keep characters centered for OpusClip-style reframing.
    face_cascade = None
    profile_cascade = None
    try:
        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        profile_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_profileface.xml"
        )
        if face_cascade.empty() or profile_cascade.empty():
            face_cascade = None
            profile_cascade = None
            log.warning("shorts.reframe: Haar cascade XML failed to load")
        else:
            log.info("shorts.reframe: Haar cascade ready (frontal + profile)")
    except Exception as exc:
        log.warning("shorts.reframe: Haar cascade init failed (%s)", exc)
        face_cascade = None
        profile_cascade = None
    saliency = None
    try:
        if hasattr(cv2, "saliency"):
            saliency = cv2.saliency.StaticSaliencyFineGrained_create()
    except Exception:
        saliency = None

    # v0.1.22 A1: per-frame "active speaker" estimation using mouth
    # region std-dev as a proxy for lip movement / open mouth. When two
    # or more faces are detected we no longer pick the largest one
    # blindly — we score each by combining size and how "talkative" the
    # mouth region looks. Pure visual, zero new deps, no HF token, runs
    # at the same speed as Haar. Inspired by jipraks/yt-short-clipper's
    # MediaPipe-Smart mode reduced to OpenCV primitives so it works
    # against the bundled stack.
    def _mouth_score(gray_full: "np.ndarray", x: int, y: int, w: int, h: int) -> float:
        # The mouth sits roughly between 60-95% of the face height, in
        # the middle 50% horizontally. We crop that strip and use the
        # std-dev of luminance as the score: a closed flat mouth gives
        # low std (uniform skin); an open / moving mouth introduces
        # dark hole + teeth + tongue → higher std.
        mh = max(8, int(h * 0.35))
        my = y + int(h * 0.60)
        mx = x + int(w * 0.25)
        mw = max(8, int(w * 0.50))
        ih, iw = gray_full.shape[:2]
        my2 = min(ih, my + mh)
        mx2 = min(iw, mx + mw)
        if my >= my2 or mx >= mx2:
            return 0.0
        roi = gray_full[my:my2, mx:mx2]
        if roi.size == 0:
            return 0.0
        return float(roi.std())

    def _detect_face(bgr_frame: "np.ndarray") -> tuple[float, float, float, float] | None:
        """Return (cx, cy, area_norm, confidence) of the most prominent
        SPEAKING face. With multiple detections, picks the one whose
        mouth region has the highest std-dev (lip-movement proxy)
        weighted with face area. Coordinates are in source pixels;
        area_norm in [0,1]."""
        if face_cascade is None:
            return None
        gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
        gray_eq = cv2.equalizeHist(gray)
        faces = face_cascade.detectMultiScale(
            gray_eq, scaleFactor=1.15, minNeighbors=4,
            minSize=(80, 80), flags=cv2.CASCADE_SCALE_IMAGE,
        )
        if len(faces) == 0 and profile_cascade is not None:
            faces = profile_cascade.detectMultiScale(
                gray_eq, scaleFactor=1.15, minNeighbors=4,
                minSize=(80, 80), flags=cv2.CASCADE_SCALE_IMAGE,
            )
        if len(faces) == 0:
            return None
        H, W = bgr_frame.shape[:2]
        if len(faces) == 1:
            x, y, w, h = faces[0]
        else:
            # Combined score: 50% area_norm + 50% normalised mouth std.
            # Normalisation reference (60.0) is the empirical p95 of
            # mouth-region std on 1080p talking-head footage; clamping
            # avoids over-rewarding noisy backgrounds.
            best = None
            best_score = -1.0
            for (fx, fy, fw, fh) in faces:
                area_n = (fw * fh) / float(H * W)
                ms = _mouth_score(gray, fx, fy, fw, fh)
                ms_n = max(0.0, min(1.0, ms / 60.0))
                score = 0.50 * area_n / 0.10 + 0.50 * ms_n
                if score > best_score:
                    best_score = score
                    best = (fx, fy, fw, fh)
            x, y, w, h = best  # type: ignore[misc]
        cx = float(x + w / 2.0)
        cy = float(y + h / 2.0)
        area_norm = float(w * h) / float(H * W)
        return cx, cy, area_norm, 0.75

    # ─── Pass 1: ROI sampling ─────────────────────────────────────
    # Read SEQUENTIALLY from start_f and only process every Nth frame
    # for ROI detection. Random `cap.set(POS_FRAMES, X)` per sample is
    # 10× slower on x264 MP4s without dense keyframes — and on some
    # codec/container combinations it stalls indefinitely (the symptom
    # we hit on the user's first /shorts/from_video run: ffmpeg waited
    # 7+ minutes on 0 frames piped from Python). Sequential read +
    # modulo skip avoids both pathologies.
    sample_every = max(1, int(round(fps / 5.0)))  # ~5 Hz
    # samples now carries 5-tuples: (frame_idx, cx, cy, roi_area, confidence).
    # confidence = 1.0 when face is detected (high quality ROI),
    # 0.3 when only saliency snaps onto something useful, 0.0 when
    # neither found anything (we'll FREEZE the crop in that case
    # rather than chase noise).
    samples: list[tuple[int, float, float, float, float]] = []

    # v0.1.22 B1 (postponed to v0.1.23): YOLOv8 tier was dropped from
    # this version. Even with `whisper_model.unload()` + gc + cuda
    # empty_cache + synchronize before importing ultralytics, the
    # first GPU inference inside the same FastAPI worker triggers a
    # NATIVE-DLL segfault — `Could not load symbol cudnnGetLibConfig
    # (error 127)` — that no Python-level try/except can recover from.
    # In a standalone subprocess the same exact import order works, so
    # the conflict is between cuDNN context state left over by
    # ctranslate2 (faster-whisper's backend) and ultralytics' lazy
    # cuDNN-engine loader. The robust fix is to spawn YOLO in a
    # subprocess worker; deferred to v0.1.23.
    #
    # For this release we rely on Haar + saliency. Empirically Haar
    # hits 100 % on the user's reference video and the saliency tier
    # (with its strong-evidence threshold ≥ 5 %) covers the no-face
    # frames adequately.
    yolo_model = None

    def _yolo_detect(_bgr_frame: "np.ndarray") -> tuple[float, float, float] | None:
        return None

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    fidx = start_f
    sample_count = 0
    log_every = 50
    import time as _t
    pass1_t0 = _t.time()
    while fidx <= end_f:
        ok, frame = cap.read()
        if not ok:
            break
        if (fidx - start_f) % sample_every != 0:
            fidx += 1
            continue
        sample_count += 1
        if sample_count % log_every == 0:
            try:
                log.info(
                    "shorts.reframe pass1 sample %d/%d (frame=%d)",
                    sample_count,
                    max(1, (end_f - start_f) // sample_every),
                    fidx,
                )
            except Exception:
                pass
        cx = src_w * 0.5
        cy = src_h * 0.5
        roi_area = 0.0
        confidence = 0.0
        # Tier 1: face detection (Haar frontal+profile + active speaker scoring)
        face_found = _detect_face(frame)
        if face_found is not None:
            cx, cy, roi_area, _face_conf = face_found
            cy = max(0.0, cy - src_h * 0.04)
            confidence = 1.0
        else:
            # Tier 2: YOLOv8 (person/animal/object — 3 MB nano model)
            yolo_found = _yolo_detect(frame)
            if yolo_found is not None:
                cx, cy, roi_area = yolo_found
                # Slight upward bias for full-body shots (head sits in
                # upper third; skipping this reads as "feet centered").
                cy = max(0.0, cy - src_h * 0.10)
                confidence = 0.6
            elif saliency is not None:
                # Tier 3: saliency map. Only kept when the moment is
                # visually unambiguous (one tight hot spot ≥ 5 % of
                # frame). Below that, we'd rather FREEZE on the last
                # confident position than chase noise.
                try:
                    ok2, sal_map = saliency.computeSaliency(frame)
                    if ok2:
                        sal_u8 = (sal_map * 255).astype(np.uint8)
                        m = cv2.moments(sal_u8)
                        if m["m00"] > 100:
                            sal_cx = float(m["m10"] / m["m00"])
                            sal_cy = float(m["m01"] / m["m00"])
                            sal_area = max(0.02, min(0.5, float(m["m00"]) / (sal_u8.size * 255.0)))
                            if sal_area >= 0.05:
                                cx, cy, roi_area = sal_cx, sal_cy, sal_area
                                confidence = 0.3
                except Exception:
                    pass
        samples.append((fidx, cx, cy, roi_area, confidence))
        fidx += 1
    try:
        log.info(
            "shorts.reframe pass1 done: %d samples in %.1fs",
            len(samples), _t.time() - pass1_t0,
        )
    except Exception:
        pass

    if not samples:
        cap.release()
        raise RuntimeError("no frames could be sampled for ROI detection")

    # ─── Smooth trajectory — JITTER-FREE EMA with median pre-filter ──
    # The previous EMA on raw samples leaked Haar's per-frame bbox
    # jitter (±10–20 px on the same face) as visible camera wobble.
    # Two changes here:
    #   1) MEDIAN-3 pre-filter on the (x, y) signal — removes single-
    #      frame outliers without blurring genuine movement.
    #   2) CONFIDENCE GATING — low-conf samples don't poison the EMA;
    #      we carry the last confident value forward instead.
    #   3) Scene-cut HARD RESET stays — the camera snaps cleanly across
    #      shot boundaries instead of diagonal-sliding.
    # The result: smooth, deliberate pan that follows the subject
    # without micro-jitter.
    def _median3(seq: list[float]) -> list[float]:
        n = len(seq)
        if n <= 2:
            return list(seq)
        out = [seq[0]]
        for i in range(1, n - 1):
            a, b, c = seq[i - 1], seq[i], seq[i + 1]
            out.append(sorted([a, b, c])[1])
        out.append(seq[-1])
        return out

    # Apply median3 only to confident samples to avoid propagating
    # noise from the freeze-fallback positions.
    conf_idx = [i for i, s in enumerate(samples) if s[4] > 0.5]
    if len(conf_idx) >= 3:
        xs_filt = _median3([samples[i][1] for i in conf_idx])
        ys_filt = _median3([samples[i][2] for i in conf_idx])
        for k, i in enumerate(conf_idx):
            f, _, _, roi, conf = samples[i]
            samples[i] = (f, xs_filt[k], ys_filt[k], roi, conf)

    alpha = 0.12  # smooth but responsive enough to follow the subject
    seed = next((s for s in samples if s[4] > 0.0), samples[0])
    sm_x, sm_y, sm_zoom = seed[1], seed[2], 1.0
    last_confident = (sm_x, sm_y)
    cut_frames: set[int] = set()
    if scene_cuts:
        for c in scene_cuts:
            local_t = c - start
            if 0.3 <= local_t <= duration - 0.3:
                cut_frames.add(start_f + int(round(local_t * fps)))
    clip_total_frames = end_f - start_f
    smoothed: list[tuple[int, float, float, float]] = []
    for f, x, y, roi, conf in samples:
        crossed_cut = False
        if cut_frames:
            for cf in cut_frames:
                if smoothed and abs(cf - f) <= sample_every:
                    crossed_cut = True
                    break
        if conf > 0.5:
            tx, ty = x, y
            last_confident = (x, y)
        else:
            tx, ty = last_confident
        if crossed_cut:
            sm_x, sm_y = tx, ty
        else:
            sm_x = alpha * tx + (1 - alpha) * sm_x
            sm_y = alpha * ty + (1 - alpha) * sm_y
        target_zoom = 1.0 + max(0.0, 0.55 * (1.0 - min(1.0, roi / 0.18)))
        local_pos = (f - start_f) / max(1, clip_total_frames)
        if local_pos < 0.05:
            target_zoom += 0.05 * (1.0 - local_pos / 0.05)
        if local_pos > 0.95:
            target_zoom -= 0.06 * ((local_pos - 0.95) / 0.05)
        target_zoom = max(1.0, min(1.55, target_zoom))
        if crossed_cut:
            sm_zoom = target_zoom
        else:
            sm_zoom = alpha * target_zoom + (1 - alpha) * sm_zoom
        smoothed.append((f, sm_x, sm_y, sm_zoom))

    # Frame-idx → (cx, cy, zoom) lookup with linear interp.
    def _lookup(fidx: int) -> tuple[float, float, float]:
        if fidx <= smoothed[0][0]:
            return smoothed[0][1], smoothed[0][2], smoothed[0][3]
        if fidx >= smoothed[-1][0]:
            return smoothed[-1][1], smoothed[-1][2], smoothed[-1][3]
        # binary search
        lo, hi = 0, len(smoothed) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if smoothed[mid][0] <= fidx:
                lo = mid
            else:
                hi = mid
        f0, x0, y0, z0 = smoothed[lo]
        f1, x1, y1, z1 = smoothed[hi]
        t = (fidx - f0) / max(1, f1 - f0)
        return (
            x0 + (x1 - x0) * t,
            y0 + (y1 - y0) * t,
            z0 + (z1 - z0) * t,
        )

    # ── Dual-mode per scene (v0.1.22 final) ─────────────────────
    # OpusClip-grade reframing isn't a single mode. Talking-head shots
    # benefit from tight 9:16 crop locked to the active speaker; wide
    # cinematic shots (action, landscapes, multi-character) lose the
    # actual content if cropped to 56 % of the frame width. The
    # OpusClip "Fill with blur" preset shows the original 16:9 clip
    # centered vertically with a blurred copy filling the side bands
    # — preserves ALL the horizontal composition.
    #
    # Decision per scene segment (between scene cuts):
    #   - max_face_area > 6 % of frame  AND
    #   - face_presence_ratio > 0.4
    #     → 'tight' (active-speaker tracking + crop + zoom curve)
    #   - else
    #     → 'blur' (blur-fill: original 16:9 centered, blurred sides)
    # Mode changes between segments produce hard cuts in the output —
    # mirrors how OpusClip transitions between composition styles.
    scene_boundaries: list[int] = [start_f]
    if scene_cuts:
        for c in scene_cuts:
            cf = start_f + int(round((c - start) * fps))
            if start_f < cf < end_f:
                scene_boundaries.append(cf)
    scene_boundaries.append(end_f)
    # If the segment is longer than ~6 s, force a synthetic split so
    # static shots still get visual variation. OpusClip-style edits
    # rarely hold one composition for more than ~5 s.
    # v0.1.22 final: NO synthetic boundary splits — only the cuts the
    # video actually has. Adding artificial 3.5 s cuts on top chopped
    # naturally-flowing shots in half, making the visual sequence read
    # as "imágenes inconexas con el audio" (the user's complaint).
    # PySceneDetect at threshold 18 picks up the real cuts in anime /
    # xianxia footage; that's what we honour here, period.
    enriched_boundaries: list[int] = list(scene_boundaries)
    enriched_boundaries = sorted(set(b for b in enriched_boundaries if start_f <= b <= end_f))
    if enriched_boundaries[0] != start_f:
        enriched_boundaries.insert(0, start_f)
    if enriched_boundaries[-1] != end_f:
        enriched_boundaries.append(end_f)

    # v0.1.22 final: per-segment mode + FIXED tight composition.
    #
    # Anime/xianxia source has visual cuts every 1-3 s that often slip
    # past PySceneDetect. A smooth-pan EMA crosses those uncaught cuts
    # and slides diagonally over unrelated shots — that's the user's
    # "movimientos erráticos". The fix is OpusClip-style:
    #   - Tight segments hold a FIXED composition (median position of
    #     confident samples in the segment) + a tiny Ken Burns zoom
    #     for cinematic depth. ZERO smooth pan inside the segment.
    #   - Blur segments KEEP the parallax (bg / fg drift in opposite
    #     directions) — that's the cinematic motion the user wants.
    #   - Hard cuts between segments give the rhythmic edit feel.
    scene_modes: list[tuple[int, int, str, tuple[float, float, float] | None]] = []
    for i in range(len(enriched_boundaries) - 1):
        seg_start = enriched_boundaries[i]
        seg_end = enriched_boundaries[i + 1]
        seg_samples = [
            s for s in samples
            if seg_start <= s[0] <= seg_end
        ]
        with_face = [s for s in seg_samples if s[4] >= 1.0]
        max_face_area = max((s[3] for s in with_face), default=0.0)
        face_pres_ratio = (
            len(with_face) / float(len(seg_samples))
            if seg_samples else 0.0
        )
        is_tight = (max_face_area > 0.06 and face_pres_ratio > 0.4)
        mode = "tight" if is_tight else "blur"
        # comp = (cx, cy, zoom) for tight; just (cx, cy, 1.0) anchor for blur.
        comp: tuple[float, float, float] | None = None
        ref_samples = with_face if with_face else seg_samples
        if ref_samples:
            xs = sorted(s[1] for s in ref_samples)
            ys = sorted(s[2] for s in ref_samples)
            mid = len(ref_samples) // 2
            cx_med = xs[mid]
            cy_med = ys[mid]
            if is_tight and with_face:
                rois = sorted(s[3] for s in with_face)
                roi_p75 = rois[int(len(rois) * 0.75)] if rois else 0.0
                target_zoom = 1.0 + max(0.0, 0.55 * (1.0 - min(1.0, roi_p75 / 0.18)))
                target_zoom = max(1.0, min(1.55, target_zoom))
                cy_med = max(0.0, cy_med - src_h * 0.04)
                comp = (cx_med, cy_med, target_zoom)
            else:
                comp = (cx_med, cy_med, 1.0)
        scene_modes.append((seg_start, seg_end, mode, comp))
    try:
        log.info(
            "shorts.reframe scene_modes: %s",
            [
                (
                    round((s - start_f) / fps, 1),
                    round((e - start_f) / fps, 1),
                    m,
                )
                for s, e, m, _ in scene_modes
            ],
        )
    except Exception:
        pass

    def _frame_mode_and_baseline(fidx: int) -> tuple[str, tuple[float, float, float] | None, int, int]:
        for s, e, m, c in scene_modes:
            if s <= fidx <= e:
                return m, c, s, e
        return "blur", None, start_f, end_f

    # ─── Pass 2: render frames + pipe to ffmpeg ─────────────────
    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19",
            "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "4",
            "-pix_fmt", "yuv420p",
        ]
    else:
        encode_args = ["-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p"]

    cmd = [
        "ffmpeg", "-y",
        # v0.1.22 fix: `-nostats -loglevel error` is CRITICAL. Without
        # them ffmpeg writes one progress line per frame to stderr.
        # With stderr=PIPE and no background reader, the pipe buffer
        # (~64 KB on Windows) fills around frame 130-150, ffmpeg blocks
        # on its next stderr write, and Python is in proc.wait() so it
        # never drains stderr — classic subprocess.PIPE deadlock. This
        # was misdiagnosed in v0.1.19 (sequential read fix for Pass 1)
        # AND in v0.1.21 (release+reopen the cap). Both helped narrow
        # the surface but neither addressed the actual deadlock; a
        # repro on the user's video showed ffmpeg processed only
        # 138/480 frames before stalling. Suppressing stats keeps
        # only real errors flowing through the pipe.
        "-hide_banner", "-nostats", "-loglevel", "error",
        # Input 0: rawvideo from stdin (the smart-reframed BGR24 frames)
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{OUT_W}x{OUT_H}", "-r", f"{fps:.6f}",
        "-i", "-",
        # Input 1: original video sliced [start, start+duration] for audio
        "-ss", f"{start:.3f}",
        "-i", src_video,
        "-t", f"{duration:.3f}",
        "-map", "0:v",
        "-map", "1:a:0?",
        "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        # NB: NO `-movflags +faststart` here. Combining faststart with
        # NVENC and the close-stdin moov-relocate phase is the second
        # path to the same hang (ffmpeg also stalls on the trailing
        # mux). The output still plays correctly — moov sits at the
        # END of the file (which YouTube and every native player
        # accept). If a future feature needs streaming-from-byte-0,
        # post-process with `ffmpeg -i out.mp4 -c copy -movflags +faststart out2.mp4`.
        "-shortest",
        str(out_video),
    ]
    # v0.7.14 — close_fds=True + stdout=DEVNULL. Sin close_fds, en Windows el
    # ffmpeg hijo hereda TODOS los handles del sidecar (socket FastAPI :8731,
    # archivos JSONL abiertos, conexiones a ComfyUI/llama.cpp). Cuando un
    # shutdown del sidecar mata Python mientras ffmpeg sigue vivo, esos
    # handles permanecen abiertos en el hijo y el puerto 8731 queda bound
    # → fallo "address already in use" al reiniciar. stdout=DEVNULL evita
    # que un stdout no consumido haga backpressure (ffmpeg de Pass 2 sólo
    # escribe progreso a stderr; stdout es ruido).
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        close_fds=True,
    )

    # v0.1.21 fix: previously we reused the SAME `cap` from Pass 1 and
    # called `cap.set(CAP_PROP_POS_FRAMES, start_f)` here. After Pass 1
    # the read cursor sits at EOF; on x264 MP4s with sparse keyframes the
    # FFmpeg backend of OpenCV silently stalls on a backwards seek (the
    # exact symptom we hit on the user's first /shorts/from_video run on
    # v0.1.19: `pass1 done` arrives, then 4+ minutes of 128 % CPU with no
    # heartbeat, and a 48-byte MP4 with no `moov` atom). Re-open the
    # capture from scratch: a single forward seek on a fresh cap is fast
    # and reliable, and matches the pattern we already use in Pass 1.
    cap.release()
    cap = cv2.VideoCapture(src_video)
    if not cap.isOpened():
        proc.kill()
        raise RuntimeError("could not reopen source video for pass 2 encode")
    if start_f > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    fidx = start_f
    pass2_t0 = _t.time()
    last_log = start_f - 1  # so first heartbeat fires only at +60 frames
    try:
        while fidx <= end_f:
            ok, frame = cap.read()
            if not ok:
                break
            # Heartbeat every 60 frames so a stuck ffmpeg pipe is visible
            # in the JSONL log within ~2 seconds, not 7 minutes from now.
            if fidx - last_log >= 60:
                last_log = fidx
                try:
                    log.info(
                        "shorts.reframe pass2 frame %d/%d",
                        fidx - start_f, end_f - start_f,
                    )
                except Exception:
                    pass
            mode, comp, seg_s, seg_e = _frame_mode_and_baseline(fidx)
            if mode == "tight" and comp is not None:
                # FIXED composition for the segment + slow Ken Burns
                # zoom (1.00 → 1.04) for cinematic depth WITHOUT the
                # erratic micro-pan that smooth-EMA caused on uncaught
                # anime cuts.
                base_cx, base_cy, base_zoom = comp
                seg_progress = (fidx - seg_s) / max(1.0, seg_e - seg_s)
                t = max(0.0, min(1.0, seg_progress))
                t_ease = t * t * (3.0 - 2.0 * t)
                cx = base_cx
                cy = base_cy
                zoom = base_zoom * (1.0 + 0.04 * t_ease)
                zoom = max(1.0, min(1.65, zoom))
                ch = max(64, int(round(src_h / zoom)))
                cw = max(36, int(round(ch * TARGET_AR)))
                if cw > src_w:
                    cw = src_w
                    ch = int(round(cw / TARGET_AR))
                x1c = int(round(cx - cw / 2))
                y1c = int(round(cy - ch / 2))
                x1c = max(0, min(src_w - cw, x1c))
                y1c = max(0, min(src_h - ch, y1c))
                cropped = frame[y1c: y1c + ch, x1c: x1c + cw]
                rendered = cv2.resize(
                    cropped, (OUT_W, OUT_H), interpolation=cv2.INTER_LANCZOS4
                )
            else:
                # 'blur' mode with PARALLAX:
                #   • bg: scaled to COVER + blurred + slow Ken-Burns
                #     zoom 1.00 → 1.04 + drift ±20 px. Background
                #     "breathes" gently.
                #   • fg: original 16:9 sharp + own Ken-Burns 1.000 →
                #     1.025 + tiny opposite drift ±8 px. Reads as a
                #     subject in front of a moving backdrop = depth.
                #   • Different speeds for bg and fg = parallax.
                src_ar_local = src_w / float(src_h)
                seg_progress = (fidx - seg_s) / max(1.0, seg_e - seg_s)
                # smoothstep so motion eases in/out at segment edges
                t = max(0.0, min(1.0, seg_progress))
                t_ease = t * t * (3.0 - 2.0 * t)

                # ── Background ───────────────────────────────
                bg_zoom = 1.00 + 0.04 * t_ease
                bg_drift_x = (t_ease - 0.5) * 40.0  # ±20 px
                bg_drift_y = (t_ease - 0.5) * -20.0  # ±10 px opposite Y
                if src_ar_local > (OUT_W / OUT_H):
                    new_h = int(round(OUT_H * bg_zoom))
                    new_w = int(round(new_h * src_ar_local))
                else:
                    new_w = int(round(OUT_W * bg_zoom))
                    new_h = int(round(new_w / src_ar_local))
                bg_full = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
                bx = int(round((new_w - OUT_W) * 0.5 + bg_drift_x))
                by = int(round((new_h - OUT_H) * 0.5 + bg_drift_y))
                bx = max(0, min(new_w - OUT_W, bx))
                by = max(0, min(new_h - OUT_H, by))
                bg = bg_full[by:by + OUT_H, bx:bx + OUT_W]
                bg = cv2.GaussianBlur(bg, (51, 51), 30)
                bg = (bg.astype(np.float32) * 0.55).astype(np.uint8)

                # ── Foreground (parallax: opposite direction, slower) ──
                fg_zoom = 1.000 + 0.025 * t_ease
                fg_drift_x = -bg_drift_x * 0.4  # opposite + smaller
                fg_drift_y = -bg_drift_y * 0.4
                fg_w = int(round(OUT_W * fg_zoom))
                fg_h = int(round(fg_w / src_ar_local))
                if fg_h > OUT_H:
                    fg_h = OUT_H
                    fg_w = int(round(OUT_H * src_ar_local))
                fg = cv2.resize(frame, (fg_w, fg_h), interpolation=cv2.INTER_LANCZOS4)
                rendered = bg.copy()
                fy = int(round((OUT_H - fg_h) * 0.5 + fg_drift_y))
                fx = int(round((OUT_W - fg_w) * 0.5 + fg_drift_x))
                fy_dst = max(0, fy)
                fx_dst = max(0, fx)
                fy_src = max(0, -fy)
                fx_src = max(0, -fx)
                fh_paste = min(fg_h - fy_src, OUT_H - fy_dst)
                fw_paste = min(fg_w - fx_src, OUT_W - fx_dst)
                if fh_paste > 0 and fw_paste > 0:
                    fg_crop = fg[fy_src:fy_src + fh_paste,
                                 fx_src:fx_src + fw_paste]
                    bg_crop = rendered[fy_dst:fy_dst + fh_paste,
                                       fx_dst:fx_dst + fw_paste]
                    # Soft-feather ONLY on top + bottom edges. The fg
                    # already fills the full 1080 px width, so a left/
                    # right feather mixed the foreground with itself
                    # (the bg behind those pixels is the SAME blurred
                    # source), creating the halo artifact the user
                    # described as "rembg mal hecho". Top/bottom is
                    # where the blur band is visible — that's where
                    # the seam needs softening.
                    feather = 16
                    alpha = np.ones((fh_paste, fw_paste), dtype=np.float32)
                    if fh_paste > 2 * feather:
                        ramp_v = np.linspace(0.0, 1.0, feather, dtype=np.float32)
                        alpha[:feather, :] *= ramp_v[:, None]
                        alpha[-feather:, :] *= ramp_v[::-1][:, None]
                    alpha3 = alpha[..., None]
                    blended = (
                        fg_crop.astype(np.float32) * alpha3
                        + bg_crop.astype(np.float32) * (1.0 - alpha3)
                    ).astype(np.uint8)
                    rendered[fy_dst:fy_dst + fh_paste,
                             fx_dst:fx_dst + fw_paste] = blended
            try:
                proc.stdin.write(rendered.tobytes())
            except (BrokenPipeError, OSError):
                break
            fidx += 1
    finally:
        cap.release()
        try:
            proc.stdin.close()
        except Exception:
            pass
        ret = proc.wait(timeout=300)
        try:
            log.info(
                "shorts.reframe pass2 done: %d frames in %.1fs (rc=%d)",
                fidx - start_f, _t.time() - pass2_t0, ret,
            )
        except Exception:
            pass
        if ret != 0:
            stderr = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
            raise RuntimeError(
                f"ffmpeg reframe encode failed (rc={ret}): "
                f"{stderr[-400:] if stderr else 'no stderr'}"
            )


def _burn_subs_into_vertical(
    src_vertical: Path,
    out_path: Path,
    ass_path: Path,
) -> None:
    """Second pass: burn ASS karaoke into the already-reframed vertical
    short. Kept separate from the reframe so the subtitles always sit in
    the 1080×1920 coordinate system, not the original 16:9."""
    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19",
            "-pix_fmt", "yuv420p",
        ]
    else:
        encode_args = ["-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p"]
    vf = f"subtitles={ass_path.name}"
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src_vertical),
        "-vf", vf,
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ass_path.parent))
    if proc.returncode != 0:
        raise HTTPException(500, f"vertical burn-in failed: {proc.stderr[-500:]}")


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
    from ..models import aligner, whisper_model

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
        # v0.2.16 — consolidated helper (single source of truth). vad=True
        # is preserved here: /from_video ingests arbitrary uploaded video
        # where VAD usefully skips long non-speech stretches. It now also
        # inherits the permissive anti-drop thresholds so the opening
        # words (which carry the Short's hook) are no longer discarded.
        segments_list, info = whisper_model.transcribe_words(
            str(audio_path), req.primary_language, vad=True
        )
    except Exception as e:
        raise HTTPException(503, f"whisper not ready: {e}") from e
    words: list[Word] = []
    for seg in segments_list:
        for w in (seg.words or []):
            words.append(Word(word=w.word, start=w.start, end=w.end))
    if not words:
        raise HTTPException(400, "transcription produced no words — is the video silent?")

    # v0.1.22: free whisper from VRAM before subsequent GPU consumers
    # (YOLOv8, NVENC) come online. Sharing cuDNN handles between two
    # concurrent loaders triggered the dreaded
    #   `Could not load symbol cudnnGetLibConfig (error 127)`
    # which was a hard process abort, not a Python exception. Whisper
    # is done with its work here — we have all the words/segments we
    # need — so we explicitly release it. unload() runs gc + empty_cache
    # + synchronize so the cuDNN context is fully relinquished by the
    # time the next CUDA consumer comes in.
    try:
        if whisper_model.unload():
            log.info("shorts.from_video: whisper unloaded after transcription")
    except Exception:
        pass

    # v0.2.16 — WhisperX-grade forced alignment (ADDITIVE, hard fallback).
    # refine_segments runs wav2vec2 in an ISOLATED child process (torchaudio
    # vs ctranslate2 cuDNN clash = v0.1.22 error-127 hard abort). The
    # whisper unload above still helps by freeing parent VRAM for the child.
    # Tighter word boundaries here directly improve sentence grouping,
    # scene-cut snap and the v0.2.15 black-guard (which re-derives text from
    # surviving words). On ANY problem `refined` is None → keep `words`.
    try:
        refined = aligner.refine_segments(
            str(audio_path), segments_list, req.primary_language
        )
        if refined is not None:
            rw: list[Word] = []
            for seg in refined:
                for w in (seg.words or []):
                    rw.append(Word(word=w.word, start=w.start, end=w.end))
            if rw:
                words = rw
                log.info(
                    "shorts.from_video: forced-align refined %d words", len(rw)
                )
    except Exception as e:
        log.warning("shorts.from_video: forced-align skipped (%s)", e)

    # 3-4. Reuse the candidate scoring + picking logic from /shorts/auto
    sentences = _group_into_sentences(words)
    candidates = _candidate_segments(
        sentences, req.target_duration, req.min_duration, req.max_duration,
    )
    if not candidates:
        raise HTTPException(400, "no candidate segments found in transcript")

    # ── v0.1.22 A3: visual-aware scoring ─────────────────────────────
    # Two precomputed maps that turn the LLM-only score into a
    # visually-aware viral score:
    #   - scene_cuts: timestamps where the video naturally changes
    #     shot. We snap candidate boundaries to those so the short
    #     never opens mid-shot (the user's "no se ve nada" complaint).
    #   - face_presence: which timestamps in the source contain a
    #     face. We multiplicatively penalise candidates that sit on
    #     face-less stretches — the LLM doesn't know what's on screen.
    src_duration = float(info.duration or 0.0) if hasattr(info, "duration") else 0.0
    if src_duration <= 0.0:
        src_duration = max(c["end"] for c in candidates) if candidates else 0.0
    scene_cuts = _detect_scene_cuts(req.video_path)
    face_presence = _face_presence_map(req.video_path, src_duration, sample_hz=1.0)

    # Snap each candidate's start/end to the nearest scene cut.
    for c in candidates:
        snapped_start, snapped_end = _snap_to_scene_cuts(
            scene_cuts, float(c["start"]), float(c["end"])
        )
        c["start"] = snapped_start
        c["end"] = snapped_end
        c["duration"] = snapped_end - snapped_start

    if len(candidates) > 12:
        step = len(candidates) // 12
        sampled = candidates[::step][:12]
    else:
        sampled = candidates

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        # Score sampled candidates IN PARALLEL (was serial — 12×3s = 36 s).
        # asyncio.gather drops it to ~max(per-call) since Ollama with
        # OLLAMA_NUM_PARALLEL>=2 happily handles concurrent generates.
        score_results = await asyncio.gather(
            *(_score_candidate(client, req.model, c["text"]) for c in sampled),
            return_exceptions=True,
        )
        for c, scores in zip(sampled, score_results):
            if isinstance(scores, Exception):
                scores = {
                    "hook_score": 0.5,
                    "climax_score": 0.5,
                    "standalone_score": 0.5,
                }
            c.update(scores)
            face_pres = _face_presence_score(face_presence, c["start"], c["end"])
            cut_density_mult = _scene_cut_density_score(scene_cuts, c["start"], c["end"])
            c["face_presence"] = face_pres
            c["cut_density_mult"] = cut_density_mult
            if face_pres < 0.30:
                visual_mult = 0.40
            elif face_pres < 0.60:
                visual_mult = 0.70 + (face_pres - 0.30) * (0.30 / 0.30)
            else:
                visual_mult = 1.0 + min(0.10, (face_pres - 0.60) * 0.25)
            llm_score = (
                0.4 * c["hook_score"]
                + 0.4 * c["climax_score"]
                + 0.2 * c["standalone_score"]
            )
            c["score"] = llm_score * visual_mult * cut_density_mult
        # Sort by start only — multiple candidates with same start but
        # different durations share the same anchor, so we shouldn't try
        # to break ties by comparing dicts (Python TypeError).
        sampled_starts = sorted(((c["start"], c) for c in sampled), key=lambda kv: kv[0])
        for c in candidates:
            if "score" in c:
                continue
            nearest = min(sampled_starts, key=lambda kv: abs(kv[0] - c["start"]))[1]
            face_pres = _face_presence_score(face_presence, c["start"], c["end"])
            cut_density_mult = _scene_cut_density_score(scene_cuts, c["start"], c["end"])
            c["face_presence"] = face_pres
            c["cut_density_mult"] = cut_density_mult
            visual_mult = (
                0.40 if face_pres < 0.30
                else (0.70 + (face_pres - 0.30) * 1.0) if face_pres < 0.60
                else 1.0 + min(0.10, (face_pres - 0.60) * 0.25)
            )
            llm_score = (
                0.4 * nearest["hook_score"]
                + 0.4 * nearest["climax_score"]
                + 0.2 * nearest["standalone_score"]
            )
            c.update(
                hook_score=nearest["hook_score"],
                climax_score=nearest["climax_score"],
                standalone_score=nearest["standalone_score"],
                score=llm_score * visual_mult * cut_density_mult * 0.85,
            )

    picked = _pick_top_non_overlapping(candidates, req.n_shorts)
    # v0.2.15: never cold-open on the dark title-card intro / fade-from-
    # black — advance each pick past its near-black lead-in so the Short
    # opens on a bright frame (done BEFORE hook generation so the hook
    # reflects the trimmed opening).
    for c in picked:
        _guard_black_open(req.video_path, c, words, req.min_duration)
    try:
        log.info(
            "shorts.picked: %s",
            [
                {
                    "start": round(p["start"], 1),
                    "end": round(p["end"], 1),
                    "face_pres": round(p.get("face_presence", -1), 2),
                    "score": round(p["score"], 3),
                }
                for p in picked
            ],
        )
    except Exception:
        pass

    # 5. Cut + reframe + (HyperFrames-enhanced compose | ASS burn-in fallback)
    # ─────────────────────────────────────────────────────────────────
    # Generate hooks for the picked clips up front. Each call is
    # ~1-3 s on Gemma 4B, so we serialise them rather than parallel —
    # OLLAMA_NUM_PARALLEL=1 on 8 GB VRAM saturates anyway.
    shorts: list[ShortInfo] = []
    detected_lang = (info.language or "en").lower()
    cta_defaults = _CTA_DEFAULTS.get(detected_lang, _CTA_DEFAULTS["en"])
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        hooks: list[str] = []
        for c in picked:
            # First sentence of the clip is a sane fallback hook.
            fallback = (c["text"] or "").split(".", 1)[0].strip()
            if len(fallback) > 70:
                fallback = fallback[:70].rsplit(" ", 1)[0]
            hook = await _generate_short_hook(
                client, req.model, c["text"], fallback=fallback,
            )
            hooks.append(hook)

    for i, c in enumerate(picked):
        # Word subset for this Short, with start times remapped to the
        # CLIP-LOCAL timeline (0 = clip start) — both the ASS karaoke
        # and the HyperFrames overlay expect these local offsets.
        seg_words = [
            {"word": w.word, "start": w.start - c["start"], "end": w.end - c["start"]}
            for w in words
            if c["start"] <= w.start <= c["end"]
        ]
        # Generate ASS as a SAFETY NET — if the HyperFrames enhanced path
        # fails (Node sidecar down, Chromium error, etc.), _cut_short
        # auto-falls-back to burn-in and we still get readable captions.
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
        _cut_short(
            req.video_path,
            out_path,
            c["start"],
            c["duration"],
            ass_path,
            enhanced_words=seg_words if req.burn_subs else None,
            enhanced_hook=hooks[i],
            enhanced_cta_title=cta_defaults["title"],
            enhanced_cta_sub=cta_defaults["sub"],
            scene_cuts=scene_cuts,
        )
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

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
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
    # v0.2.15: same black cold-open guard as /from_video.
    for c in picked:
        _guard_black_open(req.video_path, c, req.words, req.min_duration)

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
