"""LTX-2.3 img2video route.

Animates a pre-generated keyframe (init_image) into a short MP4 clip using
ComfyUI + LTX-2.3 22B. Mirrors the ComfyUI submit/poll idiom of routes/image.py.

Frame-count rule: LTX requires frames divisible-by-8 plus 1.
  frames = max(9, ((round(max(1, seconds * fps)) // 8) * 8) + 1)

Workflow templates: src/xianxia_ai/workflows/ltx23_video.json (full/fp8)
                    and ltx23_video_gguf.json (GGUF).

On any ComfyUI/LTX failure raises HTTPException 503 so Rust can fall back
to HyperFrames (static parallax) — that is intentional.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# --------------------------------------------------------------------------- #
# Pure helpers (unit-testable, no I/O)
# --------------------------------------------------------------------------- #

def ltx_frame_count(seconds: float, fps: int) -> int:
    """Return the nearest LTX-legal frame count (div-by-8 + 1, min 9).

    LTX-2.3 requires (frames - 1) % 8 == 0, so valid values are
    1, 9, 17, 25, 33, … We clamp to 9 as the minimum usable clip.

    >>> ltx_frame_count(4.0, 24)
    97
    >>> ltx_frame_count(1.0, 24)
    25
    >>> ltx_frame_count(0.0, 24)
    9
    """
    raw = round(max(1, seconds * fps))
    frames = ((raw // 8) * 8) + 1
    return max(9, frames)


def build_ltx_workflow(
    template: str,
    init_image: str,
    prompt: str,
    width: int,
    height: int,
    seconds: float,
    fps: int,
    seed: int,
) -> dict:
    """Load a workflow template, substitute placeholders, return the dict.

    Attaches debug keys ``__frames``, ``__width``, ``__height`` to the
    returned dict (stripped by comfyui_client.queue_prompt's clean step).

    ``template`` is one of ``"gguf"`` or ``"full"`` (default).
    """
    workflows_dir = Path(__file__).resolve().parents[1] / "workflows"
    fname = "ltx23_video_gguf.json" if template == "gguf" else "ltx23_video.json"
    raw = (workflows_dir / fname).read_text(encoding="utf-8")

    frames = ltx_frame_count(seconds, fps)

    # String-replace all placeholders; prompt gets JSON-safe escaping.
    raw = (
        raw.replace("%INIT_IMAGE%", init_image)
        .replace("%PROMPT%", json.dumps(prompt)[1:-1])  # strip outer quotes, escape internals
        .replace('"%WIDTH%"', str(int(width)))
        .replace('"%HEIGHT%"', str(int(height)))
        .replace('"%FRAMES%"', str(int(frames)))
        .replace('"%FPS%"', str(int(fps)))
        .replace('"%SEED%"', str(int(seed)))
    )

    wf = json.loads(raw)
    # Attach debug / assertion keys (non-node keys are ignored by queue_prompt)
    wf["__frames"] = frames
    wf["__width"] = width
    wf["__height"] = height
    return wf


# --------------------------------------------------------------------------- #
# FastAPI route
# --------------------------------------------------------------------------- #

class LtxClipRequest(BaseModel):
    init_image: str          # absolute path to the keyframe PNG
    prompt: str
    negative_prompt: str | None = None
    width: int = 768
    height: int = 512
    seconds: float = 4.0
    fps: int = 24
    seed: int | None = None
    template: str = "gguf"   # "gguf" | "full"
    out_dir: str | None = None


class LtxClipResponse(BaseModel):
    out_path: str
    frames: int


@router.post("/clip", response_model=LtxClipResponse)
def ltx_clip(req: LtxClipRequest) -> LtxClipResponse:
    """Animate a keyframe into an MP4 using LTX-2.3 via ComfyUI.

    Raises 503 on ComfyUI/LTX failure — Rust falls back to HyperFrames.
    """
    from ..models import comfyui_client

    if not comfyui_client.is_running():
        raise HTTPException(status_code=503, detail="ComfyUI not running; LTX-2.3 unavailable")

    effective_seed = req.seed if req.seed is not None else secrets.randbelow(2**31)

    try:
        wf = build_ltx_workflow(
            template=req.template,
            init_image=req.init_image,
            prompt=req.prompt,
            width=req.width,
            height=req.height,
            seconds=req.seconds,
            fps=req.fps,
            seed=effective_seed,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"LTX workflow build failed: {exc}") from exc

    # Submit to ComfyUI — reuse image.py's battle-tested helpers (DRY)
    try:
        pid = comfyui_client.queue_prompt(wf)
        first_frame_path = comfyui_client.wait_for_image(pid, timeout=1800.0)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"LTX-2.3 ComfyUI generation failed: {exc}") from exc

    # Mux the saved frames into an MP4.
    # ComfyUI's SaveImage saves frames as ltx_video_00001.png, ltx_video_00002.png, …
    # in the same output directory.  We reassemble them with ffmpeg.
    frames = wf["__frames"]
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"ltx_video-{uuid.uuid4().hex[:10]}.mp4"

    frame_dir = first_frame_path.parent
    # Build glob pattern: ComfyUI SaveImage uses the filename_prefix + counter
    frame_pattern = str(frame_dir / "ltx_video_%05d.png")

    try:
        # v0.7.16 — timeout 10 min. Mux de frames PNG a MP4 (libx264 CRF 18)
        # típicamente termina en <2 min; 10 min cubre clips muy largos.
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", str(req.fps),
                "-i", frame_pattern,
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-crf", "18",
                str(out_path),
            ],
            check=True,
            capture_output=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=503,
            detail=f"ffmpeg LTX mux timeout (>10 min): {exc}",
        ) from exc
    except subprocess.CalledProcessError as exc:
        # ffmpeg stderr for debugging
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        raise HTTPException(
            status_code=503,
            detail=f"ffmpeg mux failed for LTX frames: {stderr[:500]}",
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg not found; cannot mux LTX frames",
        ) from exc

    return LtxClipResponse(out_path=str(out_path), frames=frames)
