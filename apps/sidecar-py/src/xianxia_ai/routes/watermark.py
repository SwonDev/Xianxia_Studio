"""POST /watermark — AI-provenance neural watermark on the FINAL video.

Best-effort, mirrors the SEO phase ethos: the video is already done; this
NEVER hard-fails (always HTTP 200 with `watermarked: false` + reason) and
NEVER blocks the pipeline. Embeds an imperceptible Meta AudioSeal mark in
the audio so the published artifact is provably AI-generated (YouTube AI
disclosure, complements the v0.2.14 SEO pack).

Invariants proven empirically (see scripts/watermark_runner.py docstring):
the heavy work runs in an ISOLATED child (cuDNN/CUDA hygiene, dynamo off);
the video stream is copied bit-identical (`-c:v copy`), only the audio is
re-encoded; the watermark survives the AAC roundtrip and is detectable.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from ..logging_utils import log_event

router = APIRouter()

_RUNNER = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "scripts"
    / "watermark_runner.py"
)
_TIMEOUT_S = 6 * 60  # bounded; first run also pip-self-heals + dl small ckpt


class WatermarkRequest(BaseModel):
    video_path: str
    out_dir: str | None = None


class WatermarkResponse(BaseModel):
    watermarked: bool
    path: str | None = None
    reason: str | None = None


def _ffmpeg(args: list[str]) -> tuple[bool, str]:
    p = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return p.returncode == 0, (p.stderr or "")[-300:]


def _ensure_audioseal() -> bool:
    try:
        import audioseal  # noqa: F401

        return True
    except Exception:
        pass
    # Self-heal: existing installs that won't re-run the wizard still get
    # the dep. Pure-python wheel (~63 KB); best-effort, bounded.
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--no-input", "audioseal>=0.2"],
            capture_output=True, text=True, timeout=4 * 60,
        )
        import importlib

        importlib.invalidate_caches()
        import audioseal  # noqa: F401

        return True
    except Exception as e:  # noqa: BLE001
        log_event("warning", "watermark_audioseal_unavailable", error=str(e)[:200])
        return False


@router.post("", response_model=WatermarkResponse)
async def watermark(req: WatermarkRequest) -> WatermarkResponse:
    import asyncio

    video = Path(req.video_path)
    if not video.is_file():
        return WatermarkResponse(watermarked=False, reason="video not found")
    if not _RUNNER.is_file():
        return WatermarkResponse(watermarked=False, reason="runner missing")
    if not _ensure_audioseal():
        return WatermarkResponse(watermarked=False, reason="audioseal unavailable")

    def _work() -> WatermarkResponse:
        tmp = Path(tempfile.gettempdir())
        tag = uuid.uuid4().hex[:10]
        a_in = tmp / f"wm_in_{tag}.wav"
        a_out = tmp / f"wm_out_{tag}.wav"
        j_in = tmp / f"wm_j_{tag}.json"
        j_out = tmp / f"wm_o_{tag}.json"
        tmp_mp4 = video.with_suffix(f".wm_{tag}.mp4")
        try:
            ok, err = _ffmpeg(["-i", str(video), "-vn",
                               "-c:a", "pcm_s16le", str(a_in)])
            if not ok or not a_in.is_file():
                return WatermarkResponse(watermarked=False,
                                         reason=f"audio extract failed: {err}")

            j_in.write_text(json.dumps(
                {"audio_in": str(a_in), "audio_out": str(a_out)}),
                encoding="utf-8")
            env = os.environ.copy()
            env["PYTHONUTF8"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            try:
                proc = subprocess.run(
                    [sys.executable, "-X", "utf8", str(_RUNNER),
                     str(j_in), str(j_out)],
                    capture_output=True, text=True,
                    encoding="utf-8", errors="replace",
                    env=env, timeout=_TIMEOUT_S,
                )
            except subprocess.TimeoutExpired:
                return WatermarkResponse(watermarked=False, reason="timeout")

            last = ((proc.stdout or "").strip().splitlines() or [""])[-1]
            if proc.returncode != 0 or not last.startswith("OK ") \
                    or not a_out.is_file():
                log_event("warning", "watermark_child_failed",
                          rc=proc.returncode,
                          stdout_tail=(proc.stdout or "")[-300:],
                          stderr_tail=(proc.stderr or "")[-300:])
                return WatermarkResponse(watermarked=False,
                                         reason="watermark child failed")

            # Re-mux: video stream copied bit-identical, audio replaced.
            ok, err = _ffmpeg(["-i", str(video), "-i", str(a_out),
                               "-map", "0:v", "-map", "1:a",
                               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                               "-shortest", str(tmp_mp4)])
            if not ok or not tmp_mp4.is_file() or tmp_mp4.stat().st_size < 1024:
                return WatermarkResponse(watermarked=False,
                                         reason=f"remux failed: {err}")

            # Atomic in-place replace — the published path is unchanged so
            # everything downstream keeps pointing at the same file. On
            # any failure above the original was never touched.
            os.replace(str(tmp_mp4), str(video))
            log_event("info", "watermark_applied", path=str(video))
            return WatermarkResponse(watermarked=True, path=str(video))
        except Exception as e:  # noqa: BLE001
            log_event("warning", "watermark_failed", error=str(e)[:300])
            return WatermarkResponse(watermarked=False, reason=str(e)[:200])
        finally:
            for p in (a_in, a_out, j_in, j_out, tmp_mp4):
                try:
                    if Path(p).is_file():
                        Path(p).unlink()
                except Exception:
                    pass

    return await asyncio.to_thread(_work)
