"""Lazy loader for Z-Image-Turbo (diffusers ZImagePipeline).

v0.2.4 — REGLA GPU-only del proyecto. Este loader es un FALLBACK para
el path ComfyUI: solo se usa cuando el caller pide diffusers directo.
Si la GPU no tiene suficiente VRAM (>=8 GB libres), aborta limpio con
un RuntimeError y la pipeline cae al path ComfyUI (que es el camino
preferente y tiene sus propias estrategias de carga).

  - >= 16 GB → load in fp16/bf16 directly on CUDA (fastest)
  - 8–16 GB  → load directly on CUDA (GPU only, sin sequential offload)
  - <  8 GB  → aborta limpio (RuntimeError); el caller usa ComfyUI
  - no CUDA  → CPU only (very slow but works, solo dev/test)

Validated end-to-end on RTX 4060 Laptop (8 GB VRAM): 9 inference steps at
1344×768 take ~55 s en GPU directo. Si no cabe, NO hay spill a CPU.
"""

from __future__ import annotations

import os
from threading import Lock

_pipe = None
_lock = Lock()


def device() -> str:
    import torch  # type: ignore
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def vram_gb() -> float:
    import torch  # type: ignore
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.get_device_properties(0).total_memory / 1024**3


def unload():
    """Free VRAM held by the diffusers pipeline (only relevant when not using
    the ComfyUI path)."""
    global _pipe
    with _lock:
        if _pipe is None:
            return False
        _pipe = None
        try:
            import torch  # type: ignore
            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
        except Exception:
            pass
        return True


def is_loaded() -> bool:
    return _pipe is not None


def load():
    global _pipe
    if _pipe is not None:
        return _pipe
    with _lock:
        if _pipe is not None:
            return _pipe
        import torch  # type: ignore
        from diffusers import ZImagePipeline  # type: ignore

        model_id = os.environ.get("XIANXIA_IMAGE_MODEL", "Tongyi-MAI/Z-Image-Turbo")
        dev = device()
        vram = vram_gb()

        # Pick dtype: bf16 if Ampere+ on CUDA, fp16 otherwise on CUDA, fp32 on CPU.
        if dev == "cuda":
            dtype = torch.bfloat16 if torch.cuda.get_device_capability(0)[0] >= 8 else torch.float16
        elif dev == "mps":
            dtype = torch.float16
        else:
            dtype = torch.float32

        _pipe = ZImagePipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )

        # VRAM-aware placement
        if dev == "cuda":
            if vram >= 16.0:
                _pipe.to("cuda")
            elif vram >= 8.0:
                # v0.2.4 — REGLA GPU-only. Si no cabe en VRAM, abortar limpio en
                # lugar de spilling a CPU (la pipeline tiene fallback a ComfyUI
                # cuando este diffusers path falla — ese es el comportamiento
                # correcto). GPU only, aborta limpio si no cabe.
                _pipe = None
                raise RuntimeError(
                    "VRAM insufficient for diffusers fallback; ComfyUI path will be used"
                )
            else:
                # v0.2.4 — REGLA GPU-only. Si no cabe en VRAM, abortar limpio en
                # lugar de spilling a CPU (la pipeline tiene fallback a ComfyUI
                # cuando este diffusers path falla — ese es el comportamiento
                # correcto). GPU only, aborta limpio si no cabe.
                _pipe = None
                raise RuntimeError(
                    "VRAM insufficient for diffusers fallback; ComfyUI path will be used"
                )
        elif dev == "mps":
            _pipe.to("mps")
        # else: leave on CPU
    return _pipe
