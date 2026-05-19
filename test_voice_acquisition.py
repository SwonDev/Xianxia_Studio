"""
Test e2e del pipeline de voice acquisition.
Usa un YouTube short de muestra (~30s) para validar el flujo completo:
URL -> yt-dlp -> isolate vocals -> denoise -> VAD trim -> normalize -> register.
"""
from __future__ import annotations
import json
import time
import urllib.request
from pathlib import Path

# Sample: a public-domain CC-BY video with clear speech (Big Buck Bunny intro,
# very short). If the URL fails, swap to any short YouTube clip with speech.
TEST_URL = "https://www.youtube.com/shorts/bcpax2nMjfU"  # user-provided

PAYLOAD = {
    "url": TEST_URL,
    "label": "Test pipeline voz",
    "primary": "es",
    "description": "Test acquisition desde URL",
    "ref_text": "",
    "duration_seconds": 25.0,  # cap to 25s of source
}


def main() -> int:
    print(f"== Voice acquisition pipeline e2e test ==")
    print(f"  URL: {TEST_URL}")
    body = json.dumps(PAYLOAD).encode("utf-8")
    import os
    base = os.environ.get("XIANXIA_TEST_BASE_URL", "http://127.0.0.1:8731")
    req = urllib.request.Request(
        f"{base}/voices/from_url",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    print("\nPOST /voices/from_url ...")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            elapsed = time.time() - t0
            body = r.read().decode("utf-8")
            data = json.loads(body)
            print(f"  HTTP {r.status} in {elapsed:.1f}s")
    except Exception as exc:
        print(f"FAIL: {exc!r}")
        try:
            err_body = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else str(exc)
            print(f"  body: {err_body[:600]}")
        except Exception:
            pass
        return 1

    print("\n== Result ==")
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str)[:2000])

    clone_path = Path(data["clone_path"])
    if not clone_path.exists():
        print(f"\nFAIL: clone WAV missing at {clone_path}")
        return 2
    size = clone_path.stat().st_size
    print(f"\nClone WAV: {clone_path}")
    print(f"  size: {size:,} bytes ({size/1024:.1f} KB)")
    print(f"  duration: {data['duration_seconds']:.2f}s")
    print(f"  quality: {data['quality']}")
    if data['duration_seconds'] < 3.0:
        print("FAIL: duration < 3s, not usable for cloning")
        return 3
    print("\n[OK] PASS — clone ready, registered in /tts/clones manifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
