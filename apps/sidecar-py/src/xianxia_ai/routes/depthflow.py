"""DepthFlow endpoint — turns a still image into a 2.5D parallax MP4.

DepthFlow lives in an isolated venv (`runtime/depthflow-venv`) because
its torch / transformers / pillow / numpy pins conflict with the main
sidecar's deps. We call it via subprocess against
`scripts/depthflow_runner.py`, which is the small wrapper that loads
DepthScene and renders an MP4.

Why not a custom shader inside the main process?
  • DepthFlow is GPU-shader-based GLSL — opening a moderngl context
    inside the FastAPI worker would race with ComfyUI's GPU usage.
  • DepthFlow's deps would silently downgrade torch and break TTS
    (we already saw this happen during install).
  • Subprocess isolation lets us reuse the venv's Depth-Anything-V2
    cache between calls — first call downloads the model (~30 s),
    subsequent calls are sub-second startup.

Quality vs the previous rembg + 2-layer parallax:
  • DepthFlow uses a per-pixel depth gradient (no binary fg/bg split)
    so there are no inpainting holes that get exposed when the camera
    pans — fixes the "broken pyramid tops" / "torn edges" complaints.
  • Camera moves: orbital / dolly / vertical / horizontal / zoom /
    circle — picked per beat to vary the rhythm.
  • The output is a real MP4 the renderer can stitch in as a video
    clip (replacing the previous still+KenBurns approach).
"""
from __future__ import annotations

import json
import os
import subprocess
import time as _t
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()


# ── Locate the isolated venv + runner script ────────────────────────────
# Resolution order:
#   1. `XIANXIA_DEPTHFLOW_PYTHON` env var — explicit override.
#   2. `<runtime>/depthflow-venv/Scripts/python.exe` (Windows).
#   3. `<runtime>/depthflow-venv/bin/python` (Linux / macOS).
# The runner script is shipped inside the bundled sidecar as
# `scripts/depthflow_runner.py`; we look for it next to the package.
_THIS_DIR = Path(__file__).resolve().parent
_PKG_ROOT = _THIS_DIR.parent.parent  # …/sidecar-py/src
_RUNNER_SCRIPT = _PKG_ROOT.parent / "scripts" / "depthflow_runner.py"


def _runtime_dir() -> Path:
    # XIANXIA_DATA_DIR is set by the Tauri supervisor; falls back to
    # AppData on Windows for direct python sidecar runs.
    base = os.environ.get("XIANXIA_DATA_DIR")
    if base:
        return Path(base) / "runtime"
    return Path(os.environ.get("APPDATA", "")) / "xianxia" / "XianxiaStudio" / "data" / "runtime"


def _depthflow_python() -> Path:
    override = os.environ.get("XIANXIA_DEPTHFLOW_PYTHON")
    if override:
        return Path(override)
    rt = _runtime_dir()
    win_py = rt / "depthflow-venv" / "Scripts" / "python.exe"
    if win_py.is_file():
        return win_py
    nix_py = rt / "depthflow-venv" / "bin" / "python"
    if nix_py.is_file():
        return nix_py
    return win_py  # default to Windows path; the caller will see ENOENT


class ClipRequest(BaseModel):
    image: str = Field(..., description="Absolute path to the input still image.")
    output: str = Field(..., description="Absolute path where the parallax MP4 will be written.")
    duration_seconds: float = Field(8.0, ge=0.5, le=120.0)
    fps: int = Field(24, ge=12, le=60)
    width: int = Field(1920, ge=320, le=3840)
    height: int = Field(1080, ge=180, le=2160)
    # Camera move preset — picked per beat to vary the rhythm. Empty /
    # unknown falls back to DepthFlow's default move.
    animation: str = Field("orbital", description="orbital | dolly | vertical | horizontal | zoom | circle")


class ClipResponse(BaseModel):
    output_path: str
    bytes: int
    seconds: float


@router.get("/health")
def health() -> dict[str, object]:
    """Quick check the venv + runner are reachable. Lets the supervisor
    decide whether to use parallax clips or fall back to single-image."""
    py = _depthflow_python()
    return {
        "venv_python": str(py),
        "venv_python_exists": py.is_file(),
        "runner_script": str(_RUNNER_SCRIPT),
        "runner_script_exists": _RUNNER_SCRIPT.is_file(),
    }


@router.post("/clip", response_model=ClipResponse)
def clip(req: ClipRequest) -> ClipResponse:
    """Render a 2.5D parallax MP4 from a single still image.

    Blocks until DepthFlow finishes (typical: 0.3-0.5x realtime on a
    modern NVIDIA GPU). The first call ever pays a ~30 s warm-up to
    download Depth-Anything-V2-small; subsequent calls reuse the cache.
    """
    py = _depthflow_python()
    if not py.is_file():
        raise HTTPException(503, f"DepthFlow venv not installed at {py}")
    if not _RUNNER_SCRIPT.is_file():
        raise HTTPException(503, f"depthflow_runner.py missing at {_RUNNER_SCRIPT}")

    if not Path(req.image).is_file():
        raise HTTPException(404, f"input image not found: {req.image}")

    Path(req.output).parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "image": str(Path(req.image).resolve()),
        "output": str(Path(req.output).resolve()),
        "time": float(req.duration_seconds),
        "fps": int(req.fps),
        "width": int(req.width),
        "height": int(req.height),
        "animation": req.animation,
    }

    t0 = _t.time()
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [str(py), "-X", "utf8", str(_RUNNER_SCRIPT), json.dumps(payload)],
        capture_output=True,
        text=True,
        # v0.1.45: force UTF-8 + replace-on-error when decoding the
        # subprocess stdout/stderr. DepthFlow's CLI prints box-drawing
        # progress bars ("┏━━ DepthFlow ┳━━ ▸ Initializing scene…")
        # and on Spanish Windows the parent's default text decoder
        # was `cp1252`, which CHOKED on those bytes mid-batch:
        #   UnicodeDecodeError: 'charmap' codec can't decode byte 0x8f
        # The first ~12 clips slipped through (no box-drawing in
        # output buffer when flushed) and clip 13 hit it, blowing up
        # the whole batch with a 500. Forcing utf-8 + replace makes
        # the capture robust to any glyph the child emits.
        encoding="utf-8",
        errors="replace",
        env=env,
        # v0.1.44: bumped the floor from 180s → 900s. The FIRST call
        # ever per process pays the Depth-Anything-V2 cold start
        # (torch + transformers import + 100 MB safetensors load +
        # OpenGL context + BrokenCache.lru warm-up). On a Windows
        # machine with Defender real-time scan inspecting every
        # subprocess file read, this routinely exceeded 180 s and
        # killed the run before any depth was computed — exactly
        # the v0.1.41/42/43 `depthflow batch returned non-2xx`
        # symptom we kept chasing. 900 s gives generous head-room
        # for the slowest install path while still bailing on a
        # truly hung subprocess.
        timeout=max(900.0, req.duration_seconds * 12.0),
    )
    elapsed = _t.time() - t0

    # The runner prints "OK <path>" or "ERR <msg>" on its last line.
    last_line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    if proc.returncode != 0 or not last_line.startswith("OK "):
        tail_stdout = (proc.stdout or "")[-1500:]
        tail_stderr = (proc.stderr or "")[-1500:]
        raise HTTPException(
            500,
            f"depthflow runner failed (rc={proc.returncode}); "
            f"stdout tail: {tail_stdout}\nstderr tail: {tail_stderr}",
        )

    out = Path(req.output)
    if not out.is_file() or out.stat().st_size < 1024:
        raise HTTPException(500, f"depthflow produced empty / missing file: {out}")

    return ClipResponse(
        output_path=str(out),
        bytes=out.stat().st_size,
        seconds=elapsed,
    )


class BatchRequest(BaseModel):
    images: list[str]
    out_dir: str
    duration_seconds: float = Field(8.0, ge=0.5, le=120.0)
    fps: int = 24
    width: int = 1920
    height: int = 1080
    # Animations rotate per-image so each beat feels different.
    animation_rotation: list[str] = Field(
        default_factory=lambda: ["orbital", "dolly", "horizontal", "circle", "vertical", "zoom"]
    )


class BatchResponse(BaseModel):
    results: list[ClipResponse]
    seconds: float


@router.post("/batch", response_model=BatchResponse)
def batch(req: BatchRequest) -> BatchResponse:
    """Run /clip for each input, rotating animation presets so adjacent
    beats don't share the same camera move.

    v0.1.46: a single failing clip used to crash the whole batch with a
    500 — the rust pipeline then threw away every successful clip and
    fell back to all-static KenBurns. Now each clip is wrapped in a
    try/except: failures get logged and a placeholder result with
    `output_path=""` is appended so the caller's index-aligned list
    stays valid. The rust side detects empty/missing files and uses
    KenBurns for just those beats, keeping parallax for the rest.
    """
    Path(req.out_dir).mkdir(parents=True, exist_ok=True)
    results: list[ClipResponse] = []
    rot = req.animation_rotation or ["orbital"]
    t0 = _t.time()
    failed = 0
    for i, img in enumerate(req.images):
        out = str(Path(req.out_dir) / f"depthflow-{i:03d}.mp4")
        sub = ClipRequest(
            image=img,
            output=out,
            duration_seconds=req.duration_seconds,
            fps=req.fps,
            width=req.width,
            height=req.height,
            animation=rot[i % len(rot)],
        )
        try:
            results.append(clip(sub))
        except HTTPException as exc:
            failed += 1
            # Keep the list index-aligned so beat[i] maps to results[i].
            results.append(ClipResponse(output_path="", bytes=0, seconds=0.0))
            # Log via stderr — the parent supervisor's JSONL middleware
            # will pick it up. Don't log full detail; the per-clip error
            # is already in the python sidecar log.
            import sys as _sys
            _sys.stderr.write(
                f"[depthflow.batch] clip {i} failed ({exc.status_code}): "
                f"{str(exc.detail)[:200]}\n"
            )
        except Exception as exc:  # noqa: BLE001 — never break the batch
            failed += 1
            results.append(ClipResponse(output_path="", bytes=0, seconds=0.0))
            import sys as _sys
            _sys.stderr.write(
                f"[depthflow.batch] clip {i} unexpected: {type(exc).__name__}: "
                f"{str(exc)[:200]}\n"
            )
    return BatchResponse(results=results, seconds=_t.time() - t0)
