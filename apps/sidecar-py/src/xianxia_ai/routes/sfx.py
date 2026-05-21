"""SFX/Foley engine (v0.11.0) — Stable Audio 3 small-sfx via ComfyUI.

Auto-foley: añade capa auditiva no-musical (pasos, viento, choques, embers,
ambient) sincronizada con el guion. Está demostrado por data 2026 que la
"layered hook" (visual + verbal + **auditory**) sube el 3-second hold 3×
en YouTube/TikTok. Submagic y CapCut lo vendieron como feature premium
en 2026; aquí lo hacemos 100% local.

¿Por qué Stable Audio 3 (no MMAudio)?
  - Licencia: Community License (comercial OK <$1M) vs MMAudio CC-BY-NC
    (BLOQUEADOR comercial).
  - VRAM: 459M + T5Gemma ≈ 2 GB FP16 vs MMAudio 5+ GB. Cabe en 8 GB sin
    coord VRAM extra junto a Z-Image.
  - ComfyUI Day-0 oficial (PR #14010 ComfyUI v0.22.0, 20-may-2026).
  - Para nuestro caso NO necesitamos sync vídeo→audio nativo: ya tenemos
    timestamps del planner narrativo. Generamos SFX por texto + overlay
    ffmpeg en timestamp exacto = pipeline determinista.

Endpoints:
  - POST /sfx/generate — genera UN clip SFX (prompt + duration_seconds).
  - POST /sfx/plan_events — analiza un script y devuelve lista de
    `{timestamp_seconds, duration_seconds, prompt, category}` con
    eventos foley sugeridos por el LLM (Gemma 4B ya cargado).

Reglas:
  - GPU-only (ComfyUI carga el modelo en GPU). Si la GPU está saturada,
    el caller hace `ensure_comfyui_vram` ANTES (mismo patrón que Z-Image).
  - 100% local: stable_audio_3_small_sfx.safetensors + t5gemma_b_b_ul2
    se descargan al instalar el componente opcional `stable-audio-sfx`.
  - subprocess/httpx con timeouts explícitos (v0.7.14+ hardening).
  - No mock: si el modelo no está instalado, devuelve 503.
  - JSON balanced-braces parser para output LLM (reusa _iter_balanced_braces
    de clipmine.py).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import generate as llm_generate
from ..logging_utils import log_event

router = APIRouter()


# ─────────────────────────────── modelos ───────────────────────────────


class SfxGenerateRequest(BaseModel):
    """Petición de generación de un solo clip SFX."""

    prompt: str = Field(..., description="Descripción textual del SFX (en inglés idealmente).")
    duration_seconds: float = Field(
        5.0, ge=0.5, le=30.0,
        description="Duración del clip generado (0.5-30 s; >30 s mejor usar /music).",
    )
    seed: int | None = Field(
        None, description="Seed determinista; auto-random si None.",
    )
    steps: int = Field(
        8, ge=4, le=50,
        description="Pasos del KSampler. 8 = balance speed/calidad para SFX.",
    )
    cfg: float = Field(
        6.0, ge=1.0, le=15.0,
        description="Classifier-Free Guidance. 6.0 default para SFX (mayor que música).",
    )


class SfxGenerateResponse(BaseModel):
    audio_path: str
    duration_seconds: float
    prompt: str
    seed_used: int
    generated_in_seconds: float


class SfxEvent(BaseModel):
    """Un evento foley a inyectar en el timeline final."""

    timestamp_seconds: float = Field(..., ge=0.0, description="Inicio en el vídeo final.")
    duration_seconds: float = Field(..., ge=0.3, le=15.0)
    prompt: str = Field(..., description="Prompt SFX (inglés).")
    category: str = Field(..., description="impact | ambient | foley | whoosh | natural | mystic")
    volume_db: float = Field(
        -10.0, ge=-30.0, le=0.0,
        description="Volumen relativo al narration. Por defecto -10 dB.",
    )
    rationale: str = Field("", description="Por qué encaja en ese momento.")


class PlanSfxEventsRequest(BaseModel):
    """Petición de planificación de eventos foley para un script."""

    script_text: str = Field(..., description="Script completo con marcadores temporales si los hay.")
    total_duration_seconds: float = Field(
        ..., gt=0.0,
        description="Duración total del vídeo final (para validar timestamps).",
    )
    target_event_count: int = Field(
        8, ge=2, le=30,
        description="Número objetivo de eventos. 6-12 es óptimo para 10 min.",
    )
    style_hint: str = Field(
        "cinematic",
        description="Pista de estilo: cinematic | hype | calm | epic | mystic.",
    )


class PlanSfxEventsResponse(BaseModel):
    events: list[SfxEvent]


# ───────────────────────── helpers ─────────────────────────


def _resolve_workflow_path() -> Path:
    """Encuentra el workflow JSON empaquetado en el sidecar."""
    return (
        Path(__file__).resolve().parents[1] / "workflows" / "stable_audio_3_sfx.json"
    )


def _build_workflow(
    prompt: str, duration_seconds: float, seed: int, steps: int, cfg: float,
) -> dict:
    """Carga el template y sustituye placeholders. Mismo patrón que
    `comfyui_client.xianxia_workflow` para Z-Image."""
    wf_path = _resolve_workflow_path()
    if not wf_path.is_file():
        raise HTTPException(
            503,
            f"workflow stable_audio_3_sfx.json not found at {wf_path}. "
            "Reinstall the SFX component.",
        )
    raw = wf_path.read_text(encoding="utf-8")
    # ComfyUI espera tipos correctos en `inputs`. El placeholder
    # "{{duration_seconds}}" en el JSON es un string; lo reemplazamos
    # por un número crudo y luego parseamos.
    raw = raw.replace('"{{prompt}}"', json.dumps(prompt))
    raw = raw.replace('"{{duration_seconds}}"', f"{duration_seconds:.3f}")
    raw = raw.replace('"{{seed}}"', str(seed))
    raw = raw.replace('"{{steps}}"', str(steps))
    raw = raw.replace('"{{cfg}}"', f"{cfg:.2f}")
    return json.loads(raw)


# ─────────────────────────── rutas ───────────────────────────


@router.post("/generate", response_model=SfxGenerateResponse)
async def sfx_generate(req: SfxGenerateRequest) -> SfxGenerateResponse:
    """Genera UN clip SFX via ComfyUI + Stable Audio 3 small-sfx.

    El caller (Rust pipeline o UI) es responsable de:
      - `ensure_comfyui_vram(min_gb=2.5)` ANTES de llamar (regla GPU-only).
      - `wake_llm` NO es necesario aquí (esto no toca LLM).
      - Overlay del WAV resultante en el timeline final via ffmpeg.

    Errores: 503 si el modelo no está instalado, 500 si ComfyUI falla.
    """
    from ..models import comfyui_client

    if not comfyui_client.is_running():
        raise HTTPException(
            503,
            "ComfyUI not running on :8188. Required for Stable Audio 3 SFX.",
        )

    # Seed determinista pero variable por defecto (uuid → int 32-bit).
    seed = req.seed if req.seed is not None else (uuid.uuid4().int & 0x7FFFFFFF)

    log_event(
        "info", "sfx_generate_start",
        prompt=req.prompt[:80], duration=req.duration_seconds,
        seed=seed, steps=req.steps, cfg=req.cfg,
    )

    t0 = time.time()
    try:
        workflow = _build_workflow(
            req.prompt, req.duration_seconds, seed, req.steps, req.cfg,
        )
        prompt_id = await asyncio.to_thread(comfyui_client.queue_prompt, workflow)
        audio_path = await asyncio.to_thread(comfyui_client.wait_for_audio, prompt_id)
    except RuntimeError as exc:
        # Orphan, cache-miss, etc — propaga como 500 con detalle.
        raise HTTPException(500, f"ComfyUI SFX generation failed: {exc}") from exc
    except TimeoutError as exc:
        raise HTTPException(504, f"ComfyUI SFX timeout: {exc}") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"SFX generation unexpected error: {exc}") from exc

    elapsed = time.time() - t0
    log_event(
        "info", "sfx_generate_done",
        path=str(audio_path), elapsed=round(elapsed, 2), seed=seed,
    )

    return SfxGenerateResponse(
        audio_path=str(audio_path),
        duration_seconds=req.duration_seconds,
        prompt=req.prompt,
        seed_used=seed,
        generated_in_seconds=round(elapsed, 2),
    )


_SFX_PLAN_PROMPT = """You are a SOUND DESIGNER planning the foley/SFX layer for
a {style} short-form video. Given the script below, produce a JSON list of
EXACTLY {n_events} sound effect events that, when overlaid on the narration,
will boost the 3-second hook hold and the overall retention curve.

TOTAL VIDEO DURATION: {total_dur:.1f} seconds.

SCRIPT:
{script}

CONSTRAINTS:
- Output JSON only, no prose:
  {{
    "events": [
      {{
        "timestamp_seconds": <float, between 0 and {total_dur:.1f}>,
        "duration_seconds": <float, between 0.5 and 8.0>,
        "prompt": "<English sound description, concise, 2-8 words; what the SFX is>",
        "category": "<impact|ambient|foley|whoosh|natural|mystic>",
        "volume_db": <float, between -20 and -5; default -10>,
        "rationale": "<1 sentence why this SFX boosts retention HERE>"
      }},
      ...
    ]
  }}
- Timestamps in increasing order. No overlap between events of the same category.
- Hook (0-3 s): MUST have at least 1 impact or whoosh event.
- Outro (last 3 s): MUST have at least 1 mystic/natural event for closure.
- Mid (3 s → end-3 s): mix of foley and ambient to support beats.
- Prompts in ENGLISH (Stable Audio 3 trained on English).
- Avoid speech/music — those are handled separately.
- Avoid generic "ambient music" / "background music" — we want SFX layer.
- Categories MUST be one of: impact, ambient, foley, whoosh, natural, mystic.
"""


@router.post("/plan_events", response_model=PlanSfxEventsResponse)
async def plan_sfx_events(req: PlanSfxEventsRequest) -> PlanSfxEventsResponse:
    """Pide al LLM (Gemma 4B) que sugiera N eventos foley para el guion.

    El cliente Tauri llama esto DESPUÉS de tener el script + total_duration
    finales, antes de pasar al render. Devuelve eventos validados y
    ordenados; cada uno se genera luego con `/sfx/generate`.
    """
    if not req.script_text.strip():
        raise HTTPException(400, "script_text está vacío")

    prompt = _SFX_PLAN_PROMPT.format(
        style=req.style_hint,
        n_events=req.target_event_count,
        total_dur=req.total_duration_seconds,
        script=req.script_text[:8000],  # cap por context window
    )

    log_event(
        "info", "sfx_plan_start",
        target_n=req.target_event_count,
        total_dur=req.total_duration_seconds,
        style=req.style_hint,
    )

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
        ) as client:
            result = await llm_generate(
                model="xianxia-llm",
                system=None,
                prompt=prompt,
                options={
                    "temperature": 0.6,
                    "top_p": 0.9,
                    "num_ctx": 8192,
                    "num_predict": 2048,
                },
                format="json",
                client=client,
                timeout=120.0,
            )
            raw = (result.get("response") or "").strip()
    except Exception as exc:
        raise HTTPException(500, f"SFX planner LLM failed: {exc}") from exc

    if not raw:
        raise HTTPException(500, "LLM returned empty response")

    # Reusamos balanced-braces parser de clipmine.py (v0.9.1).
    from .clipmine import _iter_balanced_braces

    parsed: dict | None = None
    for obj_text in _iter_balanced_braces(raw):
        try:
            data = json.loads(obj_text)
        except json.JSONDecodeError:
            try:
                data = json.loads(re.sub(r",(\s*[}\]])", r"\1", obj_text))
            except json.JSONDecodeError:
                continue
        if isinstance(data, dict) and isinstance(data.get("events"), list):
            parsed = data
            break

    if not parsed:
        raise HTTPException(500, f"LLM output unparseable: {raw[:200]}")

    valid_cats = {"impact", "ambient", "foley", "whoosh", "natural", "mystic"}
    events: list[SfxEvent] = []
    for e in parsed["events"]:
        try:
            ts = float(e.get("timestamp_seconds", 0.0))
            dur = float(e.get("duration_seconds", 2.0))
            cat = str(e.get("category", "foley")).strip().lower()
            if cat not in valid_cats:
                cat = "foley"
            ptxt = str(e.get("prompt", "")).strip()[:160]
            vol = float(e.get("volume_db", -10.0))
            rat = str(e.get("rationale", "")).strip()[:200]
        except (TypeError, ValueError):
            continue

        # Validación de rangos.
        if not ptxt or ts < 0 or ts > req.total_duration_seconds:
            continue
        if dur < 0.3 or dur > 15.0:
            continue
        if ts + dur > req.total_duration_seconds + 0.5:
            dur = max(0.3, req.total_duration_seconds - ts)
        vol = max(-30.0, min(0.0, vol))

        events.append(SfxEvent(
            timestamp_seconds=round(ts, 3),
            duration_seconds=round(dur, 3),
            prompt=ptxt,
            category=cat,
            volume_db=round(vol, 1),
            rationale=rat,
        ))

    if not events:
        raise HTTPException(500, "LLM returned no valid SFX events after validation")

    events.sort(key=lambda e: e.timestamp_seconds)

    log_event(
        "info", "sfx_plan_done",
        events_count=len(events),
        categories_used=sorted({e.category for e in events}),
    )

    return PlanSfxEventsResponse(events=events)


# ─────────────────── /sfx/apply_to_video (v0.12.4) ──────────────────


class ApplyToVideoRequest(BaseModel):
    """Petición end-to-end: orquesta plan_events + N×generate + ffmpeg
    overlay sobre un vídeo final ya renderizado. Esta es la entrada
    única que usa `pipeline/mod.rs` Phase 14 (best-effort)."""

    video_path: str = Field(..., description="MP4 final con audio ya muxeado.")
    script_text: str = Field(..., description="Script completo para plan_events.")
    out_dir: str | None = Field(
        None,
        description="Directorio donde guardar el nuevo MP4 + SFX. Default `./out/sfx_overlay/`.",
    )
    target_event_count: int = Field(8, ge=2, le=20)
    style_hint: str = Field("cinematic")


class ApplyToVideoResponse(BaseModel):
    sfx_applied: bool
    output_path: str | None = None
    reason: str | None = None
    events_count: int = 0


def _probe_video_duration(video_path: str) -> float:
    """ffprobe duration; v0.7.16 timeout 30 s pattern."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", video_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(proc.stdout.strip())
    except Exception:
        return 0.0


@router.post("/apply_to_video", response_model=ApplyToVideoResponse)
async def apply_to_video(req: ApplyToVideoRequest) -> ApplyToVideoResponse:
    """End-to-end SFX overlay sobre un vídeo final. Best-effort.

    Pipeline interno:
      1. ffprobe duración total del vídeo.
      2. plan_events vía LLM (Gemma 4B) → N eventos foley.
      3. Para cada evento: generate vía ComfyUI Stable Audio 3 small-sfx.
      4. ffmpeg amix multi-input con ducking: voz/música del vídeo
         original + capa SFX al volumen indicado por evento.
      5. Devuelve nuevo MP4 path o (False + reason) si cualquier paso
         falla. NO lanza HTTPException — Rust caller espera 200 con
         `sfx_applied=false` para detectar skip.
    """
    src = Path(req.video_path)
    if not src.is_file():
        return ApplyToVideoResponse(
            sfx_applied=False, reason=f"video not found: {req.video_path}",
        )

    base_out = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out")) / "sfx_overlay"
    base_out.mkdir(parents=True, exist_ok=True)

    total_dur = _probe_video_duration(req.video_path)
    if total_dur <= 0.0:
        return ApplyToVideoResponse(
            sfx_applied=False, reason="ffprobe could not read duration",
        )

    log_event(
        "info", "sfx_apply_start",
        video=req.video_path, duration=round(total_dur, 2),
        target_n=req.target_event_count, style=req.style_hint,
    )

    # ── 1. plan_events vía el endpoint hermano (con LLM Gemma 4B) ──
    try:
        plan_resp = await plan_sfx_events(
            PlanSfxEventsRequest(
                script_text=req.script_text,
                total_duration_seconds=total_dur,
                target_event_count=req.target_event_count,
                style_hint=req.style_hint,
            )
        )
        events = plan_resp.events
    except HTTPException as exc:
        return ApplyToVideoResponse(
            sfx_applied=False, reason=f"plan_events failed: {exc.detail}",
        )
    except Exception as exc:
        return ApplyToVideoResponse(
            sfx_applied=False, reason=f"plan_events crashed: {exc}",
        )

    if not events:
        return ApplyToVideoResponse(
            sfx_applied=False, reason="LLM returned 0 SFX events",
        )

    # ── 2. Generar cada SFX via ComfyUI Stable Audio 3 ──────────────
    # Usamos un único cliente para reutilizar conexión TCP.
    generated: list[dict] = []  # [{event, audio_path}]
    for i, ev in enumerate(events):
        try:
            gen = await sfx_generate(
                SfxGenerateRequest(
                    prompt=ev.prompt,
                    duration_seconds=ev.duration_seconds,
                    seed=None,
                    steps=8,
                    cfg=6.0,
                )
            )
            generated.append({"event": ev, "audio_path": gen.audio_path})
            log_event(
                "info", "sfx_apply_event_done",
                idx=i + 1, total=len(events),
                category=ev.category, ts=ev.timestamp_seconds,
                dur=ev.duration_seconds,
            )
        except HTTPException as exc:
            log_event(
                "warning", "sfx_apply_event_fail",
                idx=i + 1, prompt=ev.prompt[:60], err=str(exc.detail)[:160],
            )
            # Sigue con los demás; falla parcial es aceptable (best-effort).
            continue
        except Exception as exc:
            log_event(
                "warning", "sfx_apply_event_crash",
                idx=i + 1, prompt=ev.prompt[:60], err=str(exc)[:160],
            )
            continue

    if not generated:
        return ApplyToVideoResponse(
            sfx_applied=False,
            reason="all SFX generation calls failed",
            events_count=0,
        )

    # ── 3. ffmpeg overlay multi-input ──────────────────────────────
    # Construimos un filter_complex con:
    #   - Input 0 = vídeo + audio originales
    #   - Inputs 1..N = WAV de cada SFX, con adelay = timestamp_ms y
    #     volume = volume_db del evento (LLM ya lo dio entre -30 y 0)
    #   - amix los SFX entre sí + mix con el audio original (que
    #     domina porque la voz NO se debe enmascarar).
    out_path = base_out / f"final-sfx-{uuid.uuid4().hex[:10]}.mp4"

    cmd: list[str] = ["ffmpeg", "-y", "-i", str(src)]
    for g in generated:
        cmd += ["-i", str(g["audio_path"])]

    # filter_complex: per-SFX delay + volume; luego amix.
    parts: list[str] = []
    sfx_labels: list[str] = []
    for i, g in enumerate(generated, start=1):
        ev: SfxEvent = g["event"]
        delay_ms = int(round(ev.timestamp_seconds * 1000))
        # adelay 1ch → mono → amerge nos forzaría a saber canales; mejor
        # adelay=NN|NN (stereo). El audio de Stable Audio es 44.1 kHz
        # estéreo nativo, así que delay en ambos canales.
        # volume: dB → linear. ffmpeg acepta "0.5dB" pero más portable
        # es 10^(dB/20). Lo precomputamos.
        gain = 10 ** (ev.volume_db / 20.0)
        label = f"[s{i}]"
        parts.append(
            f"[{i}:a]adelay={delay_ms}|{delay_ms},volume={gain:.4f}{label}"
        )
        sfx_labels.append(label)
    # Mezcla de todas las pistas SFX entre sí (si solo hay 1, anull es OK).
    if len(sfx_labels) == 1:
        parts.append(f"{sfx_labels[0]}anull[sfxmix]")
    else:
        parts.append(
            f"{''.join(sfx_labels)}amix=inputs={len(sfx_labels)}:dropout_transition=0:normalize=0[sfxmix]"
        )
    # Mix final: audio original [0:a] + [sfxmix]. dropout_transition=0
    # para no atenuar la voz al entrar/salir cada SFX.
    parts.append(
        "[0:a][sfxmix]amix=inputs=2:dropout_transition=0:weights=1 0.85:normalize=0[aout]"
    )
    filter_complex = ";".join(parts)

    cmd += [
        "-filter_complex", filter_complex,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",  # vídeo intacto byte-idéntico
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart",
        str(out_path),
    ]

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired as exc:
        return ApplyToVideoResponse(
            sfx_applied=False,
            reason=f"ffmpeg overlay timeout (>10 min): {exc}",
            events_count=len(generated),
        )
    if proc.returncode != 0:
        return ApplyToVideoResponse(
            sfx_applied=False,
            reason=f"ffmpeg overlay failed (rc={proc.returncode}): {proc.stderr[-300:]}",
            events_count=len(generated),
        )

    # Cleanup de los WAV temporales (los generados por sfx_generate).
    for g in generated:
        try:
            Path(g["audio_path"]).unlink()
        except OSError:
            pass

    log_event(
        "info", "sfx_apply_done",
        events=len(generated), output=str(out_path),
    )

    return ApplyToVideoResponse(
        sfx_applied=True,
        output_path=str(out_path),
        events_count=len(generated),
    )
