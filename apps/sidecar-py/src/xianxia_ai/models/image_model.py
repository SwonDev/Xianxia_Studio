"""Lazy loader for Z-Image-Turbo (diffusers ZImagePipeline).

Auto-adapts to available VRAM:
  - >= 16 GB → load in fp16/bf16 directly on CUDA (fastest)
  - 8–16 GB  → enable_sequential_cpu_offload() (a bit slower, fits the model)
  - <  8 GB  → enable_sequential_cpu_offload() AND lower precision warnings
  - no CUDA  → CPU only (very slow but works)

Validated end-to-end on RTX 4060 Laptop (8 GB VRAM): 9 inference steps at
1344×768 take ~55 s with sequential_cpu_offload.
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
                # ~8–16 GB: keep weights on CPU, swap to GPU per layer.
                _pipe.enable_sequential_cpu_offload()
            else:
                # < 8 GB: same offload + attention slicing for tight VRAM
                _pipe.enable_sequential_cpu_offload()
                try:
                    _pipe.enable_attention_slicing()
                except Exception:
                    pass
        elif dev == "mps":
            _pipe.to("mps")
        # else: leave on CPU
    return _pipe
