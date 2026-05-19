"""Direct POST to Node sidecar /render/short with KNOWN payload.
Verifies that hook + captions + CTA are passed correctly and rendered.
With XIANXIA_KEEP_SHORT_PROJ=1 the project dir is preserved so we can
inspect the HTML that HyperFrames actually consumed.
"""
from __future__ import annotations
import json
import time
import urllib.request
from pathlib import Path

CLIP = r"C:\Users\swon_\OneDrive\Documentos\PROYECTOS\VIBECLAUDE\Xianxia_Studio\tests\proof\pipeline-e2e\shorts-from-video\short-01-79854a.mp4"
OUT_DIR = Path(__file__).parent / "tests" / "proof" / "render-direct"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT = OUT_DIR / "render-direct-test.mp4"

payload = {
    "clip_path": CLIP,
    "duration": 20.0,
    "hook": "TEST HOOK VISIBLE",
    "words": [
        {"w": "PRIMERA", "s": 0.5, "e": 1.0},
        {"w": "PALABRA", "s": 1.0, "e": 1.5},
        {"w": "VISIBLE", "s": 1.5, "e": 2.0},
        {"w": "AHORA", "s": 2.5, "e": 3.0},
        {"w": "EN", "s": 3.0, "e": 3.3},
        {"w": "PANTALLA", "s": 3.3, "e": 4.0},
        {"w": "DEBE", "s": 4.5, "e": 5.0},
        {"w": "VERSE", "s": 5.0, "e": 5.5},
        {"w": "CON", "s": 6.0, "e": 6.3},
        {"w": "HIGHLIGHT", "s": 6.3, "e": 7.0},
    ],
    "cta_title": "GRACIAS",
    "cta_sub": "Test directo del render Node",
    "out_path": str(OUT),
}

print(f"POST /render/short ...")
print(f"  hook: {payload['hook']!r}")
print(f"  words: {len(payload['words'])}")
print(f"  cta: {payload['cta_title']!r} / {payload['cta_sub']!r}")
print(f"  clip: {CLIP}")
print(f"  out:  {OUT}")

req = urllib.request.Request(
    "http://127.0.0.1:8732/render/short",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        body = r.read().decode("utf-8")
        print(f"HTTP {r.status} in {time.time()-t0:.1f}s")
        print(json.dumps(json.loads(body), indent=2))
except Exception as e:
    print(f"FAIL: {e!r}")
    raise
print(f"\nMP4 exists: {OUT.exists()}, size: {OUT.stat().st_size if OUT.exists() else 0:,}")
