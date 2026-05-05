"""VRAM unload routes — sequential model swapping for 8 GB cards.

The Xianxia Studio pipeline runs five GPU-resident models:
  - Ollama xianxia-llm    (Phase 1+2: script + metadata)
  - Qwen3-TTS-12Hz-1.7B   (Phase 3: TTS)
  - Z-Image-Turbo BF16    (Phase 4: image generation, via ComfyUI)
  - faster-whisper        (Phase 8: transcription)

On an 8 GB card these cannot co-reside. Each phase calls /unload with the
appropriate target before the next phase loads its model. Idempotent.

Targets (`POST /unload?target=<name>`):
  - "tts"     → unload Qwen3-TTS
  - "whisper" → unload faster-whisper
  - "image"   → unload diffusers ZImagePipeline (no-op if ComfyUI path is used)
  - "ollama"  → asks Ollama to unload via keep_alive=0 on `xianxia-llm`
  - "comfyui" → asks ComfyUI to free GPU memory via /free
  - "all"     → all of the above
"""

from __future__ import annotations

import os
import gc

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from ..models import image_model, tts_model, whisper_model

router = APIRouter()

OLLAMA_URL = os.environ.get("XIANXIA_OLLAMA_URL", "http://127.0.0.1:11434")
COMFY_URL = os.environ.get("XIANXIA_COMFY_URL", "http://127.0.0.1:8188")


class UnloadResponse(BaseModel):
    target: str
    unloaded: bool
    detail: str | None = None
    vram_free_gb: float | None = None


def _free_torch_caches() -> None:
    gc.collect()
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except Exception:
        pass


def _vram_free_gb() -> float | None:
    try:
        import torch  # type: ignore
        if not torch.cuda.is_available():
            return None
        free, _ = torch.cuda.mem_get_info()
        return free / 1024**3
    except Exception:
        return None


def _unload_ollama(model: str = "xianxia-llm") -> tuple[bool, str]:
    """Tell Ollama to unload the model immediately (keep_alive=0)."""
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": model, "keep_alive": 0, "prompt": ""},
            timeout=10,
        )
        return (r.status_code in (200, 204), f"ollama keep_alive=0 → {r.status_code}")
    except Exception as e:
        return (False, f"ollama unreachable: {e}")


def _unload_comfyui() -> tuple[bool, str]:
    """ComfyUI exposes POST /free with {unload_models, free_memory} flags."""
    try:
        r = httpx.post(
            f"{COMFY_URL}/free",
            json={"unload_models": True, "free_memory": True},
            timeout=10,
        )
        return (r.status_code in (200, 204), f"comfyui /free → {r.status_code}")
    except Exception as e:
        return (False, f"comfyui unreachable: {e}")


@router.post("", response_model=UnloadResponse)
def unload(target: str = "all") -> UnloadResponse:
    target = target.lower().strip()
    detail_parts: list[str] = []
    any_unloaded = False

    if target in ("tts", "all"):
        if tts_model.unload():
            detail_parts.append("tts")
            any_unloaded = True
    if target in ("whisper", "all"):
        if whisper_model.unload():
            detail_parts.append("whisper")
            any_unloaded = True
    if target in ("image", "all"):
        if image_model.unload():
            detail_parts.append("image")
            any_unloaded = True
    if target in ("ollama", "all"):
        ok, msg = _unload_ollama()
        if ok:
            any_unloaded = True
        detail_parts.append(msg)
    if target in ("comfyui", "all"):
        ok, msg = _unload_comfyui()
        if ok:
            any_unloaded = True
        detail_parts.append(msg)

    _free_torch_caches()

    return UnloadResponse(
        target=target,
        unloaded=any_unloaded,
        detail=" | ".join(detail_parts) if detail_parts else None,
        vram_free_gb=_vram_free_gb(),
    )
