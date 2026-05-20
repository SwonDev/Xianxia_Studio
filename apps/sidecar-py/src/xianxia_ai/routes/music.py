"""Music: pick from local library OR generate fresh via MusicGen.

v0.2.6 — ACE-Step v1.5 retirado del pipeline.

Razón: en 8 GB VRAM (RTX 4060) ACE-Step no cabe sin `cpu_offload=True`
(README oficial lo dice explícitamente), pero la regla dura del proyecto
es GPU-only. Sin offload, en Windows el driver entra en thrash WDDM y
el sampler nunca termina (issue idéntico al #87/#344 del upstream). El
repo no tiene release tag ni mantenimiento activo del inference loop
desde enero 2026. Drop completo en v0.2.6.

Backends activos:
  1. **MusicGen-medium** (Meta, audiocraft). fp16 ≈3.5 GB VRAM, hard
     cap 30 s por pasada. Long-form vía N chunks crossfaded.
  2. **Library local** — fallback si MusicGen no está instalado o falla.

Pre-master chain (cinematic 2026 playbook):
  highpass 35 / lowpass 17000 → EQ tilt (warmth + air) →
  compressor 2.5:1 → side reverb (aecho) → loudnorm -16 LUFS.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..logging_utils import log_event

router = APIRouter()


class MusicRequest(BaseModel):
    mood: str = "epic"
    duration_seconds: float = 60.0
    use_musicgen: bool = False
    # v0.2.8 — ACE-Step v1.5 opt-in (best open-source music generator).
    # When true the route tries the isolated `runtime/acestep-venv`
    # runner first; on ANY problem (venv absent, VRAM, error, timeout)
    # it falls back MusicGen → library so the pipeline never blocks.
    use_acestep: bool = False
    library_dir: str | None = None
    out_dir: str | None = None
    # Pre-master toggle: applies the cinematic FFmpeg chain after gen.
    # Defaults true for MusicGen, ignored for library tracks (already mastered).
    premaster: bool = True
    # v0.1.38: optional topic-derived style hint that biases the score
    # toward the right era / culture (e.g. "1990s superhero TV synth"
    # for Power Rangers, "ancient Egyptian percussion and oud" for
    # Egyptian gods). Caller passes the LLM-generated setting tag here.
    style_hint: str | None = None
    # v0.7.1 — Video type preset. When set to a non-default preset, the
    # route prepends MUSIC_MOOD_TO_PROMPT[preset.music_mood] to the
    # style_hint so the score matches the narrative type
    # (documentary / explainer / listicle / comparative / deep_dive).
    # `narrative_epic` (default) is byte-identical to v0.7.0: no override.
    preset_id: str | None = None


class MusicResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    source: str  # "library" | "musicgen" | "acestep"


@router.post("", response_model=MusicResponse)
def get_music(req: MusicRequest) -> MusicResponse:
    # v0.7.1 — When a non-default video preset is selected, prepend the
    # MUSIC_MOOD_TO_PROMPT bias to the style_hint so the score matches
    # the narrative type. narrative_epic (or None) → no override
    # (byte-identical to v0.7.0). The mutation lands BEFORE the log so
    # the log line shows the actual style_hint the generators receive.
    if req.preset_id and req.preset_id != "narrative_epic":
        from ..presets import MUSIC_MOOD_TO_PROMPT, get_preset

        preset = get_preset(req.preset_id)
        bias = MUSIC_MOOD_TO_PROMPT.get(preset.music_mood)
        if bias:
            existing = (req.style_hint or "").strip()
            req.style_hint = f"{bias}, {existing}" if existing else bias

    log_event(
        "info", "music_request_received",
        mood=req.mood, duration=req.duration_seconds,
        use_musicgen=req.use_musicgen, use_acestep=req.use_acestep,
        style_hint=(req.style_hint or "")[:80],
        preset_id=req.preset_id or "",
    )
    # v0.2.9 — ACE-Step v1.5 is the PRINCIPAL music generator (no
    # toggle, no opt-in). Whenever AI music is requested we ALWAYS try
    # ACE-Step first; its venv auto-bootstraps in the background at
    # sidecar boot. `_acestep_v15` NEVER raises — it returns None on any
    # problem (venv still installing, VRAM, error, timeout) so we fall
    # through MusicGen → library. The pipeline never blocks and, once
    # the venv is ready, later runs use ACE-Step automatically with zero
    # user action. `use_acestep` is accepted for wire back-compat but is
    # no longer required (ACE-Step is the default for all AI music).
    want_ai_music = bool(req.use_musicgen or req.use_acestep)
    if want_ai_music:
        ace = _acestep_v15(req)
        if ace is not None:
            return ace
        # ACE-Step not ready / failed → MusicGen, then library.
        try:
            return _musicgen(req)
        except HTTPException:
            pass  # fall through to library — never block the pipeline

    library_dir = Path(req.library_dir or os.environ.get("XIANXIA_MUSIC_DIR", "./assets/music"))
    if not library_dir.exists():
        raise HTTPException(404, f"music library not found: {library_dir}")
    candidates = (
        list(library_dir.glob("*.mp3"))
        + list(library_dir.glob("*.m4a"))
        + list(library_dir.glob("*.wav"))
        + list(library_dir.glob("*.ogg"))
        + list(library_dir.glob("*.flac"))
    )
    if not candidates:
        raise HTTPException(404, "no music in library")
    track = random.choice(candidates)
    log_event(
        "info", "music_library_picked",
        track=str(track.name), duration=req.duration_seconds,
    )
    return MusicResponse(
        audio_path=str(track),
        duration_seconds=req.duration_seconds,
        source="library",
    )


# MusicGen-medium hard limit is ~30 s per generation pass on 8 GB VRAM in fp16.
# For longer videos we chain segments with crossfade.
_CHUNK_SECONDS = 30.0
_CROSSFADE_SECONDS = 4.0
_MUSICGEN_MIN_FREE_VRAM_GB = 4.0


def _have_musicgen() -> bool:
    try:
        import audiocraft  # noqa: F401
        return True
    except Exception:
        return False


# v0.2.13 — DEFINITIVE xformers fix. History: v0.2.7/8/9 tried to
# auto-`pip install xformers==0.0.28.post3` because audiocraft's
# memory-efficient attention raised `ImportError: xformers is not
# installed`. Every attempt failed for a structural reason proven on
# 2026-05-16 against the real runtime (Python 3.11.15, torch
# 2.5.1+cu121, win_amd64):
#   • default PyPI  → 0.0.28.post3 has NO Windows wheel (sdist only) →
#     pip builds from source in an isolated env without torch →
#     `ModuleNotFoundError: No module named 'torch'`.
#   • PyTorch cu121 index (`--index-url`) → only hosts xformers up to
#     0.0.27.post2; `0.0.28.post3` is simply not there →
#     `No matching distribution found`.
#   • `--only-binary=:all:` on PyPI → versions jump 0.0.27.post2 →
#     0.0.29.post2: there is NO prebuilt xformers wheel anywhere that
#     pairs with torch 2.5.1+cu121 on py3.11/Windows.
# Conclusion: xformers cannot be installed for this runtime, and it
# does NOT need to be. xformers is only an OPTIONAL accelerator for
# audiocraft 1.3.0 — its default attention backend is already 'torch'
# (PyTorch-native `scaled_dot_product_attention`). The hard
# `xformers is not installed` error only fires inside
# `_verify_xformers_memory_efficient_compat()`, which audiocraft calls
# *exclusively* when the backend is 'xformers'. Forcing the backend to
# 'torch' (validated end-to-end: MusicGen-medium imports AND generates
# with xformers absent) removes the dependency entirely. ACE-Step (the
# principal generator) runs in its own isolated cu128 venv and is
# unaffected; MusicGen is the GPU fallback and now self-sufficient.

# Set as early as possible — read by audiocraft at import time. Safe at
# module load because audiocraft is imported lazily inside functions.
os.environ.setdefault("XFORMERS_DISABLED", "1")


def _force_torch_attention() -> bool:
    """Make MusicGen run on PyTorch-native SDPA attention with xformers
    fully absent. Idempotent, never raises — on any problem returns False
    so the caller still falls back to the music library.

    Verified against audiocraft 1.3.0 source on the real runtime
    (2026-05-16). audiocraft conflates `memory_efficient=True` (which
    MusicGen's LM always sets) with HARD, ungated `from xformers...`
    imports scattered across the model — they fire regardless of the
    attention backend:
      • transformer.py:193/731  `_verify_xformers_memory_efficient_compat`
        (build-time import-guard, raised at model construction);
      • transformer.py:241-242  `_get_mask` → `from xformers.ops import
        LowerTriangularMask` (fires every generation step);
      • transformer.py:51 / profiler.py  xformers profiler.
    ONLY the final attention *call* honours the backend
    (transformer.py:415-419): with 'torch' it runs
    `torch.nn.functional.scaled_dot_product_attention`; the xformers
    `LowerTriangularMask` is consumed merely as a truthy causal sentinel
    (`is_causal=attn_mask is not None`) and `memory_efficient_attention`
    is never called.

    Since xformers is structurally uninstallable for this runtime (no
    wheel for torch 2.5.1+cu121/py3.11/win on any index) AND only an
    optional accelerator, we satisfy the optional import with a
    lightweight no-op shim registered in `sys.modules` BEFORE the model
    is built, and force the backend to 'torch' so the real maths stays on
    PyTorch SDPA. Validated end-to-end: MusicGen-medium builds AND
    generates audio with the shim + xformers absent.
    """
    try:
        import sys
        import types

        import torch  # type: ignore

        if "xformers" not in sys.modules:
            xf = types.ModuleType("xformers")
            xf_ops = types.ModuleType("xformers.ops")
            xf_prof = types.ModuleType("xformers.profiler")

            class LowerTriangularMask:  # causal sentinel for torch SDPA
                pass

            def _xf_unavailable(*_a, **_k):
                # Only reachable via the 'xformers' attention backend,
                # which we never select. torch SDPA does the real work.
                raise RuntimeError(
                    "xformers is disabled; MusicGen runs on torch SDPA"
                )

            def _unbind(x, dim=0):
                # audiocraft's custom packed-QKV path always calls
                # `ops.unbind(packed, dim=2)` (transformer.py:377),
                # backend-independent. xformers' unbind == torch.unbind
                # (split along dim into a tuple); SDPA accepts the views.
                return torch.unbind(x, dim)

            # audiocraft's hot path calls `_is_profiled()` every layer
            # (transformer.py:54) → `from xformers.profiler import
            # profiler; return profiler._Profiler._CURRENT_PROFILER is
            # not None`. The shim must expose that chain resolving to
            # None so profiling is reported OFF (it is — inference).
            class _ProfilerCls:
                _CURRENT_PROFILER = None

            class _ProfilerNS:
                _Profiler = _ProfilerCls

            xf_ops.LowerTriangularMask = LowerTriangularMask
            xf_ops.memory_efficient_attention = _xf_unavailable
            xf_ops.unbind = _unbind
            xf_prof.profiler = _ProfilerNS
            xf_prof.profile = _xf_unavailable
            xf.ops = xf_ops
            xf.profiler = xf_prof
            sys.modules["xformers"] = xf
            sys.modules["xformers.ops"] = xf_ops
            sys.modules["xformers.profiler"] = xf_prof

        import audiocraft.modules.transformer as _axt  # type: ignore
        _axt.set_efficient_attention_backend("torch")
        # If audiocraft.modules.transformer was imported BEFORE the shim
        # landed in sys.modules (its top-level `from xformers import ops`
        # then bound `ops = None` via the guarded ImportError, breaking
        # `ops.unbind` at transformer.py:377), rebind it to the shim.
        # Idempotent and order-independent.
        _axt.ops = sys.modules["xformers.ops"]
        return True
    except Exception as e:
        log_event("warning", "musicgen_force_torch_attention_failed",
                  error=str(e)[:200])
        return False


_ACESTEP_MIN_FREE_VRAM_GB = 4.5  # 2B SFT BF16 (~4 GB) + workspace


def _acestep_runtime_dir() -> Path:
    base = os.environ.get("XIANXIA_DATA_DIR")
    if base:
        return Path(base) / "runtime"
    return Path(os.environ.get("APPDATA", "")) / "xianxia" / "XianxiaStudio" / "data" / "runtime"


def _acestep_paths() -> tuple[Path, Path, Path]:
    """(venv_python, repo_dir, runner_script). Mirror DepthFlow's
    isolated-venv resolution. The runner ships inside the bundled
    sidecar at scripts/acestep_runner.py."""
    rt = _acestep_runtime_dir()
    venv = rt / "acestep-venv"
    win_py = venv / "Scripts" / "python.exe"
    nix_py = venv / "bin" / "python"
    venv_py = win_py if win_py.is_file() else (nix_py if nix_py.is_file() else win_py)
    repo_dir = rt / "acestep-repo"
    runner = Path(__file__).resolve().parent.parent.parent.parent / "scripts" / "acestep_runner.py"
    return venv_py, repo_dir, runner


def acestep_ready() -> bool:
    """True if the isolated ACE-Step venv + repo + runner are present."""
    venv_py, repo_dir, runner = _acestep_paths()
    return (
        venv_py.is_file()
        and (repo_dir / "acestep").is_dir()
        and runner.is_file()
    )


def _acestep_v15(req: MusicRequest) -> "MusicResponse | None":
    """ACE-Step v1.5 via the isolated venv subprocess. Returns a
    MusicResponse on success, or **None on ANY problem** (venv still
    auto-installing, VRAM too low, generation error, timeout) so the
    caller falls back MusicGen → library. NEVER raises — ACE-Step is the
    principal generator but it must not break the pipeline. GPU-only:
    the runner forces offload OFF.
    """
    venv_py, repo_dir, runner = _acestep_paths()
    if not acestep_ready():
        # v0.2.9 — kick / continue the background auto-bootstrap so the
        # venv keeps installing even if the boot warmup hasn't yet (or
        # was interrupted). Non-blocking: THIS run still falls back to
        # MusicGen → library; a later run picks up ACE-Step once ready.
        try:
            import sys as _sys
            import os as _os
            _sd = _os.path.join(
                _os.path.dirname(_os.path.dirname(_os.path.dirname(
                    _os.path.dirname(_os.path.abspath(__file__))))),
                "scripts",
            )
            if _sd not in _sys.path:
                _sys.path.insert(0, _sd)
            import acestep_bootstrap  # type: ignore
            acestep_bootstrap.ensure_async()
        except Exception:
            pass
        log_event(
            "warning", "acestep_not_ready_bootstrapping_fallback",
            venv=str(venv_py), repo=str(repo_dir), runner=str(runner),
        )
        return None

    # GPU-only VRAM pre-check (same contract as MusicGen).
    try:
        import torch  # type: ignore  # main-venv torch, just for the query
        if not torch.cuda.is_available():
            log_event("warning", "acestep_no_cuda_fallback")
            return None
        free_gb = torch.cuda.mem_get_info()[0] / (1024 ** 3)
    except Exception:
        free_gb = 0.0
    log_event("info", "acestep_vram_check",
              free_gb=round(free_gb, 2), threshold=_ACESTEP_MIN_FREE_VRAM_GB)
    if free_gb < _ACESTEP_MIN_FREE_VRAM_GB:
        log_event("warning", "acestep_low_vram_fallback", free_gb=round(free_gb, 2))
        return None

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir / f"music-raw-{uuid.uuid4().hex[:10]}.wav"
    ckpt_dir = str(
        Path(os.environ.get("HF_HOME", str(_acestep_runtime_dir().parent / "hf-cache")))
        / "acestep-ckpt"
    )
    payload = {
        "repo_dir": str(repo_dir.resolve()),
        "ckpt_dir": ckpt_dir,
        "caption": mood_to_prompt(req.mood, style_hint=req.style_hint),
        "duration": float(req.duration_seconds),
        "out_path": str(raw_path.resolve()),
        "seed": int(uuid.uuid4().int >> 96) % (2 ** 31),
        "infer_steps": 32,
    }

    log_event("info", "acestep_gen_start", backend="acestep-v15",
              duration=req.duration_seconds)
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        proc = subprocess.run(
            [str(venv_py), "-X", "utf8", str(runner), json.dumps(payload)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, cwd=str(repo_dir),
            # Generous: cold first run downloads the ~4 GB checkpoint +
            # loads the 2B model. A truly hung run still bails here so
            # the pipeline's own /music budget isn't the only guard.
            timeout=40 * 60,
        )
    except subprocess.TimeoutExpired:
        log_event("warning", "acestep_timeout_fallback")
        try: raw_path.unlink()
        except Exception: pass
        return None
    except Exception as e:  # noqa: BLE001
        log_event("warning", "acestep_subprocess_failed", error=str(e)[:200])
        return None

    last = ((proc.stdout or "").strip().splitlines() or [""])[-1]
    if proc.returncode != 0 or not last.startswith("OK "):
        log_event(
            "warning", "acestep_gen_failed",
            rc=proc.returncode,
            stdout_tail=(proc.stdout or "")[-600:],
            stderr_tail=(proc.stderr or "")[-600:],
        )
        return None
    produced = Path(last[3:].strip())
    if not produced.is_file() or produced.stat().st_size < 1024:
        log_event("warning", "acestep_empty_output_fallback", path=str(produced))
        return None

    log_event("info", "acestep_gen_done", backend="acestep-v15",
              path=str(produced))
    if not req.premaster:
        return MusicResponse(
            audio_path=str(produced),
            duration_seconds=req.duration_seconds,
            source="acestep",
        )
    try:
        final_path = _premaster(produced, out_dir)
    except Exception as e:  # noqa: BLE001 — premaster must not break opt-in
        log_event("warning", "acestep_premaster_failed_using_raw",
                  error=str(e)[:200])
        final_path = produced
    return MusicResponse(
        audio_path=str(final_path),
        duration_seconds=req.duration_seconds,
        source="acestep",
    )


def _musicgen(req: MusicRequest) -> MusicResponse:
    """Generate fresh ambient music with MusicGen-medium on GPU.

    Strict GPU-only (project rule). Pre-check VRAM and abort to library
    fallback if there isn't enough — never silently spill to CPU.

    Strategy:
      duration <= 30 s  → single pass.
      duration  > 30 s  → ceil(total / 26) chunks of 30 s with 4 s
                          crossfades, FFmpeg-merged. Same seed across
                          chunks so tonality stays coherent.
    """
    try:
        import torch  # type: ignore
        import scipy.io.wavfile as wavfile  # type: ignore
    except Exception as e:
        log_event("error", "music_gen_failed", backend="musicgen", error=str(e)[:200])
        raise HTTPException(503, f"MusicGen not ready: {e}") from e

    # v0.2.13 — install the xformers no-op shim + pin torch SDPA BEFORE
    # importing audiocraft. audiocraft.modules.transformer binds its
    # module-global `ops` from `from xformers import ops` AT IMPORT TIME;
    # if the shim isn't in sys.modules yet that resolves to None and
    # `ops.unbind` (transformer.py:377) crashes mid-generation. Running
    # this first guarantees the import sees the shim. Never blocks: on
    # the (unexpected) off chance it can't be applied, fall back to the
    # music library.
    if not _force_torch_attention():
        raise HTTPException(
            503,
            "MusicGen attention backend could not be pinned to torch — "
            "using music library this run",
        )

    try:
        from audiocraft.models import MusicGen  # type: ignore
    except Exception as e:
        log_event("error", "music_gen_failed", backend="musicgen", error=str(e)[:200])
        raise HTTPException(503, f"MusicGen not ready: {e}") from e

    # ── GPU-only pre-check ────────────────────────────────────────────
    if not torch.cuda.is_available():
        log_event("error", "music_gen_failed", backend="musicgen",
                  error="cuda_unavailable")
        raise HTTPException(503, "MusicGen requires CUDA; no GPU detected")
    try:
        free_bytes, _ = torch.cuda.mem_get_info()
        free_gb = free_bytes / (1024 ** 3)
    except Exception:
        free_gb = 0.0
    log_event("info", "music_gen_vram_check", backend="musicgen",
              free_gb=round(free_gb, 2), threshold=_MUSICGEN_MIN_FREE_VRAM_GB)
    if free_gb < _MUSICGEN_MIN_FREE_VRAM_GB:
        raise HTTPException(
            503,
            f"MusicGen needs >={_MUSICGEN_MIN_FREE_VRAM_GB} GB free VRAM, "
            f"only {free_gb:.1f} GB available — aborting to avoid CPU spill",
        )
    try:
        torch.cuda.set_device(0)
    except Exception:
        pass

    # (_force_torch_attention already ran above, before the audiocraft
    # import, so the xformers shim was in place when transformer.py bound
    # its module-global `ops`.)

    log_event("info", "music_gen_start", backend="musicgen",
              attention="torch_sdpa")
    model = MusicGen.get_pretrained("facebook/musicgen-medium")
    # fp16: ~3.5 GB VRAM (vs 6 GB fp32). Lossless quality difference for music gen.
    try:
        model.lm.half()
    except Exception:
        pass

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt = mood_to_prompt(req.mood, style_hint=req.style_hint)

    total = float(req.duration_seconds)
    if total <= _CHUNK_SECONDS:
        # Simple single-pass.
        model.set_generation_params(duration=total, cfg_coef=3.0, top_k=250)
        wav = model.generate([prompt])[0]
        raw_path = out_dir / f"music-raw-{uuid.uuid4().hex[:10]}.wav"
        wavfile.write(str(raw_path), 32000, wav.cpu().numpy().T)
    else:
        # Chunked: generate ceil(total/26) overlapping segments and crossfade.
        # Plan durations so that visible total after crossfades equals `total`.
        # visible_total = sum(chunk_durations) - (n-1)*crossfade
        n = int(-(-total // (_CHUNK_SECONDS - _CROSSFADE_SECONDS)))  # ceil
        chunk_dur = (total + (n - 1) * _CROSSFADE_SECONDS) / n
        chunk_dur = min(chunk_dur, _CHUNK_SECONDS)
        chunk_paths: list[Path] = []
        # Same seed across chunks → coherent tonality.
        seed = int(uuid.uuid4().int >> 96) % (2 ** 31)
        for i in range(n):
            try:
                torch.manual_seed(seed + i)
            except Exception:
                pass
            model.set_generation_params(duration=chunk_dur, cfg_coef=3.0, top_k=250)
            wav_i = model.generate([prompt])[0]
            cp = out_dir / f"music-chunk-{i:02d}-{uuid.uuid4().hex[:6]}.wav"
            wavfile.write(str(cp), 32000, wav_i.cpu().numpy().T)
            chunk_paths.append(cp)

        # Sequential crossfade with acrossfade. Build pairwise.
        merged = chunk_paths[0]
        for i in range(1, len(chunk_paths)):
            merged_next = out_dir / f"music-merge-{i:02d}-{uuid.uuid4().hex[:6]}.wav"
            cmd = [
                "ffmpeg", "-y",
                "-i", str(merged), "-i", str(chunk_paths[i]),
                "-filter_complex",
                f"[0][1]acrossfade=d={_CROSSFADE_SECONDS}:c1=tri:c2=tri",
                "-c:a", "pcm_s16le", str(merged_next),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                raise HTTPException(500, f"music crossfade failed: {proc.stderr[-500:]}")
            merged = merged_next
        raw_path = merged
        # Cleanup chunk files (keep merged final).
        for cp in chunk_paths:
            try: cp.unlink()
            except Exception: pass

    log_event("info", "music_gen_done", backend="musicgen", path=str(raw_path))
    if not req.premaster:
        return MusicResponse(
            audio_path=str(raw_path),
            duration_seconds=total,
            source="musicgen",
        )

    final_path = _premaster(raw_path, out_dir)
    return MusicResponse(
        audio_path=str(final_path),
        duration_seconds=total,
        source="musicgen",
    )


def _premaster(raw_path: Path, out_dir: Path) -> Path:
    """Apply the cinematic pre-master chain to a raw WAV. Returns final path."""
    final_path = out_dir / f"music-{uuid.uuid4().hex[:10]}.wav"
    af = (
        "highpass=f=35,lowpass=f=17000,"
        "equalizer=f=120:t=q:w=1.0:g=2,"
        "equalizer=f=2500:t=q:w=1.2:g=-1.5,"
        "equalizer=f=8500:t=q:w=1.0:g=1.5,"
        "acompressor=threshold=-22dB:ratio=2.5:attack=15:release=180:makeup=2,"
        "aecho=0.6:0.5:60:0.25,"
        "loudnorm=I=-16:LRA=9:TP=-1.5"
    )
    cmd = [
        "ffmpeg", "-y", "-i", str(raw_path),
        "-af", af, "-ar", "48000", "-c:a", "pcm_s24le",
        str(final_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"music premaster failed: {proc.stderr[-500:]}")
    try:
        raw_path.unlink()
    except Exception:
        pass
    return final_path


@router.get("/backends")
async def music_backends() -> dict:
    """Report whether MusicGen is available right now.

    The frontend uses this to decide whether to show the MusicGen
    option in the mood selector tooltip.

    v0.2.8 — `acestep_available` now reflects whether the isolated
    ACE-Step v1.5 venv + repo + runner are actually present, so the
    Settings panel can show the user if the opt-in is ready.
    """
    have_musicgen = _have_musicgen()
    have_acestep = acestep_ready()
    return {
        "acestep_available": have_acestep,
        "musicgen_available": have_musicgen,
        "preferred": (
            "acestep" if have_acestep
            else ("musicgen" if have_musicgen else None)
        ),
    }


# v0.1.38: TOPIC-AGNOSTIC mood prompts. Earlier versions hardcoded
# "xianxia, erhu, guzheng, taiko" into every mood, so the music always
# sounded Chinese regardless of the video's actual topic. Now each mood
# describes EMOTION + universal cinematic instruments. The caller can
# optionally pass a `style_hint` (derived from the topic's setting tag)
# that gets prepended to bias the score toward the right era / culture.
_MOOD_BASE_MUSICGEN = {
    "epic":        "cinematic orchestral, sweeping strings, brass swells, thunderous percussion, rising tension, 78bpm, D minor, no vocals, heroic, Hans Zimmer-inspired",
    "serene":      "soft piano, warm strings, ambient pad, gentle and meditative, 60bpm, A major, no vocals, calm and reflective",
    "mystic":      "ethereal pads, low percussion, breathy choir, mysterious atmosphere, slow build, 65bpm, F# minor, no vocals",
    "emotional":   "solo piano, melancholic strings, heartfelt and slow, 55bpm, B minor, no vocals, intimate",
    "tense":       "pulsing low strings, syncopated percussion, suspense-building, 90bpm, C minor, no vocals",
    "melancholic": "lonely cello, sparse piano, distant ambience, contemplative sadness, 50bpm, E minor, no vocals",
    "triumphant":  "bright brass fanfare, full orchestra, rising chord progression, victorious, 100bpm, C major, no vocals",
    "action":      "driving percussion, electric guitars, synth bass, urgent tempo, 120bpm, A minor, no vocals, modern hybrid score",
}


def _compose_music_prompt(base: str, style_hint: str | None) -> str:
    """Prepend a topic-derived style hint when available so the score
    leans into the right era / culture (e.g. '1990s superhero TV synth'
    for Power Rangers vs 'orchestral score with subtle Asian flourishes'
    for a Chinese mythology topic).
    """
    if style_hint and style_hint.strip():
        hint = style_hint.strip().rstrip(".").lower()
        if len(hint) > 90:
            hint = hint[:90].rsplit(" ", 1)[0]
        return f"{hint}, {base}"
    return base


def mood_to_prompt(mood: str, style_hint: str | None = None) -> str:
    base = _MOOD_BASE_MUSICGEN.get(mood, "cinematic ambient, no vocals")
    return _compose_music_prompt(base, style_hint)
