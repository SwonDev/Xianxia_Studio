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


_MIN_WEIGHT_BYTES = 100 * 1024 * 1024  # 100 MB minimum for a real weight file


def _candidate_paths() -> list[Path]:
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
    candidates.append(Path.home() / ".cache" / "huggingface" / "hub" / folder_name)
    return candidates


def _snapshot_is_complete(snapshot_dir: Path) -> bool:
    """A snapshot is COMPLETE only when it has both config.json AND a
    real weight blob (≥ 100 MB). This prevents the v0.1.23 bug where
    a partial download (metadata only) was reported as "available",
    then load() failed minutes later mid-pipeline.
    """
    if not (snapshot_dir / "config.json").exists():
        return False
    # Look for any weight-like file
    weight_globs = ("*.safetensors", "*.bin", "*.pt", "*.pth")
    for pat in weight_globs:
        for w in snapshot_dir.glob(pat):
            try:
                # Note: HF cache stores blobs as symlinks; resolve to
                # check the real file size on disk.
                real = w.resolve() if w.is_symlink() else w
                if real.exists() and real.stat().st_size >= _MIN_WEIGHT_BYTES:
                    return True
            except (OSError, RuntimeError):
                continue
    return False


def is_available() -> bool:
    """Robust check — Base weights AND a real weight blob present.

    v0.1.24 fix: previously only checked for `config.json`, which is a
    1 KB metadata file that often lands in the cache before the multi-
    GB `model.safetensors` does. A failed download mid-flight left the
    user with `is_available() == True` and `load()` blowing up minutes
    later. Now we require BOTH config.json AND at least one weight
    file ≥ 100 MB so partial downloads can't fool the gate.
    """
    for cand in _candidate_paths():
        snapshots = cand / "snapshots"
        if not snapshots.exists():
            continue
        for rev in snapshots.iterdir():
            if _snapshot_is_complete(rev):
                return True
    return False


def get_install_state() -> dict:
    """Diagnostic — returns what is/isn't on disk so the UI can show
    progress on a partial download instead of a binary failed/done.

    Counts BOTH:
      - Snapshot weights (the symlinks ready in snapshots/<rev>/),
        which means a file is fully downloaded.
      - Partial blobs in `blobs/` (huggingface_hub's content store
        before commit), so we can show live progress while a multi-GB
        download is still in flight.
    """
    repo_id = os.environ.get(
        "XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    )
    state = {
        "repo_id": repo_id,
        "available": False,
        "has_config": False,
        "has_weights": False,
        "weight_bytes": 0,        # complete weights (symlinks in snapshots)
        "in_flight_bytes": 0,     # bytes in blobs/ (full + partial)
        "found_paths": [],
    }
    for cand in _candidate_paths():
        snapshots = cand / "snapshots"
        if snapshots.exists():
            for rev in snapshots.iterdir():
                if (rev / "config.json").exists():
                    state["has_config"] = True
                    for pat in ("*.safetensors", "*.bin", "*.pt", "*.pth"):
                        for w in rev.glob(pat):
                            try:
                                real = w.resolve() if w.is_symlink() else w
                                if real.exists():
                                    sz = real.stat().st_size
                                    state["weight_bytes"] += sz
                                    state["found_paths"].append(
                                        {"name": w.name, "bytes": sz}
                                    )
                            except (OSError, RuntimeError):
                                pass
        # Sample blobs/ for in-flight bytes — huggingface_hub stores
        # incomplete downloads as `<hash>.incomplete` next to fully-
        # downloaded blobs.
        blobs = cand / "blobs"
        if blobs.exists():
            for b in blobs.iterdir():
                try:
                    if b.is_file():
                        state["in_flight_bytes"] += b.stat().st_size
                except (OSError, RuntimeError):
                    pass
    state["has_weights"] = state["weight_bytes"] >= _MIN_WEIGHT_BYTES
    state["available"] = state["has_config"] and state["has_weights"]
    return state


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
        # v0.1.26: must NOT force offline. The model's internals call
        # `extract_speaker_embedding(...)` and `speech_tokenizer.encode(...)`
        # at synth time, both of which load *separate* sub-models on first
        # use (speaker encoder, codec). Those sub-loads ignore the
        # parent's `local_files_only` flag and respect HF_HUB_OFFLINE
        # instead. If the supervisor or .exe bundle ever set HF_HUB_OFFLINE=1
        # in the spawned env (we have, intermittently), the synth path
        # blew up with "We couldn't connect to https://huggingface.co" mid-
        # generation even though the main 7 GB weights are cached.
        # Fix: clear/override HF_HUB_OFFLINE here and DROP local_files_only.
        # The 7 GB main weights are gated by is_available() above, so the
        # only thing that can be cold-downloaded now is a few KB of small
        # sub-component configs the first time a user clones a voice.
        os.environ["HF_HUB_OFFLINE"] = "0"
        os.environ.pop("TRANSFORMERS_OFFLINE", None)
        import torch  # type: ignore
        from qwen_tts import Qwen3TTSModel  # type: ignore

        repo_id = os.environ.get(
            "XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
        )
        device_map = "cuda:0" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

        kwargs = dict(device_map=device_map, dtype=dtype)
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
