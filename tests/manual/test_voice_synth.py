"""Synthesize a test phrase with a registered voice clone.
After v0.1.24 voice acquisition pipeline, this proves the END of the
loop works: URL -> pipeline -> registered -> synthesizable.
"""
import json, os, sys, time, urllib.request
from pathlib import Path

BASE = os.environ.get("XIANXIA_TEST_BASE_URL", "http://127.0.0.1:8741")
CLONE_ID = sys.argv[1] if len(sys.argv) > 1 else "edb6f35638"
TEXT = (
    "Hola. Esta es la voz clonada con el pipeline integral de Xianxia Studio. "
    "Funciona automáticamente desde un enlace de YouTube. "
    "Si oyes esto, todo el sistema de voz integral está operativo."
)

OUT = Path(__file__).parent / "tests" / "proof" / "voice-synth"
OUT.mkdir(parents=True, exist_ok=True)

payload = {
    "text": TEXT,
    "speaker": f"clone:{CLONE_ID}",
    "language": "es",
    "out_dir": str(OUT),
}

print(f"== TTS synthesis test ==")
print(f"  speaker:  clone:{CLONE_ID}")
print(f"  language: es")
print(f"  text:     {TEXT[:80]}...")
print()
req = urllib.request.Request(
    f"{BASE}/tts",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        body = r.read().decode()
        d = json.loads(body)
        print(f"  HTTP {r.status} in {time.time()-t0:.1f}s")
        print(json.dumps(d, indent=2, default=str))
        p = Path(d["audio_path"])
        if p.exists():
            print(f"\n[OK] WAV: {p}")
            print(f"  size: {p.stat().st_size:,} bytes")
            print(f"  duration: {d.get('duration_seconds', '?')}s")
        else:
            print(f"FAIL: WAV missing at {p}")
            sys.exit(2)
except urllib.error.HTTPError as e:
    body = e.read().decode(errors="ignore")
    print(f"FAIL HTTP {e.code}: {body[:600]}")
    sys.exit(1)
