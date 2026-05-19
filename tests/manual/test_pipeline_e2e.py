"""
End-to-end test against the LIVE sidecar Python on :8731.
Posts the user's real video to /shorts/from_video and verifies the
complete pipeline: whisper → smart_reframe (with Haar) → HyperFrames
overlay → mux → poster.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

VIDEO = r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\projects\01KR14TA79VG8T68ZMFXYGQ430\video.mp4"
OUT_DIR = Path(__file__).parent / "tests" / "proof" / "pipeline-e2e"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BASE = "http://127.0.0.1:8731"


def post_json(path: str, payload: dict, timeout: int = 600) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - t0
            data = resp.read().decode("utf-8")
            print(f"  HTTP {resp.status}  ({elapsed:.1f}s)")
            return json.loads(data)
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body = e.read().decode("utf-8", errors="ignore")
        print(f"  HTTP {e.code}  ({elapsed:.1f}s)\n  body: {body[:600]}")
        raise


def main() -> int:
    print("== /shorts/from_video FULL PIPELINE TEST ==")
    print(f"  source: {VIDEO}")
    print(f"  out:    {OUT_DIR}")

    # Probe health first
    print("\n[1] Health check...")
    with urllib.request.urlopen(BASE + "/health", timeout=5) as r:
        h = json.loads(r.read())
    print(f"  encoder: {h.get('video_encoder_label')}")

    # Single short — fastest path to validate full flow
    payload = {
        "video_path": VIDEO,
        "out_dir": str(OUT_DIR),
        "max_shorts": 1,
        "language": "es",
    }
    print("\n[2] POST /shorts/from_video (max_shorts=1)...")
    t0 = time.time()
    try:
        result = post_json("/shorts/from_video", payload, timeout=900)
    except Exception as exc:
        print(f"FAIL: {exc!r}")
        return 1
    total = time.time() - t0
    print(f"  total elapsed: {total:.1f}s")

    print("\n[3] Result summary:")
    print(json.dumps(result, indent=2, default=str)[:2000])

    # Validate outputs
    shorts = result.get("shorts") or result.get("clips") or []
    if not shorts:
        print("FAIL: response has no shorts/clips field")
        return 2

    print(f"\n[4] Validating {len(shorts)} short(s)...")
    for i, s in enumerate(shorts):
        path = s.get("video_path") or s.get("path") or s.get("output_path")
        if not path:
            print(f"  short {i}: NO PATH in response: {s}")
            continue
        p = Path(path)
        if not p.exists():
            print(f"  short {i}: file missing at {p}")
            continue
        size = p.stat().st_size
        print(f"  short {i}: {p.name}  {size:,} bytes")
        if size < 100_000:
            print(f"    FAIL: file too small ({size} bytes)")
            return 3

    print("\n[OK] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
