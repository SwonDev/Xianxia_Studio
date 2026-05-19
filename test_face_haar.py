"""
Validate that OpenCV Haar cascades detect faces consistently in the
user's test video. We sample every 1s in the [12s, 32s] window (the
same window as the smart-reframe test) and report:
  - how many frames have a face hit
  - distribution of face center positions (cx_normalized, cy_normalized)
  - average face area as fraction of frame
Also save 6 annotated PNGs to tests/proof/face-haar/ so we can
EYEBALL the detection quality.
"""
from __future__ import annotations

import os
from pathlib import Path
import cv2  # type: ignore

VIDEO = Path(r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\projects\01KR14TA79VG8T68ZMFXYGQ430\video.mp4")
OUT_DIR = Path(__file__).parent / "tests" / "proof" / "face-haar"
OUT_DIR.mkdir(parents=True, exist_ok=True)

CLIP_START = 12.0
CLIP_DURATION = 20.0


def main() -> int:
    if not VIDEO.exists():
        print(f"FAIL: source video missing at {VIDEO}")
        return 2

    front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    if front.empty() or profile.empty():
        print("FAIL: Haar XML failed to load")
        return 3

    cap = cv2.VideoCapture(str(VIDEO))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"video: {src_w}x{src_h} @ {fps:.2f} fps")

    start_f = int(round(CLIP_START * fps))
    end_f = int(round((CLIP_START + CLIP_DURATION) * fps))
    sample_every = int(round(fps))  # 1 sample per second

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    fidx = start_f
    hits = 0
    misses = 0
    sums = [0.0, 0.0, 0.0]  # cx_norm, cy_norm, area_norm
    saved = 0
    while fidx <= end_f:
        ok, frame = cap.read()
        if not ok:
            break
        if (fidx - start_f) % sample_every != 0:
            fidx += 1
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = front.detectMultiScale(
            gray, scaleFactor=1.15, minNeighbors=4,
            minSize=(80, 80), flags=cv2.CASCADE_SCALE_IMAGE,
        )
        used = "frontal"
        if len(faces) == 0:
            faces = profile.detectMultiScale(
                gray, scaleFactor=1.15, minNeighbors=4,
                minSize=(80, 80), flags=cv2.CASCADE_SCALE_IMAGE,
            )
            used = "profile"
        if len(faces) == 0:
            misses += 1
            print(f"  fidx={fidx} ({(fidx/fps):.1f}s): NO FACE")
        else:
            x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
            cx_n = (x + w / 2) / src_w
            cy_n = (y + h / 2) / src_h
            area_n = (w * h) / (src_w * src_h)
            sums[0] += cx_n
            sums[1] += cy_n
            sums[2] += area_n
            hits += 1
            print(f"  fidx={fidx} ({(fidx/fps):.1f}s): FACE {used} cx={cx_n:.3f} cy={cy_n:.3f} area={area_n:.3f}")
            # Save 6 annotated samples
            if saved < 6:
                vis = frame.copy()
                cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 0), 4)
                cv2.putText(vis, f"{used} a={area_n:.2f}",
                            (x, max(20, y - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
                cv2.imwrite(str(OUT_DIR / f"face-{saved:02d}-fidx{fidx}.jpg"), vis,
                            [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                saved += 1
        fidx += 1
    cap.release()

    total = hits + misses
    print()
    print(f"== SUMMARY ==")
    print(f"  samples: {total}")
    print(f"  hits:    {hits} ({hits / total * 100:.1f}%)")
    print(f"  misses:  {misses}")
    if hits > 0:
        print(f"  mean cx_norm: {sums[0] / hits:.3f}")
        print(f"  mean cy_norm: {sums[1] / hits:.3f}")
        print(f"  mean area:    {sums[2] / hits:.4f}")
    print(f"  annotated samples saved to: {OUT_DIR}")
    if hits / max(1, total) < 0.3:
        print("FAIL: face detection rate too low (<30%)")
        return 1
    print("[OK] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
