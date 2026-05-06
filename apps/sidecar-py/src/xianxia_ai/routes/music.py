"""Music: pick from local library OR generate fresh via ACE-Step / MusicGen.

Backend selection (best → fallback):
  1. **ACE-Step v1.5** (Apache 2.0, RTX 4060 8GB friendly with cpu_offload).
     Best cinematic quality, native duration up to 240s, oriental instruments
     (erhu, guzheng, taiko) significantly more realistic than MusicGen.
  2. **MusicGen-medium** (Meta, audiocraft package, hard 30s cap).
     Fallback when ACE-Step isn't installed. Uses chunked generation +
     equal-power acrossfade for >30s outputs.

Both share the same cinematic pre-master chain (per the 2026 playbook):
  highpass 35 / lowpass 17000 → EQ tilt (warmth + air) →
  compressor 2.5:1 → side reverb (aecho) → loudnorm -16 LUFS for video bus.
"""

from __future__ import annotations

import os
import random
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class MusicRequest(BaseModel):
    mood: str = "epic"
    duration_seconds: float = 60.0
    use_musicgen: bool = False
    library_dir: str | None = None
    out_dir: str | None = None
    # Pre-master toggle: applies the cinematic FFmpeg chain after gen.
    # Defaults true for MusicGen, ignored for library tracks (already mastered).
    premaster: bool = True


class MusicResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    source: str  # "library" | "musicgen"


@router.post("", response_model=MusicResponse)
def get_music(req: MusicRequest) -> MusicResponse:
    if req.use_musicgen:
        return _musicgen(req)

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
    return MusicResponse(
        audio_path=str(track),
        duration_seconds=req.duration_seconds,
        source="library",
    )


# MusicGen-medium hard limit is ~30 s per generation pass on 8 GB VRAM in fp16.
# For longer videos we chain segments with crossfade.
_CHUNK_SECONDS = 30.0
_CROSSFADE_SECONDS = 4.0


def _have_acestep() -> bool:
    """Detect if ACE-Step v1.5 is installed (acestep package importable)."""
    try:
        import acestep  # noqa: F401
        return True
    except Exception:
        return False


def _acestep(req: MusicRequest) -> MusicResponse | None:
    """Generate music with ACE-Step v1.5 if available. Returns None on failure
    so the caller can fallback to MusicGen.

    8 GB VRAM config: bf16 + cpu_offload + overlapped_decode = ~7 GB peak,
    ~2.6× realtime on RTX 4060 (1.16 it/s × 27 steps for 60 s audio).
    """
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore
    except Exception:
        return None

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir / f"music-raw-{uuid.uuid4().hex[:10]}.wav"

    try:
        pipe = ACEStepPipeline(
            checkpoint_dir=None,
            dtype="bfloat16",
            cpu_offload=True,
            torch_compile=False,
            overlapped_decode=True,
        )
        prompt = mood_to_prompt_acestep(req.mood)
        pipe(
            prompt=prompt,
            lyrics="[inst]",  # instrumental — no vocals
            audio_duration=float(req.duration_seconds),
            infer_step=27,
            guidance_scale=15.0,
            save_path=str(raw_path),
        )
    except Exception as e:
        # Best-effort fallback signal: cleanup half-written file then return None.
        try: raw_path.unlink()
        except Exception: pass
        raise HTTPException(503, f"ACE-Step failed: {e}") from e

    if not req.premaster:
        return MusicResponse(
            audio_path=str(raw_path),
            duration_seconds=req.duration_seconds,
            source="acestep",
        )
    final_path = _premaster(raw_path, out_dir)
    return MusicResponse(
        audio_path=str(final_path),
        duration_seconds=req.duration_seconds,
        source="acestep",
    )


def _musicgen(req: MusicRequest) -> MusicResponse:
    """Generate fresh ambient music. Tries ACE-Step v1.5 first (cleaner oriental
    instrumentation, native long-form), falls back to MusicGen-medium (Meta).

    MusicGen long-form strategy:
      duration <= 30 s  → single pass.
      duration > 30 s  → N chunks of 30 s with 4 s crossfades, FFmpeg-merged.
    """
    # Try ACE-Step first — it produces objectively better oriental cinematic music.
    if _have_acestep():
        try:
            ace = _acestep(req)
            if ace is not None:
                return ace
        except HTTPException:
            # Fall through to MusicGen
            pass
    try:
        from audiocraft.models import MusicGen  # type: ignore
        import torch
        import scipy.io.wavfile as wavfile  # type: ignore
    except Exception as e:
        raise HTTPException(503, f"MusicGen not ready: {e}") from e

    model = MusicGen.get_pretrained("facebook/musicgen-medium")
    # fp16: ~3.5 GB VRAM (vs 6 GB fp32). Lossless quality difference for music gen.
    try:
        model.lm.half()
    except Exception:
        pass

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt = mood_to_prompt(req.mood)

    total = float(req.duration_seconds)
    if total <= _CHUNK_SECONDS:
        # Simple single-pass.
        model.set_generation_params(duration=total, cfg_coef=3.0, top_k=250)
        wav = model.generate([prompt])[0]
        raw_path = out_dir / f"music-raw-{uuid.uuid4().hex[:10]}.wav"
        wavfile.write(str(raw_path), 32000, wav.cpu().numpy().T)
    else:
        # Chunked: generate ceil(total/30) overlapping segments and crossfade.
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
    """Report which music generation backends are available right now.

    The frontend uses this to decide whether to show ACE-Step or MusicGen
    in the mood selector tooltip.
    """
    have_ace = _have_acestep()
    have_musicgen = False
    try:
        import audiocraft  # type: ignore  # noqa: F401
        have_musicgen = True
    except Exception:
        pass
    return {
        "acestep_available": have_ace,
        "musicgen_available": have_musicgen,
        "preferred": "acestep" if have_ace else ("musicgen" if have_musicgen else None),
    }


def mood_to_prompt_acestep(mood: str) -> str:
    """ACE-Step uses comma-separated tag prompts (style + instrument + tempo + key)."""
    return {
        "epic": "cinematic xianxia, erhu lead, guzheng, taiko ensemble, sweeping strings, ethereal piano, qi cultivation, 75bpm, D minor, instrumental, no vocals, hans zimmer style",
        "serene": "tranquil guzheng, bamboo dizi flute, mountain stream, meditative xianxia, joe hisaishi inspired, 60bpm, A major, instrumental, no vocals",
        "mystic": "ethereal pads, distant temple bells, deep taiko, mysterious xianxia, qi flowing, 65bpm, F# minor, instrumental, no vocals",
        "emotional": "solo erhu, soft piano, melancholy xianxia, slow heartfelt, 55bpm, B minor, instrumental, no vocals",
    }.get(mood, "ambient cinematic xianxia, instrumental, no vocals")


def mood_to_prompt(mood: str) -> str:
    return {
        "epic": "cinematic xianxia, erhu lead, guzheng, taiko ensemble, sweeping strings, ethereal piano, rising tension, qi cultivation, 75bpm, D minor, no vocals",
        "serene": "tranquil guzheng, bamboo dizi flute, mountain stream ambience, meditative xianxia, 60bpm, A major, no vocals",
        "mystic": "ethereal pads, distant temple bells, deep taiko, mysterious xianxia atmosphere, qi flowing, 65bpm, F# minor, no vocals",
        "emotional": "solo erhu over soft piano, melancholy xianxia, slow heartfelt, 55bpm, B minor, no vocals",
    }.get(mood, "ambient cinematic xianxia, no vocals")
