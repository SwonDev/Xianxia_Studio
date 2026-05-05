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


def wait_for_image(prompt_id: str, timeout: float = 600.0) -> Path:
    """Poll ComfyUI's history endpoint until the prompt finishes; return the
    output image path on disk."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            history = httpx.get(f"{COMFY_URL}/history/{prompt_id}", timeout=5).json()
        except Exception:
            time.sleep(1)
            continue
        if prompt_id not in history:
            time.sleep(1)
            continue
        outputs = history[prompt_id].get("outputs", {})
        for _, node_out in outputs.items():
            for img in node_out.get("images", []):
                # ComfyUI saves to its own output dir; return that path
                from .. import _comfy_root
                return _comfy_root() / "output" / img["subfolder"] / img["filename"]
        time.sleep(1)
    raise TimeoutError(f"ComfyUI prompt {prompt_id} did not finish in {timeout}s")


def xianxia_workflow(prompt: str, width: int = 1344, height: int = 768, seed: int = 42) -> dict:
    """Default workflow: Z-Image-Turbo via the GGUF loader (low-VRAM friendly).

    Loads the JSON template at workflows/z_image_turbo.json and substitutes
    placeholders. Users can override the template path with
    XIANXIA_COMFY_WORKFLOW=/abs/path/workflow.json (advanced users only).
    """
    import json
    import os
    from pathlib import Path

    custom = os.environ.get("XIANXIA_COMFY_WORKFLOW")
    if custom and Path(custom).exists():
        path = Path(custom)
    else:
        path = Path(__file__).resolve().parents[1] / "workflows" / "z_image_turbo.json"
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
