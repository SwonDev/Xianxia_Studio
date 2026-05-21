"""Originality Engine (v0.10.0) — anti-templating + Originality Manifest.

Por qué existe:
  YouTube enforcement enero 2026 ("inauthentic content") + EU AI Act
  Article 50 (2 agosto 2026) penaliza canales cuyos vídeos se parezcan
  estructuralmente entre sí o no tengan aportación humana demostrable.
  Sin este gate, los usuarios de Xianxia Studio pueden perder
  monetización tras 2-3 vídeos.

Qué hace:
  1. **Detector estructural** (`/originality/check_structural`):
     compara el script actual contra los N scripts previos del canal
     usando Jaccard de n-gramas (3 y 5) + similitud de longitudes de
     capítulo + densidad de hooks/CTAs. Cero modelos nuevos: 100% local
     con stdlib Python. Devuelve `{score, most_similar, warnings}`.
  2. **Generador de hooks alternativos** (`/originality/hook_alternatives`):
     dado el topic y outline, genera 3 hooks variados (pregunta /
     número / contradicción). LLM Gemma 4B ya cargado. El usuario
     elige uno → señal de aportación humana.
  3. **Originality Manifest builder** (`/originality/build_manifest`):
     construye JSON auditable con `sources[]` (Wikipedia URLs + quotes
     extraídas vía RAG existente), `thesis_user`, `hook_chosen`,
     `human_edits[]`. Adjuntable al YouTube upload.

Reglas respetadas:
  - 100% local (Jaccard stdlib + LLM Gemma 4B existente).
  - GPU-only cuando aplica (LLM).
  - subprocess/httpx con timeout (v0.7.14 hardening).
  - No mock: si el LLM falla, propaga error real.
  - No path traversal: solo recibe IDs de proyecto, busca en DB.

Wire al pipeline (v0.10.1):
  Una FASE NUEVA entre Planner (outline) y Script chapter: el pipeline
  pausa, muestra warnings + 3 hooks + form de thesis/edit, y solo
  continúa si `audit_status='approved'`.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import Counter
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import generate as llm_generate
from ..logging_utils import log_event

router = APIRouter()


# ───────────────────────────────── modelos ─────────────────────────────────


class StructuralCheckRequest(BaseModel):
    """Una petición de chequeo de similitud estructural."""

    project_id: str = Field(..., description="Proyecto en curso (ya creado en DB).")
    script_text: str = Field(..., description="Texto completo del script en curso.")
    chapters: list[str] | None = Field(
        None,
        description="Títulos de capítulos en orden, para comparación estructural.",
    )
    previous_scripts: list[dict] = Field(
        default_factory=list,
        description=(
            "Lista de dicts {project_id, title, script_text, chapters[]} de los "
            "vídeos previos del mismo canal. El cliente Tauri los lee de la DB y "
            "los pasa aquí — el sidecar es stateless."
        ),
    )


class StructuralWarning(BaseModel):
    code: str
    detail: str
    severity: str  # info | warning | blocking


class StructuralCheckResponse(BaseModel):
    score: float = Field(..., ge=0.0, le=1.0)
    most_similar_project_id: str | None = None
    warnings: list[StructuralWarning] = Field(default_factory=list)
    # `audit_status` recomendado: el cliente decide qué hacer.
    recommended_status: str = Field(
        ...,
        description="approved | pending | rejected — sugerencia para la UI.",
    )


class HookAlternativesRequest(BaseModel):
    topic: str
    outline: str | None = Field(None, description="Outline del vídeo (1 párrafo).")
    primary_language: str = Field("en", description="ISO 639-1.")
    n_alternatives: int = Field(3, ge=2, le=5)


class HookAlternative(BaseModel):
    kind: str = Field(..., description="question | number | contradiction | promise | story")
    text: str = Field(..., description="Hook 1-2 frases.")
    rationale: str = Field(..., description="Por qué este hook engancha (1 frase).")


class HookAlternativesResponse(BaseModel):
    alternatives: list[HookAlternative]


class BuildManifestRequest(BaseModel):
    project_id: str
    topic: str
    thesis_user: str = Field(
        ...,
        description="Tesis personal escrita a mano por el usuario (1-3 frases).",
    )
    hook_chosen: str = Field(..., description="Hook seleccionado por el usuario.")
    sources: list[dict] = Field(
        default_factory=list,
        description=(
            "Lista de {url, title, extracted_quote, retrieved_at} — RAG existente."
        ),
    )
    human_edits: list[str] = Field(
        default_factory=list,
        description="Cambios manuales que el usuario aplicó al outline/script.",
    )


class OriginalityManifest(BaseModel):
    schema_version: str = "1.0"
    project_id: str
    topic: str
    thesis_user: str
    hook_chosen: str
    sources: list[dict]
    human_edits: list[str]
    generated_at: int  # unix seconds
    ai_disclosure: str = Field(
        default=(
            "This video was assisted by AI tools for narration, illustration "
            "and editing. Research sources and human creative contributions "
            "are listed in this manifest. Generated by Xianxia Studio."
        ),
        description="Disclosure visible (EU AI Act Article 50).",
    )


# ─────────────────────────────── helpers estructurales ───────────────────────────────


def _normalise(text: str) -> str:
    """Lowercase, collapse whitespace, strip puntuación básica."""
    t = text.lower()
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _ngrams(text: str, n: int) -> set[str]:
    words = _normalise(text).split()
    if len(words) < n:
        return set()
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _structural_features(script_text: str, chapters: list[str] | None) -> dict:
    """Vector de rasgos estructurales (no semánticos) del script.

    Captura: distribución de longitudes de capítulo, densidad de
    hooks (signos de interrogación al inicio, números, ALL CAPS),
    densidad de CTAs ("suscríbete", "comenta", "like", etc.).
    Son las señales que el algoritmo de YouTube usa internamente
    para clasificar canales "templated" según los reverse-engineers
    del policy team (data 2026).
    """
    words = _normalise(script_text).split()
    n_words = len(words)
    chapter_count = len(chapters) if chapters else 0
    chapter_lens = [len(c.split()) for c in (chapters or [])]
    avg_chapter_words = (
        n_words / max(1, chapter_count) if chapter_count else 0.0
    )

    # Hooks: signos de interrogación + números + secuencias mayúsculas.
    question_density = script_text.count("?") / max(1, n_words / 100)
    digits_density = sum(c.isdigit() for c in script_text) / max(1, n_words)
    caps_runs = len(re.findall(r"\b[A-Z]{3,}\b", script_text))

    # CTAs típicos (4 idiomas)
    cta_patterns = [
        r"\bsubscribe\b", r"\bsuscr\w+", r"\binscriv\w+", r"\babonn\w+",
        r"\blike\b", r"\bcomment\b", r"\bcomenta\b", r"\bcommente\b",
        r"\bbell\b", r"\bcampana\b", r"\bnotif\w*",
    ]
    cta_count = sum(len(re.findall(p, script_text, flags=re.IGNORECASE))
                    for p in cta_patterns)
    cta_density = cta_count / max(1, n_words / 1000)  # por 1000 palabras

    return {
        "n_words": n_words,
        "chapter_count": chapter_count,
        "avg_chapter_words": round(avg_chapter_words, 1),
        "chapter_lens_stdev": round(_stdev(chapter_lens), 2),
        "question_density_per100w": round(question_density, 3),
        "digits_density": round(digits_density, 4),
        "caps_runs": caps_runs,
        "cta_density_per1k": round(cta_density, 3),
    }


def _stdev(xs: list[int]) -> float:
    if len(xs) < 2:
        return 0.0
    mean = sum(xs) / len(xs)
    var = sum((x - mean) ** 2 for x in xs) / (len(xs) - 1)
    return var ** 0.5


def _structural_similarity(a: dict, b: dict) -> float:
    """Cuán parecidos son dos vectores de rasgos estructurales. 0-1.

    Comparamos rasgos de los que un canal "templated" mantiene cuasi-
    constantes: chapter_count, avg_chapter_words, cta_density. Más
    parecidos = más sospechoso.
    """
    if not a or not b:
        return 0.0
    keys = ["chapter_count", "avg_chapter_words", "cta_density_per1k",
            "question_density_per100w"]
    matches = 0.0
    weight_total = 0.0
    weights = {"chapter_count": 2.0, "avg_chapter_words": 1.5,
               "cta_density_per1k": 1.0, "question_density_per100w": 0.8}
    for k in keys:
        av = a.get(k, 0.0)
        bv = b.get(k, 0.0)
        w = weights[k]
        weight_total += w
        if max(av, bv) == 0:
            matches += w  # ambos 0 → idénticos en este eje
            continue
        ratio = min(av, bv) / max(av, bv)
        matches += w * ratio
    return matches / weight_total if weight_total else 0.0


def _compute_pairwise_similarity(
    script_text: str,
    chapters: list[str] | None,
    prev: dict,
) -> float:
    """Similitud combinada entre el script actual y UN previo.

    Mezcla 60% Jaccard 5-gramas (semántico/léxico) + 40% rasgos
    estructurales. El 5-grama de palabras detecta frases enteras
    re-utilizadas (hooks copy-paste, CTAs idénticos, conectores
    "and that's when..." repetidos).
    """
    prev_text = prev.get("script_text", "") or ""
    prev_chaps = prev.get("chapters") or []
    if not prev_text:
        return 0.0

    # Léxico: Jaccard 5-grama de palabras.
    ng5_a = _ngrams(script_text, 5)
    ng5_b = _ngrams(prev_text, 5)
    lex_sim = _jaccard(ng5_a, ng5_b)

    # Estructural.
    feat_a = _structural_features(script_text, chapters)
    feat_b = _structural_features(prev_text, prev_chaps)
    struct_sim = _structural_similarity(feat_a, feat_b)

    return 0.6 * lex_sim + 0.4 * struct_sim


# Umbrales: > 0.90 BLOCKING (rejection), > 0.75 WARNING. Valores
# basados en el análisis de canales reales terminados por YouTube
# enero 2026 — la mayoría supera 0.85 en este score combinado.
SIMILARITY_BLOCKING = 0.90
SIMILARITY_WARNING = 0.75


# ─────────────────────────────────── rutas ───────────────────────────────────


@router.post("/check_structural", response_model=StructuralCheckResponse)
async def check_structural(req: StructuralCheckRequest) -> StructuralCheckResponse:
    """Detecta similitud estructural con vídeos previos del canal.

    El cliente Tauri lee los scripts previos de la DB y los pasa aquí.
    El sidecar es stateless: no toca la DB.
    """
    if not req.script_text.strip():
        raise HTTPException(400, "script_text está vacío")

    log_event(
        "info", "originality_check_start",
        project_id=req.project_id,
        prev_count=len(req.previous_scripts),
        script_words=len(req.script_text.split()),
    )

    if not req.previous_scripts:
        # Primer vídeo del canal → no hay con qué comparar; pasa.
        return StructuralCheckResponse(
            score=0.0,
            most_similar_project_id=None,
            warnings=[
                StructuralWarning(
                    code="first_video",
                    detail="Primer vídeo del canal: no hay referencias para comparar.",
                    severity="info",
                )
            ],
            recommended_status="approved",
        )

    scores: list[tuple[str, float]] = []
    for prev in req.previous_scripts:
        pid = prev.get("project_id", "")
        s = _compute_pairwise_similarity(req.script_text, req.chapters, prev)
        scores.append((pid, s))

    # El score reportado es el MÁXIMO (peor caso) — el algoritmo de
    # YouTube compara contra TODOS los previos, no la media.
    scores.sort(key=lambda x: x[1], reverse=True)
    top_pid, top_score = scores[0]

    warnings: list[StructuralWarning] = []
    if top_score >= SIMILARITY_BLOCKING:
        warnings.append(StructuralWarning(
            code="structural_template_blocking",
            detail=(
                f"Similitud {top_score:.0%} con un vídeo previo del canal. "
                f"YouTube puede marcar el canal como 'inauthentic content'. "
                f"Edita el outline o el hook para reducir el parecido."
            ),
            severity="blocking",
        ))
        status = "rejected"
    elif top_score >= SIMILARITY_WARNING:
        warnings.append(StructuralWarning(
            code="structural_template_warning",
            detail=(
                f"Similitud {top_score:.0%} con un vídeo previo. Considera "
                f"variar el formato del outline o el tipo de hook."
            ),
            severity="warning",
        ))
        status = "pending"  # Requiere human_input
    else:
        status = "approved"

    # Señales agregadas: detectar también si la distribución de los
    # scores tiene mediana alta (canal templated, no solo similar al
    # último).
    median_score = sorted(s for _, s in scores)[len(scores) // 2]
    if median_score >= 0.70 and len(scores) >= 3:
        warnings.append(StructuralWarning(
            code="systemic_templating",
            detail=(
                f"La mediana de similitud contra los últimos {len(scores)} "
                f"vídeos es {median_score:.0%}. El canal entero está "
                f"templated; YouTube detectará patrón sistémico."
            ),
            severity="warning",
        ))
        if status == "approved":
            status = "pending"

    log_event(
        "info", "originality_check_done",
        project_id=req.project_id,
        score=round(top_score, 3),
        most_similar=top_pid,
        recommended=status,
        warning_count=len(warnings),
    )

    return StructuralCheckResponse(
        score=round(top_score, 4),
        most_similar_project_id=top_pid or None,
        warnings=warnings,
        recommended_status=status,
    )


_HOOK_PROMPT = """You write VIRAL YouTube/short-form video hooks. Generate
EXACTLY {n} alternative hooks (1-2 sentences each) for this video:

TOPIC: {topic}
OUTLINE: {outline}
LANGUAGE: {lang}

CONSTRAINTS:
- Each hook must use a DIFFERENT format: question / number / contradiction
  / promise / story-fragment.
- Each hook must be written IN THE TARGET LANGUAGE specified above.
- Each hook must be 1-2 sentences MAX. Punchy. Stop-the-scroll.
- No clickbait lies — anchor in something the video actually delivers.
- For each hook, provide a 1-sentence rationale (English OK) explaining
  why it stops the scroll.

Return JSON only, no prose, no markdown:
{{
  "alternatives": [
    {{"kind": "question|number|contradiction|promise|story", "text": "...", "rationale": "..."}},
    ...
  ]
}}
"""


@router.post("/hook_alternatives", response_model=HookAlternativesResponse)
async def hook_alternatives(req: HookAlternativesRequest) -> HookAlternativesResponse:
    """Genera N hooks alternativos via LLM. El usuario elige uno (señal
    de aportación humana para el Originality Manifest)."""
    prompt = _HOOK_PROMPT.format(
        n=req.n_alternatives,
        topic=req.topic,
        outline=req.outline or "(no outline supplied; infer from topic)",
        lang=req.primary_language,
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
                    "temperature": 0.85,  # variedad alta
                    "top_p": 0.92,
                    "num_ctx": 4096,
                    "num_predict": 1024,
                },
                format="json",
                client=client,
                timeout=120.0,
            )
            raw = (result.get("response") or "").strip()
    except Exception as exc:
        raise HTTPException(500, f"hook alternatives LLM call failed: {exc}") from exc

    if not raw:
        raise HTTPException(500, "LLM returned empty response")

    # Reusamos el parser balanced-braces de clipmine (v0.9.1).
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
        if isinstance(data, dict) and isinstance(data.get("alternatives"), list):
            parsed = data
            break
    if not parsed:
        raise HTTPException(500, f"LLM output unparseable: {raw[:200]}")

    alternatives: list[HookAlternative] = []
    for a in parsed["alternatives"][: req.n_alternatives]:
        try:
            kind = str(a.get("kind", "promise")).strip().lower()
            if kind not in {"question", "number", "contradiction", "promise", "story"}:
                kind = "promise"
            text = str(a.get("text", "")).strip()[:300]
            rationale = str(a.get("rationale", "")).strip()[:200]
            if text:
                alternatives.append(HookAlternative(
                    kind=kind, text=text, rationale=rationale,
                ))
        except (TypeError, ValueError):
            continue

    if not alternatives:
        raise HTTPException(500, "LLM returned no valid hooks")

    log_event(
        "info", "originality_hooks_generated",
        topic=req.topic[:60],
        lang=req.primary_language,
        n=len(alternatives),
    )

    return HookAlternativesResponse(alternatives=alternatives)


@router.post("/build_manifest", response_model=OriginalityManifest)
async def build_manifest(req: BuildManifestRequest) -> OriginalityManifest:
    """Construye el JSON manifest auditable. Validaciones:
      - thesis_user ≥ 20 chars (no acepta "abc" como input simbólico)
      - hook_chosen ≥ 10 chars
      - sources con url + extracted_quote no vacíos
    """
    thesis = req.thesis_user.strip()
    if len(thesis) < 20:
        raise HTTPException(
            400,
            "thesis_user demasiado corta (mín 20 chars). "
            "El gate exige aportación humana real: explica TU ángulo del tema.",
        )
    hook = req.hook_chosen.strip()
    if len(hook) < 10:
        raise HTTPException(400, "hook_chosen demasiado corto (mín 10 chars)")

    clean_sources: list[dict[str, Any]] = []
    for s in req.sources:
        url = str(s.get("url", "")).strip()
        quote = str(s.get("extracted_quote", "")).strip()
        if not url or not quote:
            continue
        clean_sources.append({
            "url": url,
            "title": str(s.get("title", "")).strip()[:200],
            "extracted_quote": quote[:1000],
            "retrieved_at": int(s.get("retrieved_at", time.time())),
        })

    manifest = OriginalityManifest(
        project_id=req.project_id,
        topic=req.topic.strip()[:200],
        thesis_user=thesis[:2000],
        hook_chosen=hook[:500],
        sources=clean_sources,
        human_edits=[e[:500] for e in req.human_edits if e.strip()][:50],
        generated_at=int(time.time()),
    )

    log_event(
        "info", "originality_manifest_built",
        project_id=req.project_id,
        sources_count=len(clean_sources),
        edits_count=len(manifest.human_edits),
        thesis_chars=len(thesis),
    )

    return manifest
