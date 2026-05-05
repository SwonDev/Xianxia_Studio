"""Lazy loader for Qwen3-TTS (qwen_tts package)."""

from __future__ import annotations

import os
from threading import Lock

_model = None
_lock = Lock()


def unload():
    """Release VRAM held by the cached Qwen3-TTS instance.

    Called between pipeline phases on 8 GB cards so the next phase
    (Z-Image-Turbo, faster-whisper) can claim the freed memory. Idempotent.
    """
    global _model
    with _lock:
        if _model is None:
            return False
        _model = None
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
    return _model is not None


def load():
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        import torch  # type: ignore
        from qwen_tts import Qwen3TTSModel  # type: ignore

        model_id = os.environ.get(
            "XIANXIA_TTS_MODEL",
            "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        )
        device_map = "cuda:0" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

        kwargs = dict(device_map=device_map, dtype=dtype)
        # flash_attention_2 only on CUDA
        if torch.cuda.is_available():
            try:
                _model = Qwen3TTSModel.from_pretrained(
                    model_id, attn_implementation="flash_attention_2", **kwargs
                )
            except Exception:
                _model = Qwen3TTSModel.from_pretrained(model_id, **kwargs)
        else:
            _model = Qwen3TTSModel.from_pretrained(model_id, **kwargs)
    return _model
