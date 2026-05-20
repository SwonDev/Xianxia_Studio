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
    """v0.1.36: PyAutoFlip-style multi-subject tracker.

    Replaces the single-largest-face tracker with a UNION bbox over ALL
    detected faces / persons per frame. The crop window is centred on
    the union centroid; when the union is wider than the target crop,
    we record `union_width_norm > 1.0` so the renderer can zoom-out
    (scale + letterbox) instead of cutting heads off (the user's
    Power Rangers complaint).

    Detection cascade per frame:
      1. OpenCV YuNet face detector (neural, all faces)
      2. MediaPipe legacy face detection (fallback)
      3. YOLOv8 'person' class (covers cases where faces aren't visible)
      4. MediaPipe pose (last resort, single subject)
    """
    try:
        import cv2  # type: ignore
    except Exception:
        return None

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    sample_every = max(1, int(fps / 2))

    # --- Try MediaPipe face detection (multi-face) ---
    mp_face = None
    mp_pose = None
    try:
        import mediapipe as mp  # type: ignore
        if hasattr(mp, "solutions"):
            mp_face = mp.solutions.face_detection.FaceDetection(
                model_selection=1, min_detection_confidence=0.35
            )
            mp_pose = mp.solutions.pose.Pose(
                model_complexity=1, min_detection_confidence=0.4
            )
    except Exception:
        pass

    # --- Try YOLOv8 person detection (handles non-face frames) ---
    yolo = None
    try:
        from ultralytics import YOLO  # type: ignore
        yolo = YOLO("yolov8n.pt")
    except Exception:
        pass

    # samples: list of dicts per frame:
    #   { "ts": float, "cx": normalized centroid X,
    #     "union_w": union bbox normalized width,
    #     "top_y": min normalized top of any subject }
    samples: list[dict] = []
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                # Collect all subject bboxes in normalized coords (x0, y0, x1, y1).
                bboxes: list[tuple[float, float, float, float]] = []

                # 1) MediaPipe faces (all detections, not just biggest)
                if mp_face is not None:
                    res = mp_face.process(rgb)
                    if res.detections:
                        for det in res.detections:
                            bb = det.location_data.relative_bounding_box
                            x0 = max(0.0, bb.xmin)
                            y0 = max(0.0, bb.ymin)
                            x1 = min(1.0, bb.xmin + bb.width)
                            y1 = min(1.0, bb.ymin + bb.height)
                            if x1 > x0 and y1 > y0:
                                # Expand the bbox 30% upward to ensure HEAD
                                # (face-only bbox tends to crop forehead).
                                head_pad = (y1 - y0) * 0.3
                                y0 = max(0.0, y0 - head_pad)
                                bboxes.append((x0, y0, x1, y1))

                # 2) YOLO person class — only if no faces found, to keep speed
                if not bboxes and yolo is not None:
                    try:
                        result = yolo.predict(frame, classes=[0], verbose=False)[0]
                        for b in result.boxes.xyxyn.cpu().numpy() if result.boxes is not None else []:
                            x0, y0, x1, y1 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                            if x1 > x0 and y1 > y0:
                                bboxes.append((x0, y0, x1, y1))
                    except Exception:
                        pass

                # 3) Pose nose as last resort
                if not bboxes and mp_pose is not None:
                    pres = mp_pose.process(rgb)
                    if pres.pose_landmarks:
                        nose = pres.pose_landmarks.landmark[0]
                        nx = float(nose.x)
                        # Synthetic bbox centred on nose
                        bboxes.append((max(0.0, nx - 0.08), 0.05, min(1.0, nx + 0.08), 0.55))

                if bboxes:
                    # UNION bbox covers ALL detected subjects.
                    ux0 = min(b[0] for b in bboxes)
                    uy0 = min(b[1] for b in bboxes)
                    ux1 = max(b[2] for b in bboxes)
                    uy1 = max(b[3] for b in bboxes)
                    cx = (ux0 + ux1) / 2.0
                    samples.append({
                        "ts": idx / fps,
                        "cx": max(0.0, min(1.0, cx)),
                        "union_w": ux1 - ux0,
                        "top_y": uy0,
                        "n_subjects": len(bboxes),
                    })
            idx += 1
    finally:
        cap.release()
        if mp_face is not None:
            try: mp_face.close()
            except Exception: pass
        if mp_pose is not None:
            try: mp_pose.close()
            except Exception: pass

    if not samples:
        return None
    sorted_cx = sorted(s["cx"] for s in samples)
    median = sorted_cx[len(sorted_cx) // 2]
    max_union_w = max(s["union_w"] for s in samples)
    avg_subjects = sum(s["n_subjects"] for s in samples) / len(samples)
    return {
        "width": width, "height": height, "fps": fps,
        "samples": samples, "median_x": median,
        "max_union_width_norm": max_union_w,  # >0 means union; >crop_aspect means too wide
        "avg_subjects": avg_subjects,
    }


def _render_tracked_crop(req: ReframeRequest, track: dict, enc) -> str:
    """v0.1.36: PyAutoFlip-style multi-subject reframer.

    If the union of all detected subjects fits inside the target crop
    width, do a smooth tracked crop centred on the union centroid.
    If the union is wider (e.g. several Power Rangers spread across the
    frame), fall back to `_render_blur_extend` which preserves the full
    horizontal span on a blurred background — no head-cropping.
    """
    width = track["width"]
    height = track["height"]
    samples = track["samples"]
    target_aspect = req.target_width / req.target_height
    crop_w = int(height * target_aspect)
    crop_w = min(crop_w, width)
    max_x = width - crop_w

    # v0.1.36: if the union of subjects is wider than what the tight
    # crop can fit, switch to blur-extend (which keeps everyone visible)
    # rather than tracking only the centroid and cutting heads off.
    crop_aspect_norm = crop_w / float(width)  # share of frame width the tight crop sees
    max_union_norm = float(track.get("max_union_width_norm", 0.0))
    if max_union_norm > 0 and max_union_norm > crop_aspect_norm * 0.92:
        # Union too wide → blur-extend keeps all subjects in frame.
        return _render_blur_extend(req, enc)

    # EMA smoothing of normalized X over the union centroid.
    alpha = float(req.smoothing)
    smoothed: list[tuple[float, float]] = []
    prev = samples[0]["cx"]
    for s in samples:
        prev = alpha * s["cx"] + (1 - alpha) * prev
        px = max(0.0, min(float(max_x), prev * width - crop_w / 2.0))
        smoothed.append((s["ts"], px))

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
    # v0.7.15 — timeout 15 min. ffmpeg con filter_complex pesado +
    # NVENC tiene un bug conocido que ocasionalmente cuelga sin
    # progresar (documentado en bugfix_catalog). Sin timeout, el
    # worker FastAPI queda bloqueado para siempre.
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(500, f"ffmpeg tracked-crop timeout (>15 min): {exc}") from exc
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
    # v0.7.15 — timeout 15 min (mismo razonamiento que tracked-crop).
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(500, f"ffmpeg blur-extend timeout (>15 min): {exc}") from exc
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg blur-extend failed: {proc.stderr[-700:]}")
    return req.out_path
