"""Clip Miner (v0.9.0) — extract N viral short candidates from a long video.

OpusClip / Klap / Vizard-style "podcast → 10 Shorts" feature. El usuario
sube un MP4 largo (podcast, entrevista, sermón, clase grabada) y la app
analiza la transcripción con LLM + scene cuts para extraer N candidatos
ordenados por score viral.

Después el usuario elige cuáles renderizar y cada candidato pasa por el
pipeline `/shorts/from_video` ya existente (reframe + Hormozi captions +
hook + CTA + virality score + audio extract + smart reframe + scene
boundary snap). El 70% del trabajo estaba hecho desde v0.1.22.

Flujo del endpoint `/clipmine/extract`:

  1. Extraer audio 16 kHz mono con ffmpeg.
  2. Transcribir con faster-whisper large-v3-turbo (modelo ya cargado).
  3. Llamar LLM (Gemma 4B vía llm_backend) con un prompt que aplica el
     framework de virality (hook moments, emotional peaks, opinion
     bombs, revelations, conflict, quotables, story peaks, practical
     value) y devuelve JSON estricto con N candidatos.
  4. Snap a scene cuts con PySceneDetect (reutiliza `_detect_scene_cuts`
     de shorts_auto).
  5. Validar duraciones (clamp a min/max), filtrar overlaps, ordenar por
     score descendente.

NO hace render aquí: devuelve metadatos. El cliente llama a
`/shorts/from_video` para cada candidato seleccionado.

Reglas duras respetadas:
- 100% local (Whisper + Gemma 4B + PySceneDetect, todo offline).
- GPU-only para Whisper (el modelo ya está configurado así).
- No mock: si Whisper falla, propaga error real.
- subprocess.run con timeout (v0.7.16 hardening).
- httpx.AsyncClient con timeout explícito (v0.7.14 hardening).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import generate as llm_generate
from ..logging_utils import log_event

router = APIRouter()


class ClipMineRequest(BaseModel):
    """Petición de extracción de candidatos virales desde un vídeo largo."""

    video_path: str = Field(..., description="Ruta absoluta al MP4 origen.")
    n_candidates: int = Field(
        5, ge=1, le=15,
        description="Número máximo de candidatos a devolver (1-15).",
    )
    target_duration: float = Field(
        45.0, ge=15.0, le=90.0,
        description="Duración ideal por short (segundos).",
    )
    min_duration: float = Field(
        25.0, ge=10.0, le=60.0,
        description="Duración mínima aceptable.",
    )
    max_duration: float = Field(
        60.0, ge=15.0, le=180.0,
        description="Duración máxima aceptable.",
    )
    primary_language: str | None = Field(
        None,
        description="ISO 639-1 (es/en/pt/zh/...). Auto-detect si None.",
    )


class ClipCandidate(BaseModel):
    """Un candidato a short viral con metadatos suficientes para renderizar."""

    start: float = Field(..., description="Timestamp inicio en segundos.")
    end: float = Field(..., description="Timestamp fin en segundos.")
    duration: float = Field(..., description="Duración en segundos.")
    score: float = Field(..., ge=0.0, le=1.0, description="Score viral 0-1.")
    label: str = Field(..., description="Categoría: hook/peak/quotable/...")
    hook_text: str = Field(..., description="Frase gancho 1-6 palabras.")
    summary: str = Field(..., description="Resumen 1-2 frases del segmento.")
    snapped_to_scene_cut: bool = Field(
        False,
        description="True si los timestamps se ajustaron a un scene cut.",
    )


class ClipMineResponse(BaseModel):
    candidates: list[ClipCandidate]
    transcript_language: str
    total_duration: float = Field(..., description="Duración total del vídeo origen.")
    scene_cuts_detected: int = Field(..., description="Número de scene cuts encontrados.")


# ── Framework de virality — alineado con Virality Score v0.1.22 B3 ────────
# Las 4 categorías mapean a los 4 ejes del Virality Score actual:
#   Hook    → momentos de apertura fuertes (pregunta, contradicción, número).
#   Peak    → climax emocional/conflicto/revelación.
#   Value   → quotables, practical takeaways, opiniones fuertes.
#   Trend   → frases que encajan con formatos virales 2026 actuales.
_VIRALITY_PROMPT_TEMPLATE = """You are extracting the N most viral SHORT-FORM (15-90 second) clip
candidates from a long transcript. This is for vertical (9:16) social
video platforms (YouTube Shorts, TikTok, Instagram Reels).

The transcript has word-level timestamps in seconds.

TRANSCRIPT (each line: [start-end] text):
{transcript_text}

REQUIREMENTS:

Return a JSON object with exactly this shape, no prose, no markdown:
{{
  "candidates": [
    {{
      "start": <float seconds>,
      "end": <float seconds>,
      "score": <float 0.0-1.0>,
      "label": "<hook|peak|quotable|value|conflict|reveal>",
      "hook_text": "<1-6 words punchline, the line that opens the short>",
      "summary": "<1-2 sentence summary of why this clip is viral>"
    }},
    ...
  ]
}}

CONSTRAINTS:
- EXACTLY {n_candidates} candidates, ordered by score descending.
- Each clip MUST be between {min_dur} and {max_dur} seconds long.
- Target duration around {target_dur} seconds when possible.
- NO overlapping candidates: each clip's start MUST be ≥ previous end.
- Pick MOMENTS THAT MAKE A VIEWER STOP SCROLLING:
  * HOOK: bold opener (specific number, question, contradiction, promise)
  * PEAK: emotional climax, surprise, big reveal, conflict moment
  * QUOTABLE: a line worth tattooing — memorable phrasing
  * VALUE: a specific actionable takeaway in <60s
  * CONFLICT: opposing views collide, "but actually...", paradigm shift
  * REVEAL: data/fact/secret unveiled
- Skip filler ("uh", "you know", introductions, goodbyes, ad reads).
- Skip anything generic or repetitive.
- hook_text must be 1-6 words MAX, written EXACTLY as the speaker said it.
- start/end must be valid timestamps that exist in the transcript.

CONSTRAINT VIOLATION = FAILURE. Return valid JSON only."""


def _extract_audio_for_whisper(video_path: str, work_dir: Path) -> Path:
    """Extract 16 kHz mono WAV via ffmpeg. v0.7.16: timeout 10 min."""
    audio_path = work_dir / f"clipmine-audio-{uuid.uuid4().hex[:8]}.wav"
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-i", video_path,
                "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(audio_path),
            ],
            capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(500, f"audio extract timeout (>10 min): {exc}") from exc
    if proc.returncode != 0:
        raise HTTPException(
            500,
            f"audio extract failed (rc={proc.returncode}): {proc.stderr[-300:]}",
        )
    return audio_path


def _probe_total_duration(video_path: str) -> float:
    """ffprobe duration. v0.7.16: timeout 30 s, tolerante a fallo."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", video_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(proc.stdout.strip())
    except Exception:
        return 0.0


def _max_chars_for_lang(lang: str) -> int:
    """v0.9.1 fix M3 — context budget consciente del idioma.

    Para idiomas CJK (zh/ja/ko) cada carácter pesa ~1.5 tokens en BPE
    (vs ~0.3 para inglés), así que 18 000 chars desbordarían `num_ctx=
    8192` del Gemma 4B. Para CJK bajamos a ~9 000 chars de transcript
    (≈ 13 500 tokens, deja margen para el prompt overhead + 2048 num
    predict).
    """
    cjk = {"zh", "ja", "ko", "zh-cn", "zh-tw"}
    return 9000 if lang.lower() in cjk else 18000


def _build_transcript_text(words: list[dict], max_chars: int = 18000) -> str:
    """Compacta words into per-segment lines for the LLM prompt.

    Cada N palabras se agrupa en un bloque `[start-end] text`. 18k chars
    es el umbral seguro para Gemma 4B con contexto de 8k tokens en
    idiomas latinos (overhead del prompt + JSON schema ~3k tokens). Ver
    `_max_chars_for_lang` para el ajuste por idioma.
    """
    # Agrupar en ventanas de ~6s para que el LLM tenga buenas anclas.
    lines: list[str] = []
    current: list[str] = []
    cur_start: float = 0.0
    cur_end: float = 0.0
    WINDOW = 6.0  # segundos por línea

    for w in words:
        text = (w.get("word") or w.get("text") or "").strip()
        if not text:
            continue
        ws = float(w.get("start", 0.0) or 0.0)
        we = float(w.get("end", ws) or ws)
        if not current:
            cur_start = ws
        cur_end = we
        current.append(text)
        if cur_end - cur_start >= WINDOW:
            line = f"[{cur_start:.1f}-{cur_end:.1f}] " + " ".join(current)
            lines.append(line)
            current = []
    if current:
        lines.append(f"[{cur_start:.1f}-{cur_end:.1f}] " + " ".join(current))

    text = "\n".join(lines)
    if len(text) > max_chars:
        # Si excede, cogemos los primeros 50% y los últimos 30% (el LLM
        # tiende a quemar los hooks al principio y los peaks al final).
        head_cut = int(max_chars * 0.6)
        tail_cut = int(max_chars * 0.3)
        text = text[:head_cut] + "\n[…middle elided for length…]\n" + text[-tail_cut:]
    return text


def _iter_balanced_braces(text: str):
    """Yield every well-formed `{...}` substring at any depth de `text`.

    El parser ingenuo `re.search(r'\\{[\\s\\S]*\\}', raw)` matchea desde
    la PRIMERA `{` hasta la ÚLTIMA `}`, lo cual rompe si el LLM emite
    prosa intermedia tipo "Aquí tienes {junk} y este {real json}".
    Este iterador encuentra todos los bloques balanceados y permite
    probarlos uno a uno hasta dar con uno parseable.
    """
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                yield text[start : i + 1]
                start = -1
            elif depth < 0:
                depth = 0  # corregir si hay basura


def _parse_llm_candidates(raw: str) -> list[dict]:
    """Extract the candidates array from an LLM JSON response, tolerantly.

    v0.9.1 — parser balanced-braces. Antes el `re.search(r'\\{[\\s\\S]*\\}')`
    podía matchear desde la primera `{` de prosa hasta la última `}`,
    corrompiendo el JSON. Ahora intentamos cada bloque balanceado y
    devolvemos el PRIMERO que parsea y contiene `candidates`/`clips`.
    """
    last_exc: Exception | None = None
    for obj_text in _iter_balanced_braces(raw):
        try:
            data = json.loads(obj_text)
        except json.JSONDecodeError as exc:
            # Trailing commas (Gemma a veces los emite).
            cleaned = re.sub(r",(\s*[}\]])", r"\1", obj_text)
            try:
                data = json.loads(cleaned)
            except json.JSONDecodeError as exc2:
                last_exc = exc2
                continue
        if not isinstance(data, dict):
            continue
        cands = data.get("candidates") or data.get("clips")
        if isinstance(cands, list):
            return cands
    # Ningún bloque parseó. Reportar con preview legible.
    raise ValueError(
        f"no parseable JSON candidates object in LLM output "
        f"(first 200 chars): {raw[:200]} | last_err: {last_exc}"
    )


def _validate_and_clamp_candidate(
    c: dict,
    total_duration: float,
    min_dur: float,
    max_dur: float,
) -> dict | None:
    """Sanea un candidato del LLM. Devuelve None si no es salvable."""
    try:
        start = max(0.0, float(c.get("start", 0.0)))
        end = float(c.get("end", start + 30.0))
        score = float(c.get("score", 0.5))
    except (TypeError, ValueError):
        return None

    if total_duration > 0:
        end = min(end, total_duration)
    if end <= start:
        return None

    dur = end - start
    if dur < min_dur:
        # Estirar simétricamente hacia ambos lados hasta min_dur.
        pad = (min_dur - dur) / 2
        start = max(0.0, start - pad)
        end = start + min_dur
        if total_duration > 0:
            end = min(end, total_duration)
        if end - start < min_dur * 0.8:  # si ni así llega, descartar
            return None
    if dur > max_dur:
        # Recortar centrado, manteniendo el centro narrativo.
        center = (start + end) / 2
        start = max(0.0, center - max_dur / 2)
        end = start + max_dur

    label = str(c.get("label", "peak")).strip().lower()
    if label not in {"hook", "peak", "quotable", "value", "conflict", "reveal"}:
        label = "peak"
    hook_text = str(c.get("hook_text", "")).strip()[:80]
    summary = str(c.get("summary", "")).strip()[:240]
    score = max(0.0, min(1.0, score))

    return {
        "start": round(start, 3),
        "end": round(end, 3),
        "duration": round(end - start, 3),
        "score": round(score, 3),
        "label": label,
        "hook_text": hook_text,
        "summary": summary,
    }


def _remove_overlaps(candidates: list[dict]) -> list[dict]:
    """Greedy non-overlapping (sorted by score descending). v0.1.22 patrón."""
    sorted_cands = sorted(candidates, key=lambda c: c["score"], reverse=True)
    picked: list[dict] = []
    for c in sorted_cands:
        overlap = False
        for p in picked:
            if not (c["end"] <= p["start"] or c["start"] >= p["end"]):
                overlap = True
                break
        if not overlap:
            picked.append(c)
    # Devolver ordenados por timestamp (UI los muestra cronológicamente).
    picked.sort(key=lambda c: c["start"])
    return picked


@router.post("/extract", response_model=ClipMineResponse)
async def clipmine_extract(req: ClipMineRequest) -> ClipMineResponse:
    """Extract N viral short candidates from a long video.

    Pipeline:
      1. ffmpeg audio extract → 16 kHz mono WAV.
      2. faster-whisper large-v3-turbo word-level transcribe.
      3. LLM (Gemma 4B) candidate detection con framework virality.
      4. PySceneDetect snap a scene cuts (reusa shorts_auto._detect_scene_cuts).
      5. Validate + clamp + remove overlaps + sort by timestamp.
    """
    src = Path(req.video_path)
    if not src.is_file():
        raise HTTPException(404, f"video not found: {req.video_path}")

    out_dir = Path(os.environ.get("XIANXIA_OUT_DIR", "./out")) / "clipmine"
    out_dir.mkdir(parents=True, exist_ok=True)

    log_event(
        "info", "clipmine_start",
        video=req.video_path, n=req.n_candidates,
        min_dur=req.min_duration, max_dur=req.max_duration,
    )

    # 1. Audio para Whisper.
    audio_path = _extract_audio_for_whisper(req.video_path, out_dir)
    total_duration = _probe_total_duration(req.video_path)

    # v0.9.1 fix A4 — todo el resto del flow va envuelto en try/finally
    # para que el WAV temporal (≈230 MB para 2 h) se borre incluso si el
    # LLM, el parser JSON o el snap fallan. Antes solo el camino feliz
    # limpiaba, y los errores acumulaban ficheros en `<data>/out/clipmine/`.
    try:
        return await _do_clipmine_pipeline(
            req, audio_path, total_duration,
        )
    finally:
        try:
            audio_path.unlink()
        except OSError:
            pass


async def _do_clipmine_pipeline(
    req: ClipMineRequest,
    audio_path: Path,
    total_duration: float,
) -> ClipMineResponse:
    """Pipeline core de Clip Miner, extraído del endpoint para que el
    `finally` del cleanup del audio temporal aplique a TODOS los paths
    de error (whisper, llm, parse, snap, validate). v0.9.1 fix A4."""
    from ..models import whisper_model
    from .shorts_auto import _detect_scene_cuts, _snap_to_scene_cuts

    # 2. Transcripción (firma real: transcribe_words(path, language, *, vad)
    #    → (segments_list, info)). vad=True para vídeo uploaded (skip
    #    non-speech stretches), no como TTS limpio narrative.
    try:
        segments, info = await asyncio.to_thread(
            whisper_model.transcribe_words,
            str(audio_path),
            req.primary_language,
            vad=True,
        )
    except Exception as exc:
        try:
            audio_path.unlink()
        except OSError:
            pass
        raise HTTPException(500, f"whisper transcribe failed: {exc}") from exc

    detected_lang = getattr(info, "language", None) or req.primary_language or "en"

    # Aplanar segments → words. faster-whisper devuelve segments con .words
    # (lista de Word objects con .word/.start/.end). En vad=True algunos
    # segmentos pueden venir sin .words si toda la palabra cayó en un VAD
    # silencio borderline; se filtra defensivamente.
    words: list[dict] = []
    for seg in segments:
        seg_words = getattr(seg, "words", None) or []
        for w in seg_words:
            text = (getattr(w, "word", "") or "").strip()
            if not text:
                continue
            try:
                ws = float(getattr(w, "start", 0.0) or 0.0)
                we = float(getattr(w, "end", ws) or ws)
            except (TypeError, ValueError):
                continue
            words.append({"word": text, "start": ws, "end": we})

    if not words:
        raise HTTPException(
            500,
            "transcript has no words; the source video may be silent or unsupported",
        )

    log_event(
        "info", "clipmine_transcribed",
        lang=detected_lang, words=len(words),
        duration=total_duration,
    )

    # v0.9.1 fix A1 — liberar Whisper de la VRAM ANTES de invocar al LLM.
    # En GPUs de 8 GB no caben Whisper (6 GB en turbo) + Gemma 4B (3-4 GB)
    # simultáneamente. Misma pauta que `shorts_auto.py` aplica antes de
    # llamar al LLM. best-effort; si la unload falla, se sigue (el LLM
    # backend tiene su propio health probe que detectará el OOM).
    try:
        if await asyncio.to_thread(whisper_model.unload):
            log_event("info", "clipmine_whisper_unloaded")
    except Exception as exc:
        log_event("warning", "clipmine_whisper_unload_fail", err=str(exc)[:200])

    # 3. LLM candidate detection.
    # v0.9.1 fix M3 — context budget consciente del idioma (CJK pesa más).
    transcript_text = _build_transcript_text(
        words, max_chars=_max_chars_for_lang(detected_lang),
    )
    prompt = _VIRALITY_PROMPT_TEMPLATE.format(
        transcript_text=transcript_text,
        n_candidates=req.n_candidates,
        min_dur=req.min_duration,
        max_dur=req.max_duration,
        target_dur=req.target_duration,
    )
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(180.0, connect=10.0),
        ) as client:
            result = await llm_generate(
                model="xianxia-llm",
                system=None,
                prompt=prompt,
                options={
                    "temperature": 0.4,
                    "top_p": 0.9,
                    "num_ctx": 8192,
                    "num_predict": 2048,
                },
                format="json",
                client=client,
                timeout=180.0,
            )
            raw = (result.get("response") or "").strip()
    except Exception as exc:
        raise HTTPException(500, f"LLM candidate detection failed: {exc}") from exc

    if not raw:
        raise HTTPException(500, "LLM returned empty response")

    try:
        cands_raw = _parse_llm_candidates(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        log_event("warning", "clipmine_parse_fail", err=str(exc)[:200])
        raise HTTPException(500, f"LLM output unparseable: {exc}") from exc

    # 4. Validate + clamp.
    validated: list[dict] = []
    for c in cands_raw:
        v = _validate_and_clamp_candidate(
            c, total_duration, req.min_duration, req.max_duration,
        )
        if v:
            validated.append(v)
    if not validated:
        raise HTTPException(
            500,
            "LLM returned no valid candidates after clamping (all out of bounds)",
        )

    # 5. Scene cut snap (reusa de v0.1.22 A3).
    scene_cuts = await asyncio.to_thread(_detect_scene_cuts, req.video_path)
    log_event("info", "clipmine_scenes", scene_cuts=len(scene_cuts))

    # v0.9.1 fix M2 — snap solo si la nueva duración SIGUE dentro del
    # rango duro [min, max] pedido por el cliente. Antes el snap podía
    # acortar el clip por debajo del mínimo (start +1.4 s, end inalterado
    # → duración -1.4 s), y el rescate de "min*0.8 ≤ dur ≤ max*1.2" era
    # demasiado laxo: devolvía clips fuera de spec a la UI. Ahora si el
    # snap rompe el rango duro, se REVERTI al pre-snap.
    for v in validated:
        if not scene_cuts:
            v["snapped_to_scene_cut"] = False
            continue
        snapped_start, snapped_end = _snap_to_scene_cuts(
            scene_cuts, v["start"], v["end"], tolerance=1.5,
        )
        if (snapped_start, snapped_end) == (v["start"], v["end"]):
            v["snapped_to_scene_cut"] = False
            continue
        new_dur = snapped_end - snapped_start
        # Solo aceptar el snap si conserva el rango duro pedido. Margen
        # 5% para tolerar el redondeo de PySceneDetect.
        if req.min_duration * 0.95 <= new_dur <= req.max_duration * 1.05:
            v["start"] = round(snapped_start, 3)
            v["end"] = round(snapped_end, 3)
            v["duration"] = round(new_dur, 3)
            v["snapped_to_scene_cut"] = True
        else:
            # Snap rompería el rango: descartar el snap, mantener pre-snap.
            v["snapped_to_scene_cut"] = False
            log_event(
                "info", "clipmine_snap_rejected",
                reason="duration_out_of_range",
                new_dur=round(new_dur, 3),
                min_d=req.min_duration, max_d=req.max_duration,
            )

    # Tras aceptar/rechazar snap, todos los candidates siguen en su rango.
    # No hace falta un re-validate suave: `validated` ya está limpio.
    final = list(validated)

    # 6. Remove overlaps + sort.
    final = _remove_overlaps(final)[: req.n_candidates]
    # (cleanup del audio temporal: el `finally` del endpoint padre lo hace.)

    log_event(
        "info", "clipmine_done",
        candidates=len(final),
        avg_score=(
            round(sum(c["score"] for c in final) / max(1, len(final)), 3)
        ),
    )

    return ClipMineResponse(
        candidates=[ClipCandidate(**c) for c in final],
        transcript_language=detected_lang,
        total_duration=total_duration,
        scene_cuts_detected=len(scene_cuts),
    )
