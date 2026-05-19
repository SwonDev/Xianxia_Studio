"""Voice acquisition pipeline (v0.1.24).

End-to-end "give me a clean reference clip from anything":

  URL (YouTube/TikTok/etc) ┐
  Local file              ├─→ extract audio (yt-dlp / ffmpeg)
  Microphone WebM/Opus    ┘
                          │
                          ▼
              audio-separator (UVR-MDX-NET-Voc_FT)
              isolate vocals from music/SFX
                          │
                          ▼
              DeepFilterNet 3
              denoise / dereverb the vocal track
                          │
                          ▼
              silero-vad
              trim non-speech regions
                          │
                          ▼
              pyloudnorm (EBU R128 -23 LUFS)
              normalise loudness
                          │
                          ▼
              resample to 16 kHz mono WAV
              (Qwen3-TTS reference format)
                          │
                          ▼
              POST /tts/clones (auto-register)

Each stage is best-effort; if a model is missing we skip it and tell
the caller in the response so they can decide whether the result is
clean enough. The goal is for the WHOLE thing to work even with the
minimum dependencies (just ffmpeg + soundfile).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

log = logging.getLogger("xianxia.voice_acq")

router = APIRouter()


# Where every intermediate sits during processing. Cleaned at the end.
def _work_dir() -> Path:
    base = Path(
        os.environ.get("XIANXIA_OUT_DIR", "./out")
    ) / "voice_acquisition"
    base.mkdir(parents=True, exist_ok=True)
    return base


# ─── Stage 1: ingest (URL or local file) ──────────────────────────────


def _ingest_url(url: str, out_dir: Path) -> Path:
    """Download the best audio track from URL via yt-dlp. Returns a
    WAV path. Supports YouTube, TikTok, Twitch, Vimeo, ~1500 sites."""
    try:
        from yt_dlp import YoutubeDL  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            500,
            "yt-dlp not installed in the bundled Python — voice extraction "
            "from URLs requires it. Reinstall the app or run "
            "`pip install yt-dlp` in the sidecar venv."
        ) from exc

    out_template = str(out_dir / "ingest_%(id)s.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
            "preferredquality": "0",
        }],
    }
    log.info("voice_acq.ingest_url: %s", url[:100])
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    # Resolve final WAV path
    candidates = list(out_dir.glob("ingest_*.wav"))
    if not candidates:
        raise HTTPException(500, "yt-dlp completed but no .wav was produced")
    log.info("voice_acq.ingest_url: got %s (%.2f MB)",
             candidates[-1].name,
             candidates[-1].stat().st_size / (1024 * 1024))
    return candidates[-1]


def _ingest_local_file(src: Path, out_dir: Path) -> Path:
    """Re-encode any local audio/video file to WAV via ffmpeg. Accepts
    mp4 / m4a / mp3 / webm / opus / aac / mov / mkv / wav / flac."""
    if not src.exists():
        raise HTTPException(404, f"input file not found: {src}")
    out_path = out_dir / f"ingest_{uuid.uuid4().hex[:8]}.wav"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-vn", "-ac", "2", "-ar", "44100",
        "-c:a", "pcm_s16le",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg ingest failed: {proc.stderr[-300:]}")
    log.info("voice_acq.ingest_local: %s -> %s", src.name, out_path.name)
    return out_path


# ─── Stage 2: vocal isolation ──────────────────────────────────────────


def _isolate_vocals(src: Path, out_dir: Path) -> tuple[Path, str]:
    """Separate vocals from background music/SFX via audio-separator.
    Falls back to a no-op pass-through if the lib isn't available, so
    the pipeline still produces SOMETHING useful (just less clean).
    Returns (vocals_path, method_used_str).
    """
    try:
        from audio_separator.separator import Separator  # type: ignore
    except ImportError:
        log.info("voice_acq.isolate: audio-separator not installed, skipping")
        return src, "skipped:no-lib"
    try:
        # UVR-MDX-NET-Voc_FT: ~70 MB, ~1× RT CPU, mejor balance speed/quality
        sep = Separator(
            output_dir=str(out_dir),
            output_format="WAV",
            normalization_threshold=0.9,
        )
        sep.load_model("UVR-MDX-NET-Voc_FT.onnx")
        log.info("voice_acq.isolate: running UVR-MDX-NET-Voc_FT on %s",
                 src.name)
        outputs = sep.separate(str(src))
        # outputs is list of relative paths; vocals usually first
        vocals_name = next(
            (o for o in outputs if "Vocals" in o or "vocals" in o),
            outputs[0] if outputs else None,
        )
        if not vocals_name:
            return src, "skipped:no-output"
        vocals_path = Path(vocals_name)
        if not vocals_path.is_absolute():
            vocals_path = out_dir / vocals_name
        if not vocals_path.exists():
            return src, "skipped:output-missing"
        log.info("voice_acq.isolate: %s (%.2f MB)",
                 vocals_path.name,
                 vocals_path.stat().st_size / (1024 * 1024))
        return vocals_path, "audio-separator:UVR-MDX-NET-Voc_FT"
    except Exception as exc:
        log.warning("voice_acq.isolate failed (%s); using raw audio", exc)
        return src, f"failed:{type(exc).__name__}"


# ─── Stage 3: denoise ─────────────────────────────────────────────────


def _denoise(src: Path, out_dir: Path) -> tuple[Path, str]:
    """DeepFilterNet 3 denoise. ~8 MB model, 2-4× RT on CPU.
    Outputs at 48 kHz (DFN's native rate); the next stage resamples.
    """
    try:
        from df.enhance import enhance, init_df, load_audio, save_audio  # type: ignore
    except ImportError:
        log.info("voice_acq.denoise: deepfilternet not installed, skipping")
        return src, "skipped:no-lib"
    try:
        out_path = out_dir / f"denoised_{uuid.uuid4().hex[:8]}.wav"
        log.info("voice_acq.denoise: running DeepFilterNet on %s", src.name)
        model, df_state, _ = init_df()
        audio, _ = load_audio(str(src), sr=df_state.sr())
        clean = enhance(model, df_state, audio)
        save_audio(str(out_path), clean, df_state.sr())
        log.info("voice_acq.denoise: %s", out_path.name)
        return out_path, "deepfilternet"
    except Exception as exc:
        log.warning("voice_acq.denoise failed (%s); using raw audio", exc)
        return src, f"failed:{type(exc).__name__}"


# ─── Stage 4: VAD trim ────────────────────────────────────────────────


def _vad_trim(src: Path, out_dir: Path) -> tuple[Path, str]:
    """Use silero-vad to keep only speech regions. Falls back to ffmpeg
    silenceremove (less precise but built in)."""
    try:
        import torch  # type: ignore
        from silero_vad import (  # type: ignore
            load_silero_vad, get_speech_timestamps, read_audio,
        )
    except ImportError:
        return _vad_trim_ffmpeg_fallback(src, out_dir), "ffmpeg-silenceremove"
    try:
        import soundfile as sf  # type: ignore
        import numpy as np  # type: ignore
        out_path = out_dir / f"trimmed_{uuid.uuid4().hex[:8]}.wav"
        vad = load_silero_vad()
        wav = read_audio(str(src), sampling_rate=16000)
        ts = get_speech_timestamps(
            wav, vad, return_seconds=True, min_speech_duration_ms=300,
        )
        if not ts:
            return src, "skipped:no-speech-detected"
        data, sr = sf.read(str(src))
        if data.ndim == 2:
            data = data.mean(axis=1)  # to mono for clipping
        keep = []
        for span in ts:
            a = int(span["start"] * sr)
            b = int(span["end"] * sr)
            keep.append(data[a:b])
        trimmed = np.concatenate(keep) if keep else data
        sf.write(str(out_path), trimmed, sr)
        log.info("voice_acq.vad_trim: kept %.1fs of %.1fs (silero-vad)",
                 len(trimmed) / sr, len(data) / sr)
        return out_path, "silero-vad"
    except Exception as exc:
        log.warning("voice_acq.vad_trim silero failed (%s); ffmpeg fallback",
                    exc)
        return _vad_trim_ffmpeg_fallback(src, out_dir), \
               f"silero-failed-{type(exc).__name__}"


def _vad_trim_ffmpeg_fallback(src: Path, out_dir: Path) -> Path:
    out_path = out_dir / f"trimmed_{uuid.uuid4().hex[:8]}.wav"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-af", "silenceremove=start_periods=1:start_silence=0.3:start_threshold=-40dB:"
               "stop_periods=-1:stop_silence=0.4:stop_threshold=-40dB",
        "-c:a", "pcm_s16le",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return out_path if proc.returncode == 0 else src


# ─── Stage 5: loudness normalize + resample to 16k mono ──────────────


def _normalize_and_resample(src: Path, out_dir: Path) -> tuple[Path, str]:
    """Final stage: normalise loudness to -23 LUFS (EBU R128) and
    re-encode to 16 kHz mono PCM WAV — the format Qwen3-TTS expects
    as a reference clip."""
    out_path = out_dir / f"clone_ready_{uuid.uuid4().hex[:8]}.wav"
    try:
        import soundfile as sf  # type: ignore
        import pyloudnorm as pyln  # type: ignore
        import numpy as np  # type: ignore

        data, sr = sf.read(str(src))
        if data.ndim == 2:
            data = data.mean(axis=1)
        meter = pyln.Meter(sr)
        loud = meter.integrated_loudness(data)
        # Normalise — but if the source is silent (loud == -inf) skip
        if loud > -70:
            data = pyln.normalize.loudness(data, loud, -23.0)
        # Resample to 16k via librosa or scipy
        if sr != 16000:
            try:
                import librosa  # type: ignore
                data = librosa.resample(
                    data.astype("float32"), orig_sr=sr, target_sr=16000,
                )
                sr = 16000
            except ImportError:
                # Fallback: ffmpeg resample
                tmp_in = out_dir / f"_pre16k_{uuid.uuid4().hex[:6]}.wav"
                sf.write(str(tmp_in), data, sr)
                cmd = [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(tmp_in),
                    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                    str(out_path),
                ]
                if subprocess.run(cmd, capture_output=True).returncode == 0:
                    return out_path, "pyloudnorm+ffmpeg-resample"
        sf.write(str(out_path), data, 16000, subtype="PCM_16")
        return out_path, "pyloudnorm+librosa"
    except Exception as exc:
        log.warning("voice_acq.normalize: pyloudnorm failed (%s) — "
                    "ffmpeg loudnorm fallback", exc)
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-af", "loudnorm=I=-23:TP=-2:LRA=7",
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise HTTPException(500, f"normalize fallback failed: {proc.stderr[-200:]}")
        return out_path, "ffmpeg-loudnorm"


# ─── Quality gate ────────────────────────────────────────────────────


def _quality_gate(clip: Path) -> dict:
    """Tag the clip with min duration + estimated loudness so the UI
    can warn the user if the source was poor. Doesn't reject — the
    user owns the call."""
    import soundfile as sf  # type: ignore
    info = sf.info(str(clip))
    duration = info.duration
    quality = {
        "duration_seconds": duration,
        "sample_rate": info.samplerate,
        "channels": info.channels,
        "ok_for_clone": duration >= 3.0,
        "warning": None,
    }
    if duration < 3.0:
        quality["warning"] = (
            f"Reference clip is only {duration:.1f}s — Qwen3-TTS recommends "
            "≥ 3 s of clean speech. Cloning will work but quality may suffer."
        )
    elif duration < 10.0:
        quality["warning"] = (
            f"Reference clip is {duration:.1f}s — adequate but ≥ 10 s gives "
            "noticeably better cloned voice quality."
        )
    return quality


# ─── Public endpoint ─────────────────────────────────────────────────


class VoiceFromUrlRequest(BaseModel):
    url: str
    label: str
    primary: str = "es"
    description: str = ""
    ref_text: str = ""
    # Optional: only use seconds [start, end] of the source. Useful when
    # the source has 3 minutes of intro music before the speech starts.
    start_seconds: float | None = None
    duration_seconds: float | None = None


class VoiceAcquisitionResponse(BaseModel):
    clone_id: str
    clone_path: str
    duration_seconds: float
    pipeline_steps: list[dict]
    quality: dict


def _run_pipeline(input_audio: Path, label: str, primary: str,
                  description: str, ref_text: str,
                  start_seconds: float | None = None,
                  duration_seconds: float | None = None) -> VoiceAcquisitionResponse:
    """Shared pipeline body — used by both URL and upload endpoints."""
    work = _work_dir() / f"acq_{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    steps: list[dict] = []
    try:
        # Optional pre-trim by [start, end] before isolation
        cur = input_audio
        if start_seconds is not None or duration_seconds is not None:
            trimmed = work / "pretrim.wav"
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(cur),
            ]
            if start_seconds is not None:
                cmd += ["-ss", f"{start_seconds:.3f}"]
            if duration_seconds is not None:
                cmd += ["-t", f"{duration_seconds:.3f}"]
            cmd += ["-c:a", "pcm_s16le", str(trimmed)]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode == 0:
                cur = trimmed
                steps.append({"stage": "pretrim", "method": "ffmpeg-ss-t",
                              "out": cur.name})

        cur, m = _isolate_vocals(cur, work)
        steps.append({"stage": "isolate", "method": m, "out": cur.name})

        cur, m = _denoise(cur, work)
        steps.append({"stage": "denoise", "method": m, "out": cur.name})

        cur, m = _vad_trim(cur, work)
        steps.append({"stage": "vad_trim", "method": m, "out": cur.name})

        cur, m = _normalize_and_resample(cur, work)
        steps.append({"stage": "normalize", "method": m, "out": cur.name})

        # v0.1.24: auto-transcribe the final clip with whisper. Qwen3-TTS-Base
        # ICL mode requires ref_text — when we transcribe automatically the
        # cloned voice quality is meaningfully better than the x-vector
        # embedding-only fallback. If whisper isn't loaded yet or fails we
        # leave ref_text empty and the synth path falls back to x-vector.
        auto_transcript = ""
        if not (ref_text and ref_text.strip()):
            try:
                from ..models import whisper_model
                wm = whisper_model.load()
                segs, _info = wm.transcribe(
                    str(cur), language=primary, beam_size=3,
                    vad_filter=False, word_timestamps=False,
                )
                auto_transcript = " ".join(s.text.strip() for s in segs)[:500].strip()
                if auto_transcript:
                    log.info("voice_acq.auto_transcribe: %d chars",
                             len(auto_transcript))
                    steps.append({
                        "stage": "auto_transcribe",
                        "method": "faster-whisper",
                        "out": f"{len(auto_transcript)} chars",
                    })
            except Exception as exc:
                log.warning("voice_acq.auto_transcribe failed (%s); "
                            "ref_text empty, will use x-vector mode at synth",
                            exc)
        final_ref_text = (ref_text.strip()
                          if ref_text and ref_text.strip()
                          else auto_transcript)

        # Auto-register as a clone (re-uses the existing /tts/clones logic)
        from . import tts as tts_routes  # local import to avoid cycles
        clone_id = uuid.uuid4().hex[:10]
        clones_root = Path(
            os.environ.get("XIANXIA_OUT_DIR", "./out")
        ).parent / "voice_clones"
        target_dir = clones_root / clone_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target_ref = target_dir / "ref.wav"
        shutil.copy2(cur, target_ref)
        record = {
            "id": clone_id,
            "label": label.strip()[:60] or f"Voz {clone_id}",
            "gender": "unknown",
            "primary": primary,
            "description": description.strip()[:200] or "",
            "ref_audio_path": str(target_ref),
            "ref_text": final_ref_text[:500],
            "duration_seconds": 0.0,
        }
        try:
            import soundfile as sf  # type: ignore
            record["duration_seconds"] = float(sf.info(str(target_ref)).duration)
        except Exception:
            pass
        manifest_path = clones_root / "manifest.json"
        manifest = []
        if manifest_path.exists():
            import json
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                manifest = []
        manifest.append(record)
        import json
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log.info("voice_acq: registered clone id=%s label=%s duration=%.1fs",
                 clone_id, record["label"], record["duration_seconds"])

        quality = _quality_gate(target_ref)
        return VoiceAcquisitionResponse(
            clone_id=clone_id,
            clone_path=str(target_ref),
            duration_seconds=record["duration_seconds"],
            pipeline_steps=steps,
            quality=quality,
        )
    finally:
        # best-effort cleanup of intermediate files (keep on failure for
        # debugging via XIANXIA_KEEP_VOICE_ACQ=1)
        if not os.environ.get("XIANXIA_KEEP_VOICE_ACQ"):
            try:
                shutil.rmtree(work, ignore_errors=True)
            except Exception:
                pass


@router.post("/from_url", response_model=VoiceAcquisitionResponse)
async def voice_from_url(req: VoiceFromUrlRequest) -> VoiceAcquisitionResponse:
    """Extract a clean voice clip from a YouTube/TikTok/etc URL and
    auto-register it as a clone. Heavy stages run in a thread executor."""
    work = _work_dir() / f"ingest_{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_event_loop()
    audio = await loop.run_in_executor(None, _ingest_url, req.url, work)
    return await loop.run_in_executor(
        None, _run_pipeline,
        audio, req.label, req.primary, req.description, req.ref_text,
        req.start_seconds, req.duration_seconds,
    )


@router.post("/from_file", response_model=VoiceAcquisitionResponse)
async def voice_from_file(
    audio: UploadFile = File(...),
    label: str = Form(...),
    primary: str = Form("es"),
    description: str = Form(""),
    ref_text: str = Form(""),
    start_seconds: float | None = Form(None),
    duration_seconds: float | None = Form(None),
):
    """Upload local audio/video file → run the same cleanup pipeline →
    register as a clone."""
    work = _work_dir() / f"upload_{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    suffix = Path(audio.filename or "input.bin").suffix or ".bin"
    raw_path = work / f"upload{suffix}"
    raw_path.write_bytes(await audio.read())
    loop = asyncio.get_event_loop()
    ingested = await loop.run_in_executor(
        None, _ingest_local_file, raw_path, work,
    )
    return await loop.run_in_executor(
        None, _run_pipeline,
        ingested, label, primary, description, ref_text,
        start_seconds, duration_seconds,
    )
