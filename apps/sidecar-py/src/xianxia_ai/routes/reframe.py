"""Smart vertical reframe — horizontal video → vertical 9:16 with subject tracking.

Pipeline for the "shoot horizontal, deliver vertical" workflow:
  1. Run MediaPipe Face Detection (or Pose if no face) every ~0.5s on the source clip.
  2. Smooth the X coordinate with EMA so the crop window doesn't jitter.
  3. Animate ffmpeg `crop` filter X over time as a sendcmd-driven expression.
  4. Encode with NVENC.

When subject tracking finds nothing (abstract scenery), fall back to the
"blur-extend" pattern: place the horizontal source scaled+centered on a
heavily-blurred upscaled copy of itself filling the 9:16 frame. Preserves
composition, common in pro vertical adaptation (Instagram Stories style).

Used as the final reframe step after HyperFrames composes the horizontal
narrative with full effects pack.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder

router = APIRouter()


class ReframeRequest(BaseModel):
    video_path: str
    out_path: str
    target_width: int = 1080
    target_height: int = 1920
    fallback: str = "blur-extend"  # 'blur-extend' | 'center-crop'
    smoothing: float = 0.12  # EMA alpha for subject X tracking (lower = smoother)


class ReframeResponse(BaseModel):
    out_path: str
    method: str
    seconds: float
    bytes: int


@router.post("", response_model=ReframeResponse)
def reframe(req: ReframeRequest) -> ReframeResponse:
    if not Path(req.video_path).exists():
        raise HTTPException(404, f"video missing: {req.video_path}")
    Path(req.out_path).parent.mkdir(parents=True, exist_ok=True)

    import time
    t0 = time.time()
    method = "blur-extend"
    enc = best_video_encoder()

    # Detect subject path (median X per ~0.5s window). If no detections, blur-extend.
    track = _track_horizontal_video(req.video_path)

    if track and track.get("median_x") is not None and req.fallback != "force-blur":
        # Subject track succeeded — animate crop X over time
        method = "subject-tracked"
        out = _render_tracked_crop(req, track, enc)
    else:
        method = "blur-extend"
        out = _render_blur_extend(req, enc)

    return ReframeResponse(
        out_path=out,
        method=method,
        seconds=time.time() - t0,
        bytes=Path(out).stat().st_size,
    )


# ─── Subject tracking ──────────────────────────────────────────────────


def _track_horizontal_video(path: str) -> dict | None:
    """Subject tracking via MediaPipe (legacy `mp.solutions` API).

    MediaPipe 0.10+ deprecated `mp.solutions` in favour of `mp.tasks`. The
    legacy module still ships in many builds — guard with hasattr() and fall
    through cleanly to blur-extend if not present. For non-human subjects
    (xianxia monkey/dragon characters) face detection is unreliable anyway,
    so blur-extend is the better default for this content.
    """
    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except Exception:
        return None

    if not hasattr(mp, "solutions"):
        # Newer mediapipe — would need mp.tasks rewrite. Skip for now.
        return None

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    sample_every = max(1, int(fps / 2))

    detector_face = mp.solutions.face_detection.FaceDetection(
        model_selection=1, min_detection_confidence=0.4
    )
    pose_detector = mp.solutions.pose.Pose(
        model_complexity=1, min_detection_confidence=0.4
    )

    samples: list[tuple[float, float]] = []  # (timestamp_seconds, normalized_x)
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                # Try face first
                res = detector_face.process(rgb)
                cx = None
                if res.detections:
                    best = max(res.detections, key=lambda d: d.location_data.relative_bounding_box.width)
                    bb = best.location_data.relative_bounding_box
                    cx = bb.xmin + bb.width / 2.0
                else:
                    # Fall back to pose nose
                    pres = pose_detector.process(rgb)
                    if pres.pose_landmarks:
                        nose = pres.pose_landmarks.landmark[0]
                        cx = float(nose.x)
                if cx is not None:
                    samples.append((idx / fps, max(0.0, min(1.0, cx))))
            idx += 1
    finally:
        cap.release()
        detector_face.close()
        pose_detector.close()

    if not samples:
        return None
    median = sorted(s[1] for s in samples)[len(samples) // 2]
    return {"width": width, "height": height, "fps": fps, "samples": samples, "median_x": median}


def _render_tracked_crop(req: ReframeRequest, track: dict, enc) -> str:
    """ffmpeg crop with sendcmd-animated X based on subject samples (EMA-smoothed)."""
    width = track["width"]
    height = track["height"]
    samples = track["samples"]
    target_aspect = req.target_width / req.target_height
    crop_w = int(height * target_aspect)
    crop_w = min(crop_w, width)
    max_x = width - crop_w

    # EMA smoothing of normalized X
    alpha = float(req.smoothing)
    smoothed: list[tuple[float, float]] = []
    prev = samples[0][1]
    for ts, x in samples:
        prev = alpha * x + (1 - alpha) * prev
        # Convert to pixel X for crop, clamped
        px = max(0.0, min(float(max_x), prev * width - crop_w / 2.0))
        smoothed.append((ts, px))

    # Build ffmpeg `sendcmd` script: at each sample timestamp, set crop@x to value
    cmd_lines: list[str] = []
    for ts, px in smoothed:
        cmd_lines.append(f"{ts:.3f} crop@x x {px:.1f};")
    sendcmd_script = "\n".join(cmd_lines)

    # Write the script to a temp file beside out_path
    script_path = Path(req.out_path).with_suffix(".sendcmd.txt")
    script_path.write_text(sendcmd_script, encoding="utf-8")

    initial_x = smoothed[0][1] if smoothed else (max_x / 2)
    vf = (
        f"sendcmd=f={script_path.as_posix()},"
        f"crop@x={crop_w}:{height}:x={initial_x:.1f}:y=0,"
        f"scale={req.target_width}:{req.target_height}"
    )

    encode_args = (
        ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-pix_fmt", "yuv420p"]
        if enc.codec_name == "h264_nvenc"
        else ["-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    )
    decode_args = ["-hwaccel", "cuda"] if enc.codec_name == "h264_nvenc" else []

    cmd = [
        "ffmpeg", "-y",
        *decode_args,
        "-i", req.video_path,
        "-vf", vf,
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "copy",
        req.out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    try:
        script_path.unlink()
    except Exception:
        pass
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg tracked-crop failed: {proc.stderr[-700:]}")
    return req.out_path


def _render_blur_extend(req: ReframeRequest, enc) -> str:
    """Place source scaled+centered on a heavily-blurred upscaled+cropped copy."""
    encode_args = (
        ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-pix_fmt", "yuv420p"]
        if enc.codec_name == "h264_nvenc"
        else ["-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    )
    decode_args = ["-hwaccel", "cuda"] if enc.codec_name == "h264_nvenc" else []

    # Two streams from same input:
    #   [0:v]split=2[bg][fg]
    #   [bg] scale to fill 9:16 then heavy blur
    #   [fg] scale to fit width
    #   overlay center
    target_w, target_h = req.target_width, req.target_height
    filter_complex = (
        f"[0:v]split=2[a][b];"
        f"[a]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
        f"crop={target_w}:{target_h},gblur=sigma=40,eq=brightness=-0.08:saturation=0.6[bg];"
        f"[b]scale={target_w}:-2[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2[v]"
    )

    cmd = [
        "ffmpeg", "-y",
        *decode_args,
        "-i", req.video_path,
        "-filter_complex", filter_complex,
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "copy",
        req.out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg blur-extend failed: {proc.stderr[-700:]}")
    return req.out_path
