"""ComfyUI HTTP client for Z-Image-Turbo (and other diffusion architectures).

Z-Image-Turbo runs natively in ComfyUI via the official Comfy-Org single-file
split. Place these in `<runtime>/comfyui/models/`:
  - diffusion_models/z_image_turbo_bf16.safetensors      (~11.7 GB)
  - text_encoders/qwen_3_4b_fp8_mixed.safetensors        (~5.4 GB)
  - vae/ae.safetensors                                    (~320 MB)

The default workflow uses ComfyUI's native nodes:
  UNETLoader → ModelSamplingAuraFlow → KSampler (euler/simple, 8 steps, cfg 1.0)
  CLIPLoader (type "z_image", Qwen3-4B encoder) → CLIPTextEncode → KSampler
  VAELoader → VAEDecode → SaveImage

When XIANXIA_USE_COMFYUI=1, the image route submits this workflow via /prompt.
Falls back to diffusers ZImagePipeline automatically if ComfyUI isn't
running or doesn't have the model files.

The client is also usable for ANY ComfyUI workflow the user wants to bring —
SDXL, FLUX, SD3, AuraFlow, custom nodes — by setting XIANXIA_COMFY_WORKFLOW
to a JSON file path with the placeholders {{prompt}} {{width}} {{height}} {{seed}}.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx


COMFY_URL = "http://127.0.0.1:8188"


def is_running() -> bool:
    try:
        return httpx.get(f"{COMFY_URL}/system_stats", timeout=2).status_code == 200
    except Exception:
        return False


def queue_prompt(workflow: dict) -> str:
    """Submit a workflow JSON to ComfyUI; returns prompt_id.

    Strips any non-dict top-level keys (e.g. our `_comment` / `_placeholders`
    documentation entries) because ComfyUI 0.20+ iterates the prompt and
    expects every value to be a node dict with `_meta`/`class_type`/`inputs`.
    """
    clean = {k: v for k, v in workflow.items() if isinstance(v, dict)}
    r = httpx.post(f"{COMFY_URL}/prompt", json={"prompt": clean}, timeout=10)
    r.raise_for_status()
    return r.json()["prompt_id"]


def wait_for_image(prompt_id: str, timeout: float = 1800.0) -> Path:
    """Poll ComfyUI's history endpoint until the prompt finishes; return the
    output image path on disk.

    30 min default. Z-Image on a clean 8 GB VRAM card runs ~7-8 s/step
    (~60 s per image), but if the previous phase left the GPU primed with
    other models, ComfyUI starts swapping VRAM↔RAM and steps balloon to
    90+ s. The thumbnail job is the most affected because it runs after
    rembg/depth + ACE-Step have warmed memory.

    Cache-hit handling: if ComfyUI receives a prompt identical to a recent
    one (same seed + same prompt + same workflow), it marks every node as
    `execution_cached` and returns `outputs: {}`. The status string still
    says `success`. We detect this case explicitly and recover the output
    path from the SaveImage node's filename_prefix scan of the output dir.

    v0.7.5 — RESPAWN DETECTION. The Rust pipeline hard-respawns ComfyUI
    when VRAM coordination requires it (between phase 4 and thumbnail,
    or before whisper). The fresh process knows nothing about the prompt
    we previously submitted, so /history/{prompt_id} returns 404 forever
    and the old code would spin until the 30 min timeout while the rest
    of the pipeline was blocked. Symptom logged on the 2026-05-20
    Emperador de Jade run: pipeline-rust idle for 11 min between phase 6
    done and phase 7 start while sidecar-py kept polling 8eea7e02-… on
    a respawned ComfyUI. Fix: after 30 s of "404 + empty /queue" we
    declare the prompt orphaned and raise — the caller has a fallback
    (extract video frame for thumbnail, retry image for narrative beats).
    """
    deadline = time.time() + timeout
    # Track the first time we see the prompt_id missing so we can give up
    # if it stays missing AND the queue is empty (i.e. ComfyUI restarted).
    first_missing_ts: float | None = None
    _ORPHAN_GRACE_SECONDS = 30.0
    while time.time() < deadline:
        try:
            history = httpx.get(f"{COMFY_URL}/history/{prompt_id}", timeout=5).json()
        except Exception:
            time.sleep(1)
            continue
        if prompt_id not in history:
            # v0.7.5 — when the prompt is missing AND ComfyUI's queue is
            # empty (nothing running, nothing pending), we assume the
            # server restarted between submission and polling. Give it
            # 30 s grace in case the prompt is still being parsed/queued.
            if first_missing_ts is None:
                first_missing_ts = time.time()
            elif time.time() - first_missing_ts > _ORPHAN_GRACE_SECONDS:
                try:
                    qresp = httpx.get(f"{COMFY_URL}/queue", timeout=5).json()
                    pending = qresp.get("queue_pending", [])
                    running = qresp.get("queue_running", [])
                    if not pending and not running:
                        raise RuntimeError(
                            f"ComfyUI prompt {prompt_id} orphaned: not in /history "
                            f"after {_ORPHAN_GRACE_SECONDS}s AND queue is empty "
                            f"(ComfyUI likely restarted between submit and poll). "
                            f"Caller should retry."
                        )
                except RuntimeError:
                    raise
                except Exception:
                    # Couldn't check queue (transient HTTP error) — keep
                    # polling history for a bit longer rather than wrongly
                    # declaring orphan.
                    pass
            time.sleep(1)
            continue
        # Once we found it in history at least once, reset the missing
        # tracker (this lets us tolerate transient flaps without raising).
        first_missing_ts = None
        entry = history[prompt_id]
        outputs = entry.get("outputs", {})
        for _, node_out in outputs.items():
            for img in node_out.get("images", []):
                from .. import _comfy_root
                return _comfy_root() / "output" / img["subfolder"] / img["filename"]
        # Cache-hit case: status=success but outputs is empty. ComfyUI ate
        # the workflow as duplicate. Try to recover by finding the most
        # recently modified xianxia_*.png in the output dir.
        status = entry.get("status", {})
        if status.get("status_str") == "success" and not outputs:
            from .. import _comfy_root
            output_root = _comfy_root() / "output"
            try:
                cached = max(
                    output_root.glob("xianxia_*.png"),
                    key=lambda p: p.stat().st_mtime,
                    default=None,
                )
                if cached is not None:
                    return cached
            except Exception:
                pass
            raise RuntimeError(
                f"ComfyUI prompt {prompt_id} returned status=success with empty "
                f"outputs (cache-hit) and no recoverable file in {output_root}"
            )
        time.sleep(1)
    raise TimeoutError(f"ComfyUI prompt {prompt_id} did not finish in {timeout}s")


def xianxia_workflow(prompt: str, width: int = 1344, height: int = 768, seed: int = 42) -> dict:
    """Default workflow: Z-Image-Turbo, auto-selecting GGUF Q4_K_M (~4.7 GB)
    when VRAM ≤ 9 GB or the GGUF file is present, BF16 (~12 GB) otherwise.

    Override with XIANXIA_COMFY_WORKFLOW=/abs/path/workflow.json.
    Force a variant with XIANXIA_Z_IMAGE_VARIANT=gguf|bf16.
    """
    import json
    import os
    from pathlib import Path

    custom = os.environ.get("XIANXIA_COMFY_WORKFLOW")
    if custom and Path(custom).exists():
        path = Path(custom)
    else:
        workflows_dir = Path(__file__).resolve().parents[1] / "workflows"
        variant = os.environ.get("XIANXIA_Z_IMAGE_VARIANT", "").lower()
        if variant not in ("gguf", "bf16"):
            # Auto-detect: prefer GGUF if its file exists. Try the env-provided
            # ComfyUI dir first, then fall back to the canonical Tauri data path.
            comfy_dir = os.environ.get("XIANXIA_COMFY_DIR")
            candidates = []
            if comfy_dir:
                candidates.append(Path(comfy_dir))
            # Tauri ProjectDirs: %APPDATA%/xianxia/XianxiaStudio/data/runtime/comfyui
            appdata = os.environ.get("APPDATA")
            if appdata:
                candidates.append(Path(appdata) / "xianxia" / "XianxiaStudio" / "data" / "runtime" / "comfyui")
            gguf_found = False
            for c in candidates:
                if (c / "models" / "diffusion_models" / "z-image-turbo-Q4_K_M.gguf").exists():
                    gguf_found = True
                    break
            variant = "gguf" if gguf_found else "bf16"
        path = workflows_dir / (
            "z_image_turbo_gguf.json" if variant == "gguf" else "z_image_turbo.json"
        )
    raw = path.read_text(encoding="utf-8")
    # Strip JSON comments (\"_comment\" / \"_placeholders\" keys are documentation
    # and parse fine since the loader keeps them; we just substitute strings).
    raw = (
        raw.replace('"{{seed}}"', str(int(seed)))
        .replace('"{{width}}"', str(int(width)))
        .replace('"{{height}}"', str(int(height)))
        .replace("{{prompt}}", json.dumps(prompt)[1:-1])  # escape for JSON-in-JSON
    )
    return json.loads(raw)
