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
    chunk_chars: int = 220
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
    return model.generate_voice_clone(
        text=text, language=language, ref_audio=ref_audio, ref_text=ref_text,
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
    download_size_gb: float = 7.0
    registered_clones: int = 0
    hint: str = ""


@router.get("/cloning/status", response_model=CloningStatusResponse)
async def cloning_status() -> CloningStatusResponse:
    base_ready = tts_base_model.is_available()
    clones_count = len(_load_clone_manifest())
    if base_ready:
        hint = "Voice cloning is available."
    elif clones_count > 0:
        hint = (
            f"Tienes {clones_count} voz/voces clonadas registradas, pero el "
            "modelo Base de voice cloning (≈7 GB) aún no está instalado. "
            "Instálalo desde Ajustes → Componentes opcionales para usarlas."
        )
    else:
        hint = (
            "Voice cloning requiere el modelo Base de Qwen3-TTS (≈7 GB). "
            "Instálalo cuando quieras subir y usar voces clonadas."
        )
    return CloningStatusResponse(
        base_model_installed=base_ready,
        registered_clones=clones_count,
        hint=hint,
    )


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
    for idx, chunk in enumerate(chunks):
        t_chunk = _t.time()
        if is_clone:
            wav, sr_returned = await loop.run_in_executor(
                None, _do_synthesize_clone, chunk, lang, ref_audio, ref_text,
            )
        else:
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
    full = np.concatenate(audio_segments) if audio_segments else np.zeros(1)
    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tts-{uuid.uuid4().hex[:10]}.wav"
    sf.write(str(out_path), full, sr)
    duration = float(len(full)) / float(sr) if sr else 0.0
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
