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

import logging

log = logging.getLogger("xianxia.shorts")

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
        r = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model,
                "system": _HOOK_SYSTEM_PROMPT,
                "prompt": f"Transcript: {snippet}\n\nHook:",
                "stream": False,
                "options": {
                    "temperature": 0.9,
                    "num_predict": 64,
                    "num_ctx": 1024,
                },
            },
            timeout=60.0,
        )
        r.raise_for_status()
        text = (r.json().get("response", "") or "").strip()
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

    vf = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos+full_chroma_int+accurate_rnd"
    if burn_ass_path is not None and burn_ass_path.exists():
        vf += f",subtitles={burn_ass_path.name}"

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


def _smart_reframe_to_vertical(
    src_video: str,
    out_video: Path,
    *,
    start: float,
    duration: float,
    src_w: int,
    src_h: int,
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

    # ── Optional ROI detectors. We tolerate their absence so the
    #    function still works on a stripped-down install.
    face_det = None
    try:
        import mediapipe as mp  # type: ignore
        face_det = mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.45,
        )
    except Exception:
        face_det = None
    saliency = None
    try:
        if hasattr(cv2, "saliency"):
            saliency = cv2.saliency.StaticSaliencyFineGrained_create()
    except Exception:
        saliency = None

    # ─── Pass 1: ROI sampling ─────────────────────────────────────
    # Read SEQUENTIALLY from start_f and only process every Nth frame
    # for ROI detection. Random `cap.set(POS_FRAMES, X)` per sample is
    # 10× slower on x264 MP4s without dense keyframes — and on some
    # codec/container combinations it stalls indefinitely (the symptom
    # we hit on the user's first /shorts/from_video run: ffmpeg waited
    # 7+ minutes on 0 frames piped from Python). Sequential read +
    # modulo skip avoids both pathologies.
    sample_every = max(1, int(round(fps / 5.0)))  # ~5 Hz
    samples: list[tuple[int, float, float, float]] = []  # (frame, cx, cy, roi_area)
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
        roi_score = 0.0
        if face_det is not None:
            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = face_det.process(rgb)
                if res.detections:
                    biggest = max(
                        res.detections,
                        key=lambda d: d.location_data.relative_bounding_box.width
                        * d.location_data.relative_bounding_box.height,
                    )
                    bb = biggest.location_data.relative_bounding_box
                    cx = max(0.0, min(1.0, bb.xmin + bb.width / 2.0)) * src_w
                    cy = max(0.0, min(1.0, bb.ymin + bb.height / 2.0)) * src_h
                    roi_area = float(bb.width * bb.height)
                    roi_score = float(biggest.score[0]) if biggest.score else 0.7
            except Exception:
                pass
        if roi_score < 0.4 and saliency is not None:
            try:
                ok2, sal_map = saliency.computeSaliency(frame)
                if ok2:
                    sal_u8 = (sal_map * 255).astype(np.uint8)
                    m = cv2.moments(sal_u8)
                    if m["m00"] > 100:
                        cx = float(m["m10"] / m["m00"])
                        cy = float(m["m01"] / m["m00"])
                        # Normalise the saliency mass to a "roi_area" proxy
                        # so zoom still reacts to scenes with a single
                        # localised hot spot.
                        roi_area = max(0.02, min(0.5, float(m["m00"]) / (sal_u8.size * 255.0)))
            except Exception:
                pass
        samples.append((fidx, cx, cy, roi_area))
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

    # Smooth trajectory + zoom with EMA. Initial state seeded from the
    # first sample so the very first frame doesn't snap.
    alpha = 0.15
    sm_x, sm_y, sm_zoom = samples[0][1], samples[0][2], 1.0
    smoothed: list[tuple[int, float, float, float]] = []
    for f, x, y, roi in samples:
        # ROI -> target zoom: small ROI = zoom in. roi=0 → 1.4×; roi≥0.18 → 1.0×.
        target_zoom = 1.0 + max(0.0, 0.4 * (1.0 - min(1.0, roi / 0.18)))
        target_zoom = max(1.0, min(1.45, target_zoom))
        sm_x = alpha * x + (1 - alpha) * sm_x
        sm_y = alpha * y + (1 - alpha) * sm_y
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
        "-movflags", "+faststart",
        "-shortest",
        str(out_video),
    ]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    fidx = start_f
    pass2_t0 = _t.time()
    last_log = 0
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
            cx, cy, zoom = _lookup(fidx)
            ch = max(64, int(round(src_h / zoom)))
            cw = max(36, int(round(ch * TARGET_AR)))
            if cw > src_w:
                cw = src_w
                ch = int(round(cw / TARGET_AR))
            x1 = int(round(cx - cw / 2))
            y1 = int(round(cy - ch / 2))
            x1 = max(0, min(src_w - cw, x1))
            y1 = max(0, min(src_h - ch, y1))
            cropped = frame[y1: y1 + ch, x1: x1 + cw]
            resized = cv2.resize(
                cropped, (OUT_W, OUT_H), interpolation=cv2.INTER_LANCZOS4
            )
            try:
                proc.stdin.write(resized.tobytes())
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

    # 5. Cut + reframe + (HyperFrames-enhanced compose | ASS burn-in fallback)
    # ─────────────────────────────────────────────────────────────────
    # Generate hooks for the picked clips up front. Each call is
    # ~1-3 s on Gemma 4B, so we serialise them rather than parallel —
    # OLLAMA_NUM_PARALLEL=1 on 8 GB VRAM saturates anyway.
    shorts: list[ShortInfo] = []
    detected_lang = (info.language or "en").lower()
    cta_defaults = _CTA_DEFAULTS.get(detected_lang, _CTA_DEFAULTS["en"])
    async with httpx.AsyncClient() as client:
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
