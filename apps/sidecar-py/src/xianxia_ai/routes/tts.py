"""Text-to-speech via Qwen3-TTS (qwen-tts package).

Three modes:
  1. **Builtin speakers** — the 9 named speakers shipped with the
     Qwen3-TTS-12Hz-1.7B-CustomVoice config (vivian, serena, ryan, …).
  2. **Voice clones** — the user's own voice from a 5-10 s reference clip,
     using `generate_voice_clone` (the official Qwen3-TTS API). Stored under
     `<XIANXIA_OUT_DIR>/../voice_clones/<id>/` with a JSON manifest.
  3. **Voice design** — natural-language style instruction → new voice via
     `generate_voice_design`. Useful when no reference clip is available.

The synthesis call runs inside a thread executor so the FastAPI event loop
keeps responding to /health, /unload, etc. while torch.generate is busy.
That's what keeps the topbar dots green during a multi-minute TTS phase.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

import logging

from ..models import tts_model, tts_base_model

log = logging.getLogger("xianxia.tts")

router = APIRouter()


# Speaker → language affinity. Qwen3-TTS speakers are cross-lingual but tuned
# for a primary language. Used by /voices to drive a contextual selector.
_SPEAKER_PROFILE = {
    "vivian":   {"gender": "female", "tone": "epic narrator", "languages": ["en", "es", "zh", "ja", "ko"], "primary": "en", "description": "Femenina, narradora cinematográfica épica."},
    "serena":   {"gender": "female", "tone": "soft", "languages": ["en", "es", "zh", "ja"], "primary": "en", "description": "Femenina, voz suave y multilingüe."},
    "ryan":     {"gender": "male",   "tone": "deep", "languages": ["en", "es"], "primary": "en", "description": "Masculina, voz grave."},
    "aiden":    {"gender": "male",   "tone": "young", "languages": ["en", "es"], "primary": "en", "description": "Masculina, joven."},
    "uncle_fu": {"gender": "male",   "tone": "elder",  "languages": ["zh", "en"], "primary": "zh", "description": "Masculina, anciano sabio (recomendado para xianxia)."},
    "eric":     {"gender": "male",   "tone": "sichuan dialect", "languages": ["zh"], "primary": "zh", "description": "Masculina, dialecto Sichuan."},
    "dylan":    {"gender": "male",   "tone": "beijing dialect", "languages": ["zh"], "primary": "zh", "description": "Masculina, dialecto Beijing."},
    "sohee":    {"gender": "female", "tone": "korean", "languages": ["ko", "en", "es"], "primary": "ko", "description": "Femenina, coreana."},
    "ono_anna": {"gender": "female", "tone": "japanese", "languages": ["ja", "en", "es"], "primary": "ja", "description": "Femenina, japonesa."},
}

_LANG_TO_QWEN = {
    "en": "English",
    "es": "Spanish",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
}


def _clones_dir() -> Path:
    """Persistent voice-clone library: kept separate from `out_dir` so renders
    can be cleaned without losing the user's voice references."""
    base = Path(os.environ.get("XIANXIA_OUT_DIR", "./out")).parent
    p = base / "voice_clones"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load_clone_manifest() -> list[dict]:
    f = _clones_dir() / "manifest.json"
    if not f.exists():
        return []
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_clone_manifest(m: list[dict]) -> None:
    f = _clones_dir() / "manifest.json"
    f.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


# ─── Schemas ────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    language: str = "English"
    speaker: str = "Vivian"
    instruction: str | None = None
    # 220 chars/chunk gives Qwen3-TTS-1.7B ~30-50 s of inference per chunk
    # on a laptop RTX 4060 8 GB. The previous 600-char default produced
    # 5–6 minute chunks because the autoregressive decoder time scales
    # super-linearly with sequence length. Smaller chunks keep the worst
    # case bounded so long narrations stay under a few minutes wall-time.
    chunk_chars: int = 350
    out_dir: str | None = None


class TTSResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    chunks: int


class VoiceProfile(BaseModel):
    id: str
    label: str
    gender: str
    tone: str
    languages: list[str]
    primary: str
    description: str
    kind: Literal["builtin", "clone"] = "builtin"


class CloneRegistration(BaseModel):
    id: str
    label: str
    gender: str
    primary: str
    description: str
    ref_audio_path: str
    ref_text: str | None = None


# ─── Voices catalog ────────────────────────────────────────────────

@router.get("/voices", response_model=list[VoiceProfile])
async def list_voices(language: str | None = None) -> list[VoiceProfile]:
    """List builtin Qwen3-TTS speakers + user voice clones, optionally
    filtered+ranked by language affinity."""
    profiles: list[VoiceProfile] = []
    # Builtin
    for spk, meta in _SPEAKER_PROFILE.items():
        profiles.append(
            VoiceProfile(
                id=spk,
                label=spk.replace("_", " ").title(),
                gender=meta["gender"],
                tone=meta["tone"],
                languages=meta["languages"],
                primary=meta["primary"],
                description=meta["description"],
                kind="builtin",
            )
        )
    # User clones — only surface them if the Base model is installed,
    # because that's the only Qwen3-TTS variant that supports voice
    # cloning. With CustomVoice alone the clone would fail at synth
    # time with a confusing "model does not support generate_voice_clone".
    # Better to hide them in the picker entirely until the user adds
    # the optional component.
    base_ready = tts_base_model.is_available()
    if base_ready:
        for c in _load_clone_manifest():
            profiles.append(
                VoiceProfile(
                    id=f"clone:{c['id']}",
                    label=c.get("label", c["id"]),
                    gender=c.get("gender", "neutral"),
                    tone="cloned voice",
                    languages=["en", "es", "zh", "ja", "ko"],  # cross-lingual via Qwen3-TTS
                    primary=c.get("primary", "es"),
                    description=c.get("description", "Voz clonada por el usuario."),
                    kind="clone",
                )
            )

    if language:
        lang = language.lower()[:2]
        profiles = [p for p in profiles if lang in p.languages]
        # Clones float to the top, then primary=lang matches first
        profiles.sort(key=lambda p: (p.kind != "clone", p.primary != lang, p.id))
    return profiles


# ─── Synthesis ─────────────────────────────────────────────────────

def _do_synthesize_builtin(text: str, language: str, speaker: str, instruct: str):
    model = tts_model.load()
    return model.generate_custom_voice(
        text=text, language=language, speaker=speaker, instruct=instruct,
    )


# v0.1.34: post-synthesis loudness normalization. Qwen3-TTS-Base (voice
# cloning) emits audio at ~-22 to -25 LUFS, while CustomVoice presets
# come out at ~-15 LUFS. Normalizing both to -14 LUFS (YouTube/Spotify
# standard) keeps the listener experience consistent regardless of which
# voice path produced the audio. Plus a -1 dBTP peak ceiling to prevent
# clipping on consumer playback.
def _loudnorm_audio(audio, sr, target_lufs=-14.0, peak_db=-1.0):
    """Normalize a 1D float32 numpy array to target LUFS + peak ceiling.

    Falls back to peak normalization if pyloudnorm isn't available.
    """
    import numpy as _np
    if audio is None or len(audio) == 0:
        return audio
    audio = audio.astype("float32", copy=False)
    try:
        import pyloudnorm as pyln
        # ITU-R BS.1770-4 integrated loudness measurement.
        meter = pyln.Meter(sr)
        loudness = meter.integrated_loudness(audio)
        # If the source was effectively silent, integrated_loudness
        # returns -inf — skip normalization to avoid blowing up gain.
        if loudness == float("-inf") or loudness != loudness:  # NaN check
            return audio
        normalized = pyln.normalize.loudness(audio, loudness, target_lufs)
    except Exception:
        # Fallback: peak normalize so at least it isn't muffled.
        peak = float(_np.max(_np.abs(audio))) or 1.0
        target_peak = 10 ** (peak_db / 20.0)
        normalized = audio * (target_peak / peak)
    # Hard peak limiter at peak_db dBTP to avoid clipping after LUFS gain.
    target_peak = 10 ** (peak_db / 20.0)
    peak = float(_np.max(_np.abs(normalized))) if len(normalized) else 0.0
    if peak > target_peak and peak > 0:
        normalized = normalized * (target_peak / peak)
    return normalized.astype("float32")


# Module-level prompt cache keyed by (ref_audio_path, mtime_ns).
# Saves the ~10-15 s extract_speaker_embedding + tokenize for the SAME
# voice across consecutive requests. Invalidated automatically if the
# user re-records / replaces the ref_audio file (mtime changes).
_clone_prompt_cache: dict[tuple, object] = {}
_clone_prompt_cache_lock = __import__("threading").Lock()


def _build_clone_prompt(ref_audio: str):
    """Build the voice-clone prompt ONCE per request.

    Internally extracts:
      - speech codes via `speech_tokenizer.encode(ref_audio)`
      - speaker embedding via `extract_speaker_embedding(ref_audio)` (resampled to 24 kHz)

    Both are expensive (~5-10 s on GPU) and were being recomputed per
    chunk in v0.1.26 — that's why a 10-chunk request took ~8-10 min
    instead of the ~1 min you'd expect from the direct test (3x faster
    than realtime). Per the upstream docs:
      "To avoid recomputing features across multiple generations,
       build it once with create_voice_clone_prompt"
    """
    if tts_model.is_loaded():
        tts_model.unload()
    try:
        model = tts_base_model.load()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Voice cloning requires the Qwen3-TTS-Base model "
                "(≈7 GB) and it's not installed yet. Open "
                "Ajustes → Componentes opcionales → Voice Cloning "
                "to download it. Original error: " + str(exc)
            ),
        ) from exc
    # x_vector_only_mode=True per v0.1.25: ICL with ref_text was producing
    # wrong-gender output. Embedding-only is robust across mic/file/URL refs.
    try:
        mtime = os.stat(ref_audio).st_mtime_ns
    except OSError:
        mtime = 0
    cache_key = (str(ref_audio), mtime)
    with _clone_prompt_cache_lock:
        cached = _clone_prompt_cache.get(cache_key)
    if cached is not None:
        return model, cached
    prompt_item = model.create_voice_clone_prompt(
        ref_audio=ref_audio, ref_text=None, x_vector_only_mode=True,
    )[0]
    with _clone_prompt_cache_lock:
        _clone_prompt_cache[cache_key] = prompt_item
    return model, prompt_item


def _synthesize_clone_batch(model, prompt_item, texts: list[str], language: str):
    """Single batched call — replays the precomputed prompt across all
    chunks. Returns (list_of_wavs, sample_rate). Avoids the per-chunk
    speaker-embedding recomputation that was bottlenecking v0.1.26."""
    languages = [language] * len(texts)
    prompts = [prompt_item] * len(texts)
    return model.generate_voice_clone(
        text=texts, language=languages, voice_clone_prompt=prompts,
    )


def _do_synthesize_clone(text: str, language: str, ref_audio: str, ref_text: str | None):
    """Voice cloning runs on the SEPARATE *Base* model variant.

    Per the upstream Qwen3-TTS model card
    (https://github.com/QwenLM/Qwen3-TTS):

      - Qwen3-TTS-1.7B-CustomVoice → only generate_custom_voice() (preset speakers)
      - Qwen3-TTS-1.7B-Base        → only generate_voice_clone()

    They are TWO different checkpoints. The bundled stack ships
    CustomVoice for narration (it's smaller in cold-start because it
    has the speaker presets baked in). The Base model is an OPTIONAL
    component the user installs from Ajustes when they need voice
    cloning. We swap models at runtime: unload CustomVoice → load Base
    → run clone → on next non-clone request the supervisor unloads
    Base + reloads CustomVoice. Both can't coexist in 8 GB VRAM.

    If the Base model isn't installed we surface a clean 503 with a
    message the UI can show instead of a confusing 500.
    """
    # Free CustomVoice from VRAM before loading Base — both ~7 GB.
    if tts_model.is_loaded():
        tts_model.unload()
    try:
        model = tts_base_model.load()
    except RuntimeError as exc:
        # is_available() returned False → component not installed.
        raise HTTPException(
            status_code=503,
            detail=(
                "Voice cloning requires the Qwen3-TTS-Base model "
                "(≈7 GB) and it's not installed yet. Open "
                "Ajustes → Componentes opcionales → Voice Cloning "
                "to download it. Original error: " + str(exc)
            ),
        ) from exc
    # v0.1.25: ALWAYS use x_vector_only_mode=True.
    # ICL mode (with ref_text) was producing wrong-gender / wrong-timbre
    # output for refs extracted from URLs because:
    #   - whisper auto-transcription can mis-segment punctuation/diacritics
    #     (the v0.1.24 mojibake was a red herring — even clean transcripts
    #     produced bad output);
    #   - ICL conditions on BOTH the ref speech codes AND the ref text;
    #     any small mismatch derails the speaker conditioning.
    # x_vector_only_mode uses ONLY the speaker embedding extracted from
    # the audio (resampled to 24 kHz internally). In direct testing this
    # cloned a female reference voice perfectly in 11.2 s on GPU,
    # whereas ICL produced a male voice with the same ref. The upstream
    # docs note "slightly lower quality" but for our use case (URL/file/
    # mic-derived refs of varying cleanliness) the embedding-only path
    # is far more robust.
    return model.generate_voice_clone(
        text=text, language=language,
        ref_audio=ref_audio, ref_text=None,
        x_vector_only_mode=True,
    )


# ── Voice cloning component status ────────────────────────────────
# Surfaces whether the optional Qwen3-TTS-Base model is installed so
# the UI can show a "Install voice cloning (≈7 GB)" banner before the
# user tries to register or use a clone — much better UX than failing
# at synthesis time. The Tauri command `install_optional_component(
# "model-qwen-tts-base")` is the corresponding installer hook.

class CloningStatusResponse(BaseModel):
    base_model_installed: bool
    component_id: str = "model-qwen-tts-base"
    repo_id: str = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    download_size_gb: float = 3.4
    registered_clones: int = 0
    hint: str = ""


@router.get("/cloning/status", response_model=CloningStatusResponse)
async def cloning_status() -> CloningStatusResponse:
    state = tts_base_model.get_install_state()
    base_ready = state["available"]
    clones_count = len(_load_clone_manifest())
    bytes_dl = int(state["weight_bytes"])
    pct = min(100, int(100 * bytes_dl / (3.6 * 1024 * 1024 * 1024)))
    if base_ready:
        hint = "Voice cloning is available."
    elif state["has_config"] and not state["has_weights"]:
        hint = (
            f"Descarga parcial detectada (solo metadatos, faltan pesos). "
            f"Pulsa 'Reintentar instalación' para reanudar (≈{pct}% completo)."
        )
    elif clones_count > 0:
        hint = (
            f"Tienes {clones_count} voz/voces clonadas registradas, pero el "
            "modelo Base de voice cloning (≈3.4 GB) aún no está instalado. "
            "Pulsa 'Reintentar instalación' para descargarlo."
        )
    else:
        hint = (
            "Voice cloning requiere el modelo Base de Qwen3-TTS (≈3.4 GB). "
            "Instálalo cuando quieras crear y usar voces clonadas."
        )
    return CloningStatusResponse(
        base_model_installed=base_ready,
        registered_clones=clones_count,
        hint=hint,
        download_size_gb=3.4,
    )


# ─── In-process install (with resume) ──────────────────────────────────
# huggingface_hub.snapshot_download has native resume: failed mid-flight
# files restart from zero, but already-completed files are skipped. So
# repeating this endpoint is the simplest "retry" path. We surface
# progress via _INSTALL_STATE that the UI polls.
_INSTALL_STATE = {
    "running": False,
    "phase": "idle",
    "downloaded_bytes": 0,
    "total_bytes": int(3.4 * 1024 * 1024 * 1024),
    "error": None,
    "completed": False,
}


def _install_progress_callback():
    """Refresh _INSTALL_STATE.downloaded_bytes by re-scanning the cache.
    huggingface_hub doesn't expose progress hooks for snapshot_download,
    so we sample the disk state every poll. Counts BOTH committed
    snapshot weights and the partial blobs/ store so the % moves
    smoothly during a multi-GB resume.
    """
    state = tts_base_model.get_install_state()
    # Use the LARGER of the two to handle either:
    #   - resume halfway: weight_bytes=0, in_flight_bytes=2.1 GB
    #   - already complete: weight_bytes=3.4 GB, in_flight_bytes=3.4 GB
    _INSTALL_STATE["downloaded_bytes"] = int(
        max(state["weight_bytes"], state["in_flight_bytes"])
    )


def _do_install_base_blocking() -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    repo_id = os.environ.get(
        "XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    )
    _INSTALL_STATE.update(
        running=True, phase="downloading", error=None, completed=False,
    )
    try:
        log.info("tts.cloning.install: starting snapshot_download for %s", repo_id)
        snapshot_download(
            repo_id=repo_id,
            local_dir_use_symlinks=False,
            resume_download=True,
            max_workers=4,
            etag_timeout=30,
        )
        _install_progress_callback()
        if not tts_base_model.is_available():
            raise RuntimeError(
                "snapshot_download finished but is_available() still False. "
                "Re-running may complete missing files."
            )
        _INSTALL_STATE.update(
            running=False, phase="ready", completed=True,
        )
        log.info("tts.cloning.install: snapshot_download OK, model ready")
    except Exception as exc:
        log.warning("tts.cloning.install: failed (%s)", exc)
        _INSTALL_STATE.update(
            running=False, phase="failed", error=str(exc)[:300],
        )


@router.post("/cloning/install")
async def cloning_install():
    """Install Qwen3-TTS-Base from inside the Python sidecar with
    huggingface_hub's native resume. Idempotent: calling this multiple
    times resumes a partial download, doesn't restart it.
    """
    if _INSTALL_STATE["running"]:
        return {"status": "already_running", "state": _INSTALL_STATE}
    if tts_base_model.is_available():
        _INSTALL_STATE.update(running=False, phase="ready", completed=True)
        return {"status": "already_installed", "state": _INSTALL_STATE}
    # Run in a thread so the FastAPI event loop keeps serving /health,
    # /tts/cloning/install/progress, etc.
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _do_install_base_blocking)
    return {"status": "started", "state": _INSTALL_STATE}


@router.get("/cloning/install/progress")
async def cloning_install_progress():
    """Polled by the UI for live progress."""
    _install_progress_callback()
    state = dict(_INSTALL_STATE)
    state["pct"] = min(100, int(
        100 * state["downloaded_bytes"] / max(1, state["total_bytes"])
    ))
    return state


@router.post("", response_model=TTSResponse)
async def synthesize(req: TTSRequest) -> TTSResponse:
    # tts_model.load() is sync; the first cold load can take 5-30 s while
    # PyTorch maps the GGUF weights, which would block the event loop and
    # make every other request (including /health and the next pipeline
    # POST) time out. Move it to a worker thread.
    try:
        await asyncio.get_running_loop().run_in_executor(None, tts_model.load)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"TTS model not ready: {e}") from e

    import numpy as np
    import soundfile as sf

    lang = _LANG_TO_QWEN.get(req.language.lower()[:2], req.language)
    spk_raw = req.speaker.strip()
    instruct = req.instruction or "Read in a calm cinematic narrator voice."

    # Voice clone path: speaker = "clone:<id>"
    is_clone = spk_raw.lower().startswith("clone:")
    if is_clone:
        clone_id = spk_raw.split(":", 1)[1]
        clones = _load_clone_manifest()
        match = next((c for c in clones if c["id"] == clone_id), None)
        if not match:
            raise HTTPException(404, f"voice clone not found: {clone_id}")
        ref_audio = match["ref_audio_path"]
        ref_text = match.get("ref_text")
    else:
        spk = spk_raw.lower().replace(" ", "_")
        if spk not in _SPEAKER_PROFILE:
            raise HTTPException(status_code=400, detail=f"unknown speaker '{req.speaker}'")

    from ..logging_utils import log_event
    import time as _t

    chunks = chunk_text(req.text, req.chunk_chars)
    audio_segments: list = []
    sr = 0
    loop = asyncio.get_running_loop()
    log_event("info", "tts_synthesis_start", chunks=len(chunks), total_chars=sum(len(c) for c in chunks), language=lang)
    t_total = _t.time()
    if is_clone:
        # v0.1.27: precompute the speaker prompt ONCE and batch all chunks
        # in a single generate_voice_clone() call. The previous per-chunk
        # loop re-extracted the speaker embedding every time, which on
        # GPU was costing ~10 s of pure overhead per chunk for nothing.
        t_prompt = _t.time()
        model, prompt_item = await loop.run_in_executor(
            None, _build_clone_prompt, ref_audio,
        )
        log_event("info", "tts_clone_prompt_built",
                  duration_ms=int((_t.time() - t_prompt) * 1000))
        t_gen = _t.time()
        wavs, sr_returned = await loop.run_in_executor(
            None, _synthesize_clone_batch, model, prompt_item, chunks, lang,
        )
        log_event("info", "tts_clone_batch_done",
                  chunks=len(chunks),
                  duration_ms=int((_t.time() - t_gen) * 1000),
                  ms_per_chunk=int((_t.time() - t_gen) * 1000 / max(1, len(chunks))))
        audio_segments = list(wavs)
        sr = sr_returned
    else:
        for idx, chunk in enumerate(chunks):
            t_chunk = _t.time()
            wav, sr_returned = await loop.run_in_executor(
                None, _do_synthesize_builtin, chunk, lang, spk, instruct,
            )
            audio_segments.append(wav[0])
            sr = sr_returned
            log_event(
                "info", "tts_chunk_done",
                index=idx, total=len(chunks),
                chars=len(chunk),
                duration_ms=int((_t.time() - t_chunk) * 1000),
            )
    log_event("info", "tts_synthesis_done", total_ms=int((_t.time() - t_total) * 1000), chunks=len(chunks))

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tts-{uuid.uuid4().hex[:10]}.wav"

    if not audio_segments:
        full = np.zeros(1, dtype="float32")
        sf.write(str(out_path), full, sr or 24000)
        return TTSResponse(audio_path=str(out_path), duration_seconds=0.0, chunks=0)

    # v0.1.34: loudness-normalize each chunk BEFORE crossfade so the gain
    # stages going into acrossfade are consistent (-14 LUFS target).
    audio_segments = [
        _loudnorm_audio(seg.astype("float32"), sr, target_lufs=-14.0, peak_db=-1.0)
        for seg in audio_segments
    ]

    # ── Crossfade concat (intra-request) ─────────────────────────────
    # For N > 1 chunks, chain them with an 80 ms acrossfade (tri curves)
    # to eliminate the hard click at each concatenation point.
    # For N == 1, skip ffmpeg entirely — no joins, nothing to crossfade.
    # Graceful fallback: if ffmpeg acrossfade fails, raw-concat the chunks
    # (same as the pre-crossfade behaviour) so /tts never breaks.
    #
    # CRITICAL anti-desync: duration_seconds is derived from the MEASURED
    # length of the final WAV (probe via array len/sr or sf.info), NOT from
    # summing chunk durations. This guarantees the pipeline beat-timeline
    # (which reads duration_seconds from this response) stays in sync with
    # the actual audio after crossfade compression.
    crossfade_ok = False
    if len(audio_segments) > 1:
        import subprocess as _sp
        import tempfile as _tf

        _XFADE_D = 0.08  # 80 ms — removes click cleanly with tri curve

        # Write each chunk to a temp WAV so ffmpeg can read them.
        tmp_dir = Path(_tf.mkdtemp(prefix="tts_xfade_"))
        chunk_paths: list[Path] = []
        try:
            for i, seg in enumerate(audio_segments):
                cp = tmp_dir / f"chunk_{i:04d}.wav"
                sf.write(str(cp), seg, sr)
                chunk_paths.append(cp)

            # Build ffmpeg pairwise acrossfade chain for N inputs.
            # acrossfade is a STRICTLY 2-input filter — it has no n= option.
            # For N chunks we build a sequential chain:
            #   N==2: [0][1]acrossfade=d=0.08:c1=tri:c2=tri[out]
            #   N>2:  [0][1]acrossfade=...[a1];[a1][2]acrossfade=...[a2];...
            #         ...[a{N-2}][{N-1}]acrossfade=...[out]
            n_inputs = len(chunk_paths)
            xfade_opts = f"acrossfade=d={_XFADE_D}:c1=tri:c2=tri"
            if n_inputs == 2:
                fc = f"[0][1]{xfade_opts}[out]"
            else:
                parts = []
                # First join: [0][1] → [a1]
                parts.append(f"[0][1]{xfade_opts}[a1]")
                # Middle joins: [a{k}][k+1] → [a{k+1}]
                for k in range(1, n_inputs - 2):
                    parts.append(f"[a{k}][{k + 1}]{xfade_opts}[a{k + 1}]")
                # Last join: [a{N-2}][N-1] → [out]
                parts.append(f"[a{n_inputs - 2}][{n_inputs - 1}]{xfade_opts}[out]")
                fc = ";".join(parts)
            cmd = ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-y"]
            for cp in chunk_paths:
                cmd += ["-i", str(cp)]
            cmd += [
                "-filter_complex", fc,
                "-map", "[out]",
                str(out_path),
            ]
            result = _sp.run(cmd, capture_output=True)
            if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                crossfade_ok = True
                log.debug("tts: acrossfade OK, %d chunks → %s", n_inputs, out_path.name)
            else:
                err_msg = result.stderr.decode(errors="replace")[:300]
                log.warning("tts: acrossfade failed (rc=%d): %s — falling back to raw concat",
                            result.returncode, err_msg)
        except Exception as exc:
            log.warning("tts: acrossfade exception (%s) — falling back to raw concat", exc)
        finally:
            # Clean up temp chunk files regardless of success/failure.
            import shutil as _sh
            _sh.rmtree(tmp_dir, ignore_errors=True)

    if not crossfade_ok:
        # Raw concat fallback (original behaviour) or single-chunk path.
        full = np.concatenate(audio_segments) if len(audio_segments) > 1 else audio_segments[0]
        sf.write(str(out_path), full, sr)

    # Measure duration from the FINAL produced WAV (post-crossfade length
    # differs from sum-of-chunks by xfade_d*(N-1) — reading the file is the
    # only reliable source of truth for the beat-timeline in Rust pipeline).
    try:
        info = sf.info(str(out_path))
        duration = float(info.frames) / float(info.samplerate)
    except Exception:
        # sf.info unavailable or file corrupt — fall back to array math.
        try:
            # crossfade_ok path: load the written file to get measured len.
            data, _sr2 = sf.read(str(out_path))
            duration = float(len(data)) / float(_sr2) if _sr2 else 0.0
        except Exception:
            duration = 0.0

    return TTSResponse(audio_path=str(out_path), duration_seconds=duration, chunks=len(chunks))


# ─── Voice clones management ───────────────────────────────────────

class CloneListItem(BaseModel):
    id: str
    label: str
    gender: str
    primary: str
    description: str
    duration_seconds: float | None = None
    has_ref_text: bool = False


@router.get("/clones", response_model=list[CloneListItem])
async def list_clones() -> list[CloneListItem]:
    items: list[CloneListItem] = []
    for c in _load_clone_manifest():
        items.append(
            CloneListItem(
                id=c["id"], label=c.get("label", c["id"]),
                gender=c.get("gender", "neutral"),
                primary=c.get("primary", "es"),
                description=c.get("description", ""),
                duration_seconds=c.get("duration_seconds"),
                has_ref_text=bool(c.get("ref_text")),
            )
        )
    return items


@router.post("/clones", response_model=CloneListItem)
async def register_clone(
    audio: UploadFile = File(...),
    label: str = Form(...),
    gender: str = Form("neutral"),
    primary: str = Form("es"),
    description: str = Form(""),
    ref_text: str = Form(""),
) -> CloneListItem:
    """Persist a new voice clone. The audio file (5-15 s ideally) is copied to
    `<voice_clones>/<id>/ref.wav` and registered in the manifest."""
    import soundfile as sf

    cid_seed = f"{label}-{uuid.uuid4().hex[:6]}"
    cid = hashlib.sha1(cid_seed.encode()).hexdigest()[:10]
    target_dir = _clones_dir() / cid
    target_dir.mkdir(parents=True, exist_ok=True)
    ref_path = target_dir / "ref.wav"

    raw = await audio.read()
    suffix = Path(audio.filename or "").suffix.lower() or ".wav"
    tmp = target_dir / f"upload{suffix}"
    tmp.write_bytes(raw)

    # Normalise to 16 kHz mono WAV for Qwen3-TTS speaker encoder.
    if suffix == ".wav":
        try:
            import numpy as np
            data, sr = sf.read(str(tmp))
            if data.ndim > 1:
                data = data.mean(axis=1)
            if sr != 16000:
                from scipy.signal import resample_poly
                data = resample_poly(data, 16000, sr)
                sr = 16000
            sf.write(str(ref_path), data.astype("float32"), sr)
            tmp.unlink()
        except Exception:
            shutil.move(str(tmp), str(ref_path))
    else:
        # Convert via ffmpeg for non-WAV uploads (m4a, mp3, ogg, etc.).
        import subprocess
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(tmp), "-ar", "16000", "-ac", "1", str(ref_path)],
            check=True, capture_output=True,
        )
        tmp.unlink()

    duration = None
    try:
        info = sf.info(str(ref_path))
        duration = float(info.frames) / float(info.samplerate)
    except Exception:
        pass

    record = {
        "id": cid,
        "label": label.strip() or cid,
        "gender": gender,
        "primary": primary,
        "description": description.strip(),
        "ref_audio_path": str(ref_path.resolve()),
        "ref_text": ref_text.strip() or None,
        "duration_seconds": duration,
    }
    manifest = _load_clone_manifest()
    manifest.append(record)
    _save_clone_manifest(manifest)
    return CloneListItem(
        id=record["id"], label=record["label"], gender=record["gender"],
        primary=record["primary"], description=record["description"],
        duration_seconds=duration, has_ref_text=bool(record.get("ref_text")),
    )


@router.delete("/clones/{cid}")
async def delete_clone(cid: str) -> dict:
    manifest = _load_clone_manifest()
    keep = [c for c in manifest if c["id"] != cid]
    if len(keep) == len(manifest):
        raise HTTPException(404, f"clone {cid} not found")
    _save_clone_manifest(keep)
    target = _clones_dir() / cid
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    return {"deleted": cid}


# ─── Helpers ────────────────────────────────────────────────────────

def chunk_text(text: str, max_chars: int) -> list[str]:
    """Naive chunk-by-sentence respecting max_chars budget."""
    import re

    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        if len(cur) + len(s) + 1 > max_chars and cur:
            chunks.append(cur.strip())
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur.strip())
    return chunks
