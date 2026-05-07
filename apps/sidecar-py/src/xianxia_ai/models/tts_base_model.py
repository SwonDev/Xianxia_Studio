"""Lazy loader for the Qwen3-TTS *Base* variant.

The default TTS model in this app is `Qwen3-TTS-12Hz-1.7B-CustomVoice`
(see `tts_model.py`). That variant ships with built-in named speakers
(Vivian, Eric, Aiden…) and exposes ``generate_custom_voice()`` — but it
explicitly does NOT implement voice cloning. Per the upstream model
card (https://github.com/QwenLM/Qwen3-TTS):

  | Variant                | custom_voice | voice_clone | voice_design |
  |------------------------|:------------:|:-----------:|:------------:|
  | 1.7B-CustomVoice       |     ✓        |             |              |
  | 1.7B-Base              |              |     ✓       |              |
  | 1.7B-VoiceDesign       |              |             |     ✓        |

So when the user picks a registered voice clone, we have to swap to the
Base model. This loader is the parallel singleton for that variant; it
shares VRAM with the CustomVoice instance so we unload one before
loading the other (8 GB cards can't hold both).

If the Base weights aren't present in the HF cache (the user hasn't
installed the optional voice-cloning component yet), `load()` raises a
``RuntimeError`` with a clear message instead of silently downloading
~7 GB mid-pipeline.
"""

from __future__ import annotations

import os
from pathlib import Path
from threading import Lock

_model = None
_lock = Lock()


def is_available() -> bool:
    """Cheap check — does the user have the Base weights cached?

    Looks for the HuggingFace snapshot directory layout under HF_HOME or
    the XIANXIA cache. Returns True only when at least one snapshot
    folder under `models--Qwen--Qwen3-TTS-12Hz-1.7B-Base/snapshots/<rev>/`
    contains a `config.json` — the standard "fully downloaded" marker.
    """
    repo_id = os.environ.get(
        "XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    )
    folder_name = "models--" + repo_id.replace("/", "--")
    candidates: list[Path] = []
    for env in ("HF_HOME", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE"):
        v = os.environ.get(env)
        if v:
            candidates.append(Path(v) / "hub" / folder_name)
            candidates.append(Path(v) / folder_name)
    # Default user cache path
    candidates.append(Path.home() / ".cache" / "huggingface" / "hub" / folder_name)
    for cand in candidates:
        snapshots = cand / "snapshots"
        if snapshots.exists():
            for rev in snapshots.iterdir():
                if (rev / "config.json").exists():
                    return True
    return False


def is_loaded() -> bool:
    return _model is not None


def unload():
    """Release VRAM held by the Base model — called from /unload."""
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


def load():
    """Load the Base model with `local_files_only` so we never accidentally
    trigger a 7 GB download from a hot pipeline path. Raises a verbose
    `RuntimeError` if the weights are missing — the caller turns that
    into a 503 with actionable text on the UI ("Install voice-cloning
    component from Ajustes → Componentes opcionales").
    """
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        if not is_available():
            raise RuntimeError(
                "voice-cloning component not installed: "
                "Qwen3-TTS-Base weights not found in HF cache. "
                "Install from Ajustes → Componentes opcionales (≈7 GB)."
            )
        # Make doubly sure we don't cold-download in the middle of a
        # generation. If the user only has a partial snapshot, we'd
        # rather fail loud than block for minutes.
        os.environ.setdefault("HF_HUB_OFFLINE", "0")  # allow resume of partial — opt
        import torch  # type: ignore
        from qwen_tts import Qwen3TTSModel  # type: ignore

        repo_id = os.environ.get(
            "XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
        )
        device_map = "cuda:0" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

        kwargs = dict(device_map=device_map, dtype=dtype, local_files_only=True)
        if torch.cuda.is_available():
            try:
                _model = Qwen3TTSModel.from_pretrained(
                    repo_id, attn_implementation="flash_attention_2", **kwargs
                )
            except Exception:
                _model = Qwen3TTSModel.from_pretrained(repo_id, **kwargs)
        else:
            _model = Qwen3TTSModel.from_pretrained(repo_id, **kwargs)
    return _model
