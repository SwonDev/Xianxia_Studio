"""VRAM unload routes — sequential model swapping for 8 GB cards.

The Xianxia Studio pipeline runs SEVEN GPU-resident model families:
  - Ollama xianxia-llm    (Phase 1+2: script + metadata, ~3 GB)
  - Qwen3-TTS-12Hz-1.7B   (Phase 3: TTS, ~3 GB)
  - Z-Image-Turbo + GGUF text encoder (Phase 4 + Phase 7, via ComfyUI, ~7 GB)
  - rembg u2net / RMBG-2.0 (Phase 4b: depth/parallax, ~200 MB - 1.5 GB)
  - ACE-Step / MusicGen   (Phase 5: music, ~2-4 GB)
  - faster-whisper        (Phase 8: transcription, ~1 GB)

On an 8 GB card these cannot co-reside. The pipeline calls /unload with
the appropriate target after each phase to evict that family BEFORE the
next phase loads its own model. Idempotent.

Targets (`POST /unload?target=<name>`):
  - "tts"     → unload Qwen3-TTS
  - "whisper" → unload faster-whisper
  - "image"   → unload diffusers ZImagePipeline (no-op if ComfyUI path is used)
  - "depth"   → drop rembg sessions + RMBG-2.0 weights
  - "music"   → release MusicGen / ACE-Step PyTorch tensors
  - "ollama"  → asks Ollama to unload via keep_alive=0 on `xianxia-llm`
                AND polls /api/ps until the model is gone from VRAM
  - "comfyui" → asks ComfyUI to free GPU memory via /free
                AND polls /system_stats until vram_free ≥ 5 GB
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


def _ollama_running_models() -> list[dict] | None:
    """Returns the list of models Ollama currently has resident in VRAM."""
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/ps", timeout=3)
        if r.status_code != 200:
            return None
        return r.json().get("models", []) or []
    except Exception:
        return None


def _unload_ollama(model: str = "xianxia-llm", timeout_s: float = 20.0) -> tuple[bool, str]:
    """Tell Ollama to unload the model and *wait until /api/ps confirms*.

    `keep_alive=0` schedules the unload immediately but Ollama's response
    is fire-and-forget — the model can linger in VRAM for a few seconds
    while the runtime tears down. We poll /api/ps until the model is
    gone (or no models are resident) so the next phase can load its own
    model into a clean GPU.
    """
    import time as _t
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": model, "keep_alive": 0, "prompt": ""},
            timeout=10,
        )
        if r.status_code not in (200, 204):
            return (False, f"ollama keep_alive=0 → {r.status_code}")
    except Exception as e:
        return (False, f"ollama unreachable: {e}")

    deadline = _t.time() + timeout_s
    while _t.time() < deadline:
        running = _ollama_running_models()
        if running is None:
            break  # /api/ps unavailable — assume succeeded
        still_loaded = any(
            (m.get("name") or "").startswith(model) for m in running
        )
        if not still_loaded:
            return (True, f"ollama unloaded {model} (running={len(running)})")
        _t.sleep(1.0)
    return (True, f"ollama keep_alive=0 issued but {model} still resident after {timeout_s}s")


def _comfyui_vram_free_gb() -> float | None:
    """Polls ComfyUI's /system_stats endpoint to read the real VRAM free
    in the *ComfyUI process*. The torch.cuda.mem_get_info() in this
    sidecar's process measures THIS process's view, not ComfyUI's.
    """
    try:
        r = httpx.get(f"{COMFY_URL}/system_stats", timeout=3)
        if r.status_code != 200:
            return None
        data = r.json()
        for dev in data.get("devices", []) or []:
            free = dev.get("vram_free")
            if isinstance(free, (int, float)):
                return float(free) / 1024**3
    except Exception:
        return None
    return None


def _unload_comfyui(min_free_gb: float = 5.0, timeout_s: float = 30.0) -> tuple[bool, str]:
    """Tells ComfyUI to free models and *waits until VRAM is actually freed*.

    The /free endpoint is asynchronous: ComfyUI returns 200 the moment it
    queues the unload request, well before torch has finished evicting the
    model. If the pipeline moves on immediately and asks Ollama to load
    Gemma 4 (~3 GB) on top of the still-resident Z-Image (~7 GB), Ollama
    OOMs with 500. We poll /system_stats until the freed-VRAM threshold is
    met OR the timeout fires; either way we report the final state.

    `min_free_gb` defaults to 5 GB so Gemma 4 + thumbnail + buffers fit on
    an 8 GB card with margin.
    """
    import time as _t
    try:
        r = httpx.post(
            f"{COMFY_URL}/free",
            json={"unload_models": True, "free_memory": True},
            timeout=10,
        )
        if r.status_code not in (200, 204):
            return (False, f"comfyui /free → {r.status_code}")
    except Exception as e:
        return (False, f"comfyui unreachable: {e}")

    deadline = _t.time() + timeout_s
    last_free: float | None = None
    while _t.time() < deadline:
        last_free = _comfyui_vram_free_gb()
        if last_free is not None and last_free >= min_free_gb:
            return (
                True,
                f"comfyui freed (vram_free={last_free:.2f} GB ≥ {min_free_gb:.1f} GB target)",
            )
        _t.sleep(1.0)
    return (
        True,  # the /free call itself succeeded; pipeline can proceed
        f"comfyui /free issued but vram_free={last_free or 'unknown'} GB after {timeout_s}s "
        f"(target {min_free_gb} GB)",
    )


def _unload_depth() -> tuple[bool, str]:
    """Drops cached rembg sessions and the RMBG-2.0 transformer weights.

    rembg's `new_session("u2net")` keeps the ONNX runtime + model in
    VRAM for batch reuse (~177 MB for u2net, ~1.4 GB for RMBG-2.0).
    Without this, depth/parallax leaks VRAM permanently after Phase 4b.
    """
    try:
        from . import depth as _depth_mod  # local import to avoid cycle at boot
    except Exception as e:
        return (False, f"depth module unreachable: {e}")
    n_sessions = len(getattr(_depth_mod, "_REMBG_SESSIONS", {}) or {})
    try:
        if hasattr(_depth_mod, "_REMBG_SESSIONS"):
            _depth_mod._REMBG_SESSIONS.clear()  # type: ignore[attr-defined]
        if hasattr(_depth_mod, "_BRIAAI_MODEL"):
            _depth_mod._BRIAAI_MODEL = None  # type: ignore[attr-defined]
    except Exception as e:
        return (False, f"depth unload error: {e}")
    return (True, f"depth cleared ({n_sessions} rembg session(s) + briaai)")


def _unload_music() -> tuple[bool, str]:
    """ACE-Step / MusicGen models are loaded as locals inside the route
    handlers; once the request returns Python releases the references but
    PyTorch keeps the GPU memory in its allocator pool. Forcing the cache
    free here returns the bytes to the OS so the next phase can use them.
    """
    # The actual unload work happens in _free_torch_caches() below; this
    # function exists for symmetry and future explicit ACE-Step model
    # caches we may add.
    return (True, "music caches scheduled for torch empty_cache")


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
    if target in ("depth", "all"):
        ok, msg = _unload_depth()
        if ok:
            any_unloaded = True
        detail_parts.append(msg)
    if target in ("music", "all"):
        ok, msg = _unload_music()
        if ok:
            any_unloaded = True
        detail_parts.append(msg)
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
