"""Lazy model loaders — imported only when an endpoint is called.
This keeps the FastAPI server bootable even when heavy AI deps aren't installed.
"""
from . import image_model, tts_model, tts_base_model, whisper_model

__all__ = ["image_model", "tts_model", "tts_base_model", "whisper_model"]
