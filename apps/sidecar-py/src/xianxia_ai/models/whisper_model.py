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


def transcribe_words(audio_path: str, language: str | None = None, *, vad: bool = False):
    """Single source of truth for word-level transcription.

    v0.2.16 — consolidates the two previously divergent call sites
    (subtitles.py vs shorts_auto.py /from_video). The permissive anti-drop
    thresholds below were tuned in subtitles.py so the FIRST sentence of
    synthetic narration is never discarded (faster-whisper's defaults
    sometimes drop the opening utterance when the voice has a soft attack
    or the no-speech / log-prob filters judge segment 0 low-confidence).
    Sharing them means Shorts hooks — where the opening words matter most —
    also stop losing the first utterance.

    `vad` is the only knob: ``False`` (default) for clean TTS narration,
    ``True`` for arbitrary uploaded video (skips long non-speech stretches).
    Returns ``(segments_list, info)`` — ``segments`` materialised so the
    generator is consumed off the FastAPI event loop by the caller's
    ``asyncio.to_thread`` wrapper.
    """
    model = load()
    segments, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        beam_size=5,
        vad_filter=vad,
        condition_on_previous_text=False,
        no_speech_threshold=0.05,
        compression_ratio_threshold=4.0,
        log_prob_threshold=-2.0,
        temperature=0.0,
    )
    return list(segments), info
