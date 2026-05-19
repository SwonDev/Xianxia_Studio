"""Test /voices/from_file with a local WAV — uploads + runs pipeline + auto-registers."""
from __future__ import annotations
import json, os, time, urllib.request, mimetypes, uuid
from pathlib import Path

SAMPLE = Path(r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\projects\01KQYZ795ANV2EPT0DF1MDHSQ9\tts-b0caaf4c34.wav")
BASE = os.environ.get("XIANXIA_TEST_BASE_URL", "http://127.0.0.1:8741")


def build_multipart(fields: dict, file_name: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----xianxia-{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))
    file_bytes = file_path.read_bytes()
    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n".encode("utf-8")
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), boundary


def main() -> int:
    print(f"== /voices/from_file e2e ==")
    print(f"  source: {SAMPLE}")
    print(f"  size:   {SAMPLE.stat().st_size:,} bytes")
    fields = {"label": "Test pipeline file", "primary": "es",
              "description": "Test desde archivo local", "ref_text": ""}
    body, boundary = build_multipart(fields, SAMPLE.name, SAMPLE)
    req = urllib.request.Request(
        f"{BASE}/voices/from_file", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            elapsed = time.time() - t0
            data = json.loads(r.read())
            print(f"\n  HTTP {r.status} in {elapsed:.1f}s")
            print(json.dumps(data, indent=2, default=str)[:2000])
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="ignore")
        print(f"FAIL: HTTP {e.code}\n  body: {body[:600]}")
        return 1
    except Exception as e:
        print(f"FAIL: {e!r}")
        return 1

    p = Path(data["clone_path"])
    if not p.exists() or p.stat().st_size < 10_000:
        print(f"FAIL: clone WAV missing/too small: {p}")
        return 2
    print(f"\n[OK] clone ready: {p} ({p.stat().st_size:,} bytes, {data['duration_seconds']:.2f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
