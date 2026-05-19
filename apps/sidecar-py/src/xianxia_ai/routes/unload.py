"""VRAM unload routes — sequential model swapping for 8 GB cards.

The Xianxia Studio pipeline runs SEVEN GPU-resident model families:
  - Ollama xianxia-llm    (Phase 1+2: script + metadata, ~3 GB)
  - Qwen3-TTS-12Hz-1.7B   (Phase 3: TTS, ~3 GB)
  - Z-Image-Turbo + GGUF text encoder (Phase 4 + Phase 7, via ComfyUI, ~7 GB)
  - rembg u2net / RMBG-2.0 (Phase 4b: depth/parallax, ~200 MB - 1.5 GB)
  - MusicGen-medium       (Phase 5: music, ~3-4 GB)
  - faster-whisper        (Phase 8: transcription, ~1 GB)

On an 8 GB card these cannot co-reside. The pipeline calls /unload with
the appropriate target after each phase to evict that family BEFORE the
next phase loads its own model. Idempotent.

Targets (`POST /unload?target=<name>`):
  - "tts"     → unload Qwen3-TTS
  - "whisper" → unload faster-whisper
  - "image"   → unload diffusers ZImagePipeline (no-op if ComfyUI path is used)
  - "depth"   → drop rembg sessions + RMBG-2.0 weights
  - "music"   → release MusicGen PyTorch tensors
  - "ollama"  → asks Ollama to unload via keep_alive=0 on `xianxia-llm`
                AND polls /api/ps until the model is gone from VRAM
  - "comfyui" → asks ComfyUI to free GPU memory via /free
                AND polls /system_stats until vram_free ≥ 5 GB
  - "all"     → all of the above
"""

from __future__ import annotations

import os
import gc

import asyncio

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from ..llm_backend import get_backend
from ..models import image_model, tts_model, tts_base_model, whisper_model

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


def _unload_llm(model: str = "xianxia-llm", timeout_s: float = 20.0) -> tuple[bool, str]:
    """Release the active LLM from VRAM between pipeline phases.

    Two paths depending on which backend is currently serving:
      * Ollama → POST /api/generate with keep_alive=0 + poll /api/ps until
        the model is evicted (legacy v0.1.x behaviour, still supported).
      * llama.cpp → **kill the `llama-server.exe` process** and create a
        `.llamacpp_suspended` sentinel file under `<data_dir>/`. The Rust
        supervisor reads that flag in `spawn_llama_if_needed` and stops
        respawning while it exists, so VRAM stays free for the next phase
        (ComfyUI image generation, TTS, etc.). The next LLM call clears
        the flag and waits for the supervisor to bring the server back —
        same "lazy reload" pattern v0.1.x had with Ollama's keep_alive.

    Why: llama-server has NO keep_alive equivalent. The process retains
    VRAM until it dies. Without this kill+suspend step llama.cpp would
    keep ~5 GB pinned through the image phase, evicting Z-Image to RAM
    and slowing ComfyUI from 1-2 s/iter to 50-90 s/iter (same OOM-spill
    bug we hit in v0.1.28 for TTS).
    """
    backend = get_backend()
    if backend.name == "llamacpp":
        return _kill_llamacpp_process(timeout_s=timeout_s)
    # Ollama path — keep the original async unload semantics.
    try:
        return asyncio.run(backend.unload(model=model, timeout_s=timeout_s))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(backend.unload(model=model, timeout_s=timeout_s))
        finally:
            loop.close()


def _data_dir_for_flag() -> "Path":  # type: ignore[name-defined]
    """Same data_dir resolution the Rust supervisor uses. Kept local so this
    module doesn't have to import the routes/models.py helpers (circular).
    """
    from pathlib import Path
    if env := os.environ.get("XIANXIA_DATA_DIR"):
        return Path(env)
    if appdata := os.environ.get("APPDATA"):
        return Path(appdata) / "xianxia" / "XianxiaStudio" / "data"
    return Path.home() / ".local" / "share" / "xianxia" / "XianxiaStudio" / "data"


def _kill_llamacpp_process(timeout_s: float = 10.0) -> tuple[bool, str]:
    """Find and kill all `llama-server.exe` processes whose cmdline points
    inside our runtime/ tree, then drop the suspend flag so the supervisor
    won't immediately respawn. Idempotent — running twice in a row is fine.
    """
    flag = _data_dir_for_flag() / ".llamacpp_suspended"
    try:
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("suspended by /unload?target=llm\n", encoding="utf-8")
    except OSError as exc:
        return (False, f"could not write suspend flag: {exc}")

    try:
        import psutil  # type: ignore
    except ImportError:
        return (True, "psutil not available; flag set, supervisor will catch up")

    runtime_marker = str(_data_dir_for_flag() / "runtime").lower()
    killed = 0
    for proc in psutil.process_iter(["name", "exe", "cmdline"]):
        try:
            name = (proc.info.get("name") or "").lower()
            if not name.startswith("llama-server"):
                continue
            exe = (proc.info.get("exe") or "").lower()
            cmdline = " ".join(proc.info.get("cmdline") or []).lower()
            # Match either the binary path or its cmdline pointing at our
            # runtime dir so we never kill a llama-server from another app.
            if runtime_marker in exe or runtime_marker in cmdline:
                proc.terminate()
                try:
                    proc.wait(timeout=timeout_s)
                except psutil.TimeoutExpired:
                    proc.kill()
                killed += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return (True, f"llamacpp killed {killed} process(es); suspended flag set at {flag}")


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
    """Aggressively reclaim VRAM held by the music generator.

    MusicGen is loaded as a LOCAL inside `routes/music.py::_musicgen`, so
    by the time this runs the reference is already dropped — but PyTorch
    keeps the bytes in its caching allocator and, worse, any CUDA context
    state can linger. v0.2.5 had a real incident where the (now removed)
    ACE-Step attempt left ~4 GB pinned through to the thumbnail phase,
    starving the Z-Image cold reload into a 30-min Sysmem-fallback hang.

    v0.2.6 — don't just *schedule* a cache free; do a hard reclaim here
    and report the freed VRAM so the caller (and the Rust supervisor's
    `ensure_comfyui_vram`) can make a real decision:
      * multiple `gc.collect()` passes (torch nn.Modules form reference
        cycles that a single pass won't break)
      * `torch.cuda.empty_cache()` — return cached blocks to the driver
      * `torch.cuda.ipc_collect()` — release cross-process IPC handles
      * `torch.cuda.synchronize()` — make the free actually happen before
        we measure
    """
    before = _vram_free_gb()
    try:
        import torch  # type: ignore
    except Exception:
        return (True, "music: torch unavailable, nothing to reclaim")

    for _ in range(3):
        gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
            torch.cuda.synchronize()
    except Exception as e:
        return (True, f"music reclaim partial ({e})")

    after = _vram_free_gb()
    if before is not None and after is not None:
        return (
            True,
            f"music VRAM reclaimed ({before:.2f} → {after:.2f} GB free)",
        )
    return (True, "music VRAM reclaimed (hard gc + empty_cache + ipc_collect)")


@router.post("", response_model=UnloadResponse)
def unload(target: str = "all") -> UnloadResponse:
    target = target.lower().strip()
    detail_parts: list[str] = []
    any_unloaded = False

    if target in ("tts", "all"):
        # CustomVoice (built-in speakers).
        if tts_model.unload():
            detail_parts.append("tts")
            any_unloaded = True
        # Base (voice cloning) — v0.1.28: was being missed, leaving 7 GB
        # of Qwen3-TTS-Base resident while ComfyUI tried to generate
        # images. ComfyUI fell into CPU↔GPU swap and went from 1-2 s/iter
        # to 50-90 s/iter (50× slower). When the user picks a clone voice
        # the Base variant is what gets loaded; this branch must unload
        # both so the SD phase has the full VRAM available.
        if tts_base_model.unload():
            detail_parts.append("tts_base")
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
    # `llm` is the v0.2.0 canonical target name; `ollama` kept as an alias
    # so existing pipeline callers (Rust supervisor /unload?target=ollama)
    # keep working during the migration.
    if target in ("llm", "ollama", "all"):
        ok, msg = _unload_llm()
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
