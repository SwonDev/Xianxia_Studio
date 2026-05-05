"""Lazy loader for faster-whisper."""

from __future__ import annotations

import os
from threading import Lock

_model = None
_lock = Lock()


def unload():
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
        from faster_whisper import WhisperModel  # type: ignore
        import torch  # type: ignore

        size = os.environ.get("XIANXIA_WHISPER_SIZE", "large-v3")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute = "float16" if device == "cuda" else "int8"
        _model = WhisperModel(size, device=device, compute_type=compute)
    return _model
