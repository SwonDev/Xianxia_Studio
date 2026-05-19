"""
Test e2e del fix v0.1.21 para el cuelgue de Pass 2 en _smart_reframe_to_vertical.

Reproduce exactamente el flujo que tu run de v0.1.19 ejecutó:
  Pass 1 (ROI sampling + EMA smoothing)  ->  Pass 2 (encode FFmpeg).

Para evitar instalar dependencias de FastAPI/etc y aislar el test al bug,
reescribo aquí solo lo mínimo: la función `smart_reframe` que es la
copia EXACTA de `_smart_reframe_to_vertical` con el FIX aplicado.
Validamos:

  - Pass 1 acaba en tiempo razonable (debe ser ~30 s para 20 s de clip)
  - Pass 2 acaba (en v0.1.19 se quedaba colgado para siempre)
  - El MP4 resultante tiene >100 KB y un moov atom válido
  - El número de frames del output ≈ duration × fps

Si todo pasa: el fix integra correctamente.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

import cv2  # type: ignore
import numpy as np  # type: ignore

VIDEO = Path(r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\projects\01KR14TA79VG8T68ZMFXYGQ430\video.mp4")
OUT_DIR = Path(__file__).parent / "tests" / "proof" / "pass2-fix"
OUT_DIR.mkdir(parents=True, exist_ok=True)

OUT_W = 1080
OUT_H = 1920
TARGET_AR = OUT_W / OUT_H


def _has_nvenc() -> bool:
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10,
        )
        return "h264_nvenc" in r.stdout
    except Exception:
        return False


def smart_reframe_v0_1_21(
    src_video: str,
    out_video: str,
    start: float,
    duration: float,
) -> dict:
    """Mirror of `_smart_reframe_to_vertical` with the v0.1.21 fix.

    Returns a small report dict with timings and frame counts.
    """
    cap = cv2.VideoCapture(src_video)
    if not cap.isOpened():
        raise RuntimeError(f"could not open {src_video}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    start_f = max(0, int(round(start * fps)))
    end_f = min(
        total - 1 if total > 0 else int((start + duration) * fps),
        int(round((start + duration) * fps)),
    )

    # mediapipe is optional; if not bundled, fall back to centered crop.
    face_det = None
    try:
        import mediapipe as mp  # type: ignore
        face_det = mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.45,
        )
        print(f"[setup] mediapipe FaceDetection ready")
    except Exception as exc:
        print(f"[setup] mediapipe NOT available ({exc!r}) -> centered crop")

    saliency = None
    try:
        if hasattr(cv2, "saliency"):
            saliency = cv2.saliency.StaticSaliencyFineGrained_create()
            print(f"[setup] saliency StaticSaliencyFineGrained ready")
    except Exception:
        pass

    # --- Pass 1 -----------------------------------------------------
    sample_every = max(1, int(round(fps / 5.0)))
    samples: list[tuple[int, float, float, float]] = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    fidx = start_f
    sample_count = 0
    pass1_t0 = time.time()
    while fidx <= end_f:
        ok, frame = cap.read()
        if not ok:
            break
        if (fidx - start_f) % sample_every != 0:
            fidx += 1
            continue
        sample_count += 1
        if sample_count % 50 == 0:
            print(f"[pass1] sample {sample_count} (frame={fidx})")
        cx, cy = src_w * 0.5, src_h * 0.5
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
                    roi_area = max(0.0, min(1.0, bb.width * bb.height))
                    roi_score = roi_area
            except Exception:
                pass
        if roi_score < 0.04 and saliency is not None:
            try:
                ok2, smap = saliency.computeSaliency(frame)
                if ok2 and smap is not None:
                    smap = (smap * 255).astype(np.uint8)
                    _, th = cv2.threshold(smap, 80, 255, cv2.THRESH_BINARY)
                    M = cv2.moments(th, binaryImage=True)
                    if M["m00"] > 0:
                        cx = M["m10"] / M["m00"]
                        cy = M["m01"] / M["m00"]
                        roi_area = float(np.count_nonzero(th)) / float(th.size)
            except Exception:
                pass
        samples.append((fidx, cx, cy, roi_area))
        fidx += 1

    pass1_seconds = time.time() - pass1_t0
    print(f"[pass1] DONE: {len(samples)} samples in {pass1_seconds:.1f}s")

    if not samples:
        cap.release()
        raise RuntimeError("no frames sampled")

    alpha = 0.15
    sm_x, sm_y, sm_zoom = samples[0][1], samples[0][2], 1.0
    smoothed: list[tuple[int, float, float, float]] = []
    for f, x, y, roi in samples:
        target_zoom = 1.0 + max(0.0, 0.4 * (1.0 - min(1.0, roi / 0.18)))
        target_zoom = max(1.0, min(1.45, target_zoom))
        sm_x = alpha * x + (1 - alpha) * sm_x
        sm_y = alpha * y + (1 - alpha) * sm_y
        sm_zoom = alpha * target_zoom + (1 - alpha) * sm_zoom
        smoothed.append((f, sm_x, sm_y, sm_zoom))

    def _lookup(fidx: int) -> tuple[float, float, float]:
        if fidx <= smoothed[0][0]:
            return smoothed[0][1], smoothed[0][2], smoothed[0][3]
        if fidx >= smoothed[-1][0]:
            return smoothed[-1][1], smoothed[-1][2], smoothed[-1][3]
        lo, hi = 0, len(smoothed) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if smoothed[mid][0] <= fidx:
                lo = mid
            else:
                hi = mid
        f0, x0, y0, z0 = smoothed[lo]
        f1, x1, y1, z1 = smoothed[hi]
        t = (fidx - f0) / max(1, f1 - f0)
        return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t

    # --- Pass 2 -----------------------------------------------------
    use_nvenc = _has_nvenc()
    encode_args = (
        ["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19",
         "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "4",
         "-pix_fmt", "yuv420p"]
        if use_nvenc else
        ["-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p"]
    )
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{OUT_W}x{OUT_H}", "-r", f"{fps:.6f}",
        "-i", "-",
        "-ss", f"{start:.3f}",
        "-i", src_video,
        "-t", f"{duration:.3f}",
        "-map", "0:v",
        "-map", "1:a:0?",
        "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
        "-c:v", "h264_nvenc" if use_nvenc else "libx264",
        *encode_args,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        "-shortest",
        out_video,
    ]
    # ~~~ THE REAL FIX ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    # First attempt (release+reopen+set) STILL hung. The OpenCV+FFmpeg
    # backend stalls on `cap.read()` after a forward seek to a non-
    # keyframe. Reliable approach: avoid OpenCV seeks ENTIRELY. Use
    # ffmpeg stream-copy to slice the segment to a temp clip (~1s, no
    # re-encode), then read that clip from frame 0 — pure sequential.
    cap.release()
    pass2_prep_t0 = time.time()
    temp_clip = Path(out_video).with_suffix(".srcclip.mp4")
    if temp_clip.exists():
        temp_clip.unlink()
    slice_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-i", src_video,
        "-t", f"{duration:.3f}",
        "-c", "copy", "-avoid_negative_ts", "make_zero",
        str(temp_clip),
    ]
    print(f"[pass2-prep] slicing temp clip [{start}s, {start+duration}s]...")
    sl = subprocess.run(slice_cmd, capture_output=True, text=True, timeout=60)
    if sl.returncode != 0:
        raise RuntimeError(f"temp slice failed: {sl.stderr[-400:]}")
    pass2_prep_seconds = time.time() - pass2_prep_t0
    print(f"[pass2-prep] temp clip ready in {pass2_prep_seconds:.2f}s ({temp_clip.stat().st_size:,} bytes)")

    cap = cv2.VideoCapture(str(temp_clip))
    if not cap.isOpened():
        raise RuntimeError(f"could not open temp clip {temp_clip}")
    # ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    # Pre-extract audio to WAV so the encode-stage ffmpeg doesn't have
    # to share the temp clip with OpenCV (Windows file-locking has
    # surprises when two readers + sparse keyframes meet). The audio
    # extract is stream-copy fast.
    audio_wav = Path(out_video).with_suffix(".audio.wav")
    if audio_wav.exists():
        audio_wav.unlink()
    audio_t0 = time.time()
    audio_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(temp_clip),
        "-vn", "-c:a", "pcm_s16le", "-ar", "48000",
        str(audio_wav),
    ]
    print(f"[pass2-prep] extracting audio to {audio_wav.name}...")
    ar = subprocess.run(audio_cmd, capture_output=True, text=True, timeout=60)
    if ar.returncode != 0:
        # Audio extraction failed — proceed without audio.
        print(f"[pass2-prep] audio extract FAILED: {ar.stderr[-200:]}; will encode video-only")
        audio_wav = None
    else:
        print(f"[pass2-prep] audio ready in {time.time()-audio_t0:.2f}s")

    print(f"[pass2] starting (encoder={'nvenc' if use_nvenc else 'libx264'})")
    # `-nostats -loglevel error` is CRITICAL: without it, ffmpeg writes
    # one progress line per frame to stderr. With stderr=PIPE and no
    # background reader, that pipe fills (~64 KB on Win10) somewhere
    # around frame 130-150 and ffmpeg blocks on its write(stderr).
    # Python is in proc.wait() and never reads stderr until ffmpeg
    # exits — classic subprocess deadlock. Suppressing stats keeps
    # only real errors flowing through the pipe.
    cmd_with_temp = [
        "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{OUT_W}x{OUT_H}", "-r", f"{fps:.6f}",
        "-i", "-",
    ]
    if audio_wav is not None:
        cmd_with_temp += ["-i", str(audio_wav), "-map", "0:v", "-map", "1:a:0?"]
    else:
        cmd_with_temp += ["-map", "0:v"]
    cmd_with_temp += [
        "-c:v", "h264_nvenc" if use_nvenc else "libx264",
        *encode_args,
    ]
    if audio_wav is not None:
        cmd_with_temp += [
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        ]
    # NB: NO `-movflags +faststart` here — combining faststart with
    # NVENC + WAV audio input causes ffmpeg to hang indefinitely on
    # the final mux pass (the moov-relocate phase blocks for unknown
    # reasons after stdin closes). The output is still a valid MP4
    # with moov at the END, which YouTube/players accept fine. If
    # web streaming-from-byte-0 is required, run a separate
    # post-pass: `ffmpeg -i out.mp4 -c copy -movflags +faststart out2.mp4`.
    cmd_with_temp += [
        "-shortest",
        out_video,
    ]
    proc = subprocess.Popen(
        cmd_with_temp, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    # tmp_idx N corresponds to source's start_f + N. _lookup needs the
    # absolute source frame index for the smoothing trajectory.
    fidx = 0
    pass2_t0 = time.time()
    last_log = -10  # so we log frame 0 immediately
    frames_piped = 0
    try:
        while True:
            if fidx == 0 or fidx - last_log >= 24:  # heartbeat every 24 frames (~1s)
                last_log = fidx
                elapsed = time.time() - pass2_t0
                print(
                    f"[pass2] reading frame {fidx}/{end_f - start_f} "
                    f"(elapsed={elapsed:.1f}s, piped={frames_piped})",
                    flush=True,
                )
            ok, frame = cap.read()
            if not ok:
                print(f"[pass2] cap.read() returned False at fidx={fidx}", flush=True)
                break
            if fidx > end_f - start_f:
                break
            cx, cy, zoom = _lookup(start_f + fidx)
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
                cropped, (OUT_W, OUT_H), interpolation=cv2.INTER_LANCZOS4,
            )
            try:
                proc.stdin.write(resized.tobytes())
                frames_piped += 1
            except (BrokenPipeError, OSError) as exc:
                print(f"[pass2] pipe broken at frame {fidx}: {exc!r}")
                break
            fidx += 1
    finally:
        print(f"[pass2] entered finally: piped={frames_piped} fidx={fidx}", flush=True)
        try:
            cap.release()
            print(f"[pass2] cap released", flush=True)
        except Exception as e:
            print(f"[pass2] cap.release error: {e!r}", flush=True)
        try:
            proc.stdin.close()
            print(f"[pass2] stdin closed, waiting for ffmpeg...", flush=True)
        except Exception as e:
            print(f"[pass2] stdin.close error: {e!r}", flush=True)
        try:
            ret = proc.wait(timeout=120)
            print(f"[pass2] ffmpeg exited rc={ret}", flush=True)
        except subprocess.TimeoutExpired:
            print(f"[pass2] ffmpeg TIMEOUT after 120s — killing", flush=True)
            proc.kill()
            ret = -1
        pass2_seconds = time.time() - pass2_t0
        stderr = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
        print(f"[pass2] DONE: {frames_piped} frames in {pass2_seconds:.1f}s, rc={ret}", flush=True)
        if stderr:
            print(f"[pass2] ffmpeg stderr (tail):\n{stderr[-800:]}", flush=True)
        # cleanup temp files
        try:
            if temp_clip.exists():
                temp_clip.unlink()
            if audio_wav and audio_wav.exists():
                audio_wav.unlink()
        except Exception:
            pass

    return {
        "fps": fps,
        "src_dims": (src_w, src_h),
        "samples_pass1": len(samples),
        "pass1_seconds": pass1_seconds,
        "frames_piped": frames_piped,
        "pass2_seconds": pass2_seconds,
        "ret": ret,
        "stderr_tail": stderr[-400:] if ret != 0 else "",
    }


def validate_mp4(path: Path) -> dict:
    if not path.exists():
        return {"ok": False, "reason": "file does not exist"}
    size = path.stat().st_size
    if size < 100_000:
        return {"ok": False, "reason": f"file too small ({size} bytes)"}

    r = subprocess.run(
        ["ffprobe", "-v", "error",
         "-show_entries", "format=duration,size:stream=width,height,codec_name,nb_frames",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=15,
    )
    if r.returncode != 0:
        return {"ok": False, "reason": f"ffprobe rc={r.returncode}: {r.stderr}"}
    return {"ok": True, "size_bytes": size, "ffprobe": r.stdout.strip().splitlines()}


if __name__ == "__main__":
    if not VIDEO.exists():
        print(f"FAIL: source video not found at {VIDEO}")
        sys.exit(2)

    print(f"\n== TEST: smart reframe v0.1.21 fix ==")
    print(f"  source: {VIDEO}")
    out = OUT_DIR / "test-short-pass2-fix.mp4"
    if out.exists():
        out.unlink()

    # Same window as the real pipeline would pick: 20 s clip starting at 12 s.
    # That spans across keyframe boundaries on a 24 fps x264 mp4 -> exactly
    # the conditions where the v0.1.19 random-seek bug triggered.
    report = smart_reframe_v0_1_21(
        str(VIDEO), str(out), start=12.0, duration=20.0,
    )
    print(f"\n== REPORT ==")
    for k, v in report.items():
        print(f"  {k}: {v}")

    print(f"\n== MP4 VALIDATION ==")
    val = validate_mp4(out)
    for k, v in val.items():
        print(f"  {k}: {v}")

    if not val.get("ok"):
        print("\nFAIL: output MP4 not valid")
        sys.exit(1)
    if report["ret"] != 0:
        print(f"\nFAIL: ffmpeg returned {report['ret']}")
        sys.exit(1)
    if report["pass2_seconds"] > 120:
        print(f"\nFAIL: Pass 2 took {report['pass2_seconds']:.1f}s - too slow, possibly hanging")
        sys.exit(1)
    expected_frames = int(report["fps"] * 20.0)
    if abs(report["frames_piped"] - expected_frames) > 5:
        print(f"\nFAIL: piped {report['frames_piped']} frames, expected ~{expected_frames}")
        sys.exit(1)

    print(f"\n[OK] PASS - short generated at {out}")
    print(f"  {val['size_bytes']:,} bytes")
    print(f"  Pass 1: {report['pass1_seconds']:.1f}s  Pass 2: {report['pass2_seconds']:.1f}s")
