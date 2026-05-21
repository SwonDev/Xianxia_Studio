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
import re
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
