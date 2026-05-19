# Capítulos Largos Robustos (v0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir el multi-pass ciego de guion largo por un flujo outline → capítulo-a-capítulo con memoria estructurada, estado persistido, resume granular, crossfade TTS y UI de capítulos+ETA, sin romper el camino corto ni los contratos de marcadores.

**Architecture:** Para `target_minutes ≥ 7` el guion se genera con un planner LLM (`/script/outline`) y luego capítulo a capítulo (`/script/chapter`) con un `running_summary` estructurado. El estado vive en `script_outline`/`chapter_state` (migración 0003) y el pipeline reanuda desde `pipeline_steps`. El guion ensamblado conserva los marcadores `[CHAPTER:]/[IMAGE:]/[MUSIC:]` → todo aguas abajo intacto. Vídeos < 7 min usan el camino v0.1.38 sin cambios.

**Tech Stack:** Tauri 2 + Rust (sqlx, `pipeline/mod.rs`, `db/`), Python sidecar (FastAPI `routes/script.py`, `routes/tts.py`, `llm.py`, `prompts.py`), React 19 + Zustand (`pipelineStore.ts`, `generator.tsx`), ffmpeg `acrossfade`.

**Restricciones duras:** GPU-only (crossfade es ffmpeg/CPU, permitido); 100% local; cero mock/datos demo; `wake_llm` antes de fases LLM; verificar `acrossfade` vía context7; migración 0003 nueva sin tocar 0001/0002; degradación graceful en cada pieza (nunca romper una generación que hoy funciona).

---

## File Structure

**Create:**
- `apps/desktop/src-tauri/migrations/0003_chapters_resume.sql` — tablas `script_outline`, `chapter_state` (auto-aplicada por `sqlx::migrate!("./migrations")`).
- `apps/desktop/src-tauri/src/db/chapters.rs` — acceso DB (espejo de `db/scheduled.rs`).
- `apps/sidecar-py/src/xianxia_ai/chapters.py` — lógica pura: parse/validación outline, ensamblado, running_summary helpers (testeable sin red).
- `apps/desktop/src/components/chapter-preview.tsx` — componente UI de capítulos+ETA.
- `apps/sidecar-py/tests/test_chapters.py` — tests unitarios Python.

**Modify:**
- `apps/sidecar-py/src/xianxia_ai/prompts.py` — `OUTLINE_PROMPT_TEMPLATE`, `CHAPTER_PROMPT_TEMPLATE`, `SUMMARY_PROMPT_TEMPLATE`.
- `apps/sidecar-py/src/xianxia_ai/routes/script.py` — endpoints `/outline`, `/chapter`; orquestación long-form.
- `apps/sidecar-py/src/xianxia_ai/routes/tts.py` — crossfade en concat de chunks.
- `apps/desktop/src-tauri/src/db/mod.rs` — `pub mod chapters;`.
- `apps/desktop/src-tauri/src/pipeline/mod.rs` — fase guion long-form (outline+capítulos), persist `chapter_state`, resume desde `pipeline_steps`, timeline desde duración medida.
- `apps/desktop/src-tauri/src/commands.rs` + `lib.rs` — comando `reset_project_progress`.
- `apps/desktop/src/lib/pipelineStore.ts` — estado `chapters` + `eta`.
- `apps/desktop/src/lib/tauri.ts` + `events.ts` — binding reset + evento capítulo.
- `apps/desktop/src/routes/generator.tsx` — montar `<ChapterPreview/>`.
- `scripts/parity-check.mjs` — invariantes nuevos.
- `CHANGELOG.md`, `package.json`×2, `tauri.conf.json`, `Cargo.toml` — versión 0.5.0.

---

## Phase 0 · Preparación

### Task 0: Rama de trabajo y baseline verde

**Files:** ninguno (git + verificación).

- [ ] **Step 1: Confirmar baseline limpio**

Run: `git -C "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" status --porcelain | wc -l`
Expected: `0`

- [ ] **Step 2: Crear rama de feature**

```bash
git checkout -b feat/v0.5.0-capitulos-largos
```

- [ ] **Step 3: Baseline de tests Rust verde**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -3`
Expected: `test result: ok. 11 passed`

---

## Phase 1 · Fundación: schema DB + acceso Rust (aditivo, testeable solo)

### Task 1: Migración 0003

**Files:**
- Create: `apps/desktop/src-tauri/migrations/0003_chapters_resume.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- v0.5.0 — long-form chapters: outline + per-chapter resumable state.
-- NEW migration; never edit 0001/0002 (sqlx records their hash).
CREATE TABLE IF NOT EXISTS script_outline (
    project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    outline_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_state (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_index  INTEGER NOT NULL,
    title          TEXT NOT NULL,
    status         TEXT NOT NULL,            -- pending|writing|done|failed
    narration_path TEXT,
    summary_text   TEXT,
    words          INTEGER,
    error_message  TEXT,
    updated_at     INTEGER NOT NULL,
    UNIQUE(project_id, chapter_index)
);

CREATE INDEX IF NOT EXISTS idx_chapter_state_project
    ON chapter_state(project_id, chapter_index);
```

- [ ] **Step 2: Verificar que sqlx la aplica sin romper 0001/0002**

Run: `cd apps/desktop/src-tauri && cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok.` (la suite abre un pool en memoria y corre `migrate!`; si 0003 tuviera SQL inválido, fallaría aquí).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/migrations/0003_chapters_resume.sql
git commit -m "feat(db): migración 0003 script_outline + chapter_state"
```

### Task 2: Módulo `db/chapters.rs` (espejo de `db/scheduled.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/db/chapters.rs`
- Modify: `apps/desktop/src-tauri/src/db/mod.rs` (añadir `pub mod chapters;`)

- [ ] **Step 1: Escribir el test unitario**

Añadir al final de `apps/desktop/src-tauri/src/db/chapters.rs` (se crea con el módulo en Step 3; este step define el test que se incluirá):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn outline_roundtrip_and_chapter_upsert() {
        let pool = crate::db::init_memory_pool().await.unwrap();
        sqlx::query("INSERT INTO projects (id,title,topic,status,languages,created_at,updated_at) VALUES ('p1','T','t','queued','es',0,0)")
            .execute(&pool).await.unwrap();

        save_outline(&pool, "p1", r#"{"chapters":[]}"#).await.unwrap();
        assert_eq!(get_outline(&pool, "p1").await.unwrap().as_deref(), Some(r#"{"chapters":[]}"#));

        upsert_chapter(&pool, &NewChapter {
            project_id: "p1".into(), chapter_index: 0, title: "Uno".into(),
            status: "done".into(), narration_path: Some("/c0.txt".into()),
            summary_text: Some("s".into()), words: Some(120), error_message: None,
        }).await.unwrap();
        // upsert again (same index) must update, not duplicate
        upsert_chapter(&pool, &NewChapter {
            project_id: "p1".into(), chapter_index: 0, title: "Uno".into(),
            status: "failed".into(), narration_path: None,
            summary_text: None, words: None, error_message: Some("boom".into()),
        }).await.unwrap();

        let rows = list_chapters(&pool, "p1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "failed");

        reset_project(&pool, "p1").await.unwrap();
        assert!(get_outline(&pool, "p1").await.unwrap().is_none());
        assert!(list_chapters(&pool, "p1").await.unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Ejecutar el test (debe fallar a compilar)**

Run: `cd apps/desktop/src-tauri && cargo test --lib chapters 2>&1 | tail -5`
Expected: FAIL — `module 'chapters' not found` / símbolos sin definir.

- [ ] **Step 3: Escribir el módulo completo**

`apps/desktop/src-tauri/src/db/chapters.rs` (encabezado + impl; el bloque `#[cfg(test)]` del Step 1 va al final del mismo fichero):

```rust
//! `script_outline` + `chapter_state` access — long-form resumable
//! chapter generation. Mirrors db/scheduled.rs (sqlx::query, FromRow).
//! SQL identifiers verified by hand against migrations/0003_chapters_resume.sql.
use anyhow::Result;
use serde::Serialize;
use sqlx::FromRow;
use ulid::Ulid;

use super::{now_unix, DbPool};

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ChapterRow {
    pub id: String,
    pub project_id: String,
    pub chapter_index: i64,
    pub title: String,
    pub status: String,
    pub narration_path: Option<String>,
    pub summary_text: Option<String>,
    pub words: Option<i64>,
    pub error_message: Option<String>,
}

pub struct NewChapter {
    pub project_id: String,
    pub chapter_index: i64,
    pub title: String,
    pub status: String,
    pub narration_path: Option<String>,
    pub summary_text: Option<String>,
    pub words: Option<i64>,
    pub error_message: Option<String>,
}

pub async fn save_outline(pool: &DbPool, project_id: &str, outline_json: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO script_outline (project_id, outline_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
            outline_json = excluded.outline_json,
            created_at   = excluded.created_at",
    )
    .bind(project_id)
    .bind(outline_json)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_outline(pool: &DbPool, project_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT outline_json FROM script_outline WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.0))
}

pub async fn upsert_chapter(pool: &DbPool, c: &NewChapter) -> Result<()> {
    sqlx::query(
        "INSERT INTO chapter_state
           (id, project_id, chapter_index, title, status, narration_path,
            summary_text, words, error_message, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, chapter_index) DO UPDATE SET
            title          = excluded.title,
            status         = excluded.status,
            narration_path = excluded.narration_path,
            summary_text   = excluded.summary_text,
            words          = excluded.words,
            error_message  = excluded.error_message,
            updated_at     = excluded.updated_at",
    )
    .bind(Ulid::new().to_string())
    .bind(&c.project_id)
    .bind(c.chapter_index)
    .bind(&c.title)
    .bind(&c.status)
    .bind(&c.narration_path)
    .bind(&c.summary_text)
    .bind(c.words)
    .bind(&c.error_message)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_chapters(pool: &DbPool, project_id: &str) -> Result<Vec<ChapterRow>> {
    let rows = sqlx::query_as::<_, ChapterRow>(
        "SELECT id, project_id, chapter_index, title, status, narration_path,
                summary_text, words, error_message
           FROM chapter_state
          WHERE project_id = ?
          ORDER BY chapter_index ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Wipe outline + chapters for a project ("regenerar desde cero").
pub async fn reset_project(pool: &DbPool, project_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM chapter_state WHERE project_id = ?")
        .bind(project_id).execute(pool).await?;
    sqlx::query("DELETE FROM script_outline WHERE project_id = ?")
        .bind(project_id).execute(pool).await?;
    Ok(())
}
```

Y añadir en `apps/desktop/src-tauri/src/db/mod.rs`, junto a la línea `pub mod scheduled;`:

```rust
pub mod chapters;
```

- [ ] **Step 4: Ejecutar el test (debe pasar)**

Run: `cd apps/desktop/src-tauri && cargo test --lib chapters 2>&1 | tail -5`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/db/chapters.rs apps/desktop/src-tauri/src/db/mod.rs
git commit -m "feat(db): db/chapters.rs (outline + chapter_state CRUD)"
```

### Task 3: Comando `reset_project_progress`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (añadir comando)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (registrar en `generate_handler!`)
- Modify: `apps/desktop/src/lib/tauri.ts` (binding)

- [ ] **Step 1: Añadir el comando en `commands.rs`**

Junto a `cancel_scheduled` (que ya usa `db::scheduled`), añadir:

```rust
#[tauri::command]
pub async fn reset_project_progress(
    pool: tauri::State<'_, std::sync::Arc<crate::db::DbPool>>,
    project_id: String,
) -> Result<(), String> {
    let p = pool.inner().clone();
    crate::db::chapters::reset_project(&p, &project_id)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM pipeline_steps WHERE project_id = ?")
        .bind(&project_id)
        .execute(&*p)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Registrar en `lib.rs`**

En el `tauri::generate_handler![ ... ]`, junto a `commands::cancel_scheduled,` añadir:

```rust
            commands::reset_project_progress,
```

- [ ] **Step 3: Binding en `tauri.ts`**

Junto a `cancelScheduled`:

```typescript
  resetProjectProgress: (projectId: string) =>
    invoke<void>('reset_project_progress', { projectId }),
```

- [ ] **Step 4: cargo check**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -2`
Expected: `Finished`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/tauri.ts
git commit -m "feat: comando reset_project_progress (regenerar desde cero)"
```

---

## Phase 2 · Planner + outline (Python, lógica pura testeable)

### Task 4: Lógica pura de outline en `chapters.py`

**Files:**
- Create: `apps/sidecar-py/src/xianxia_ai/chapters.py`
- Create: `apps/sidecar-py/tests/test_chapters.py`

- [ ] **Step 1: Escribir el test**

`apps/sidecar-py/tests/test_chapters.py`:

```python
from xianxia_ai.chapters import (
    parse_outline, chapter_count_for, assemble_script,
)


def test_chapter_count_rule():
    assert chapter_count_for(6) == 3      # min 3
    assert chapter_count_for(14) == 6     # capped at 6
    assert 3 <= chapter_count_for(10) <= 6


def test_parse_outline_ok():
    raw = '{"chapters":[{"index":1,"title":"El Hallazgo",' \
          '"synopsis":"x","target_words":300,"beats":["a"]}]}'
    out = parse_outline(raw)
    assert out[0]["title"] == "El Hallazgo"
    assert out[0]["index"] == 1


def test_parse_outline_strips_codefence():
    raw = '```json\n{"chapters":[{"index":1,"title":"T",' \
          '"synopsis":"s","target_words":100,"beats":[]}]}\n```'
    assert parse_outline(raw)[0]["title"] == "T"


def test_parse_outline_invalid_raises():
    import pytest
    with pytest.raises(ValueError):
        parse_outline("not json at all")
    with pytest.raises(ValueError):
        parse_outline('{"chapters":[]}')   # empty = invalid


def test_assemble_script_preserves_markers():
    chapters = [
        "[CHAPTER: Uno]\nHola. [IMAGE: a] Mundo.",
        "[CHAPTER: Dos]\nMas texto. [MUSIC: mood=epic]",
    ]
    s = assemble_script(chapters)
    assert s.count("[CHAPTER:") == 2
    assert "[IMAGE: a]" in s and "[MUSIC: mood=epic]" in s
    assert "\n\n" in s   # separator so parse_markers won't merge sentences
```

- [ ] **Step 2: Ejecutar el test (debe fallar)**

Run: `cd apps/sidecar-py && python -m pytest tests/test_chapters.py -q 2>&1 | tail -5`
Expected: FAIL — `ModuleNotFoundError: xianxia_ai.chapters`

- [ ] **Step 3: Escribir `chapters.py`**

```python
"""Pure helpers for long-form chapter generation (no network, no LLM).

Kept import-free of FastAPI/httpx so it is unit-testable in isolation,
mirroring how effects/seo logic is split from the routers.
"""
from __future__ import annotations

import json
import re


def chapter_count_for(minutes: int) -> int:
    """Same rule as the legacy [CHAPTER:] marker guidance: ~minutes/2,
    clamped to [3, 6]."""
    return max(3, min(6, round(minutes / 2)))


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse_outline(raw: str) -> list[dict]:
    """Parse the planner LLM output into a validated chapter list.

    Raises ValueError on anything we cannot trust (no JSON, no chapters,
    missing keys) so the caller can fall back to the v0.1.38 multi-pass.
    """
    text = _FENCE.sub("", raw.strip())
    # Tolerate leading prose before the JSON object.
    brace = text.find("{")
    if brace > 0:
        text = text[brace:]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"outline is not valid JSON: {e}") from e
    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise ValueError("outline has no chapters")
    out: list[dict] = []
    for i, ch in enumerate(chapters):
        if not isinstance(ch, dict) or not ch.get("title"):
            raise ValueError(f"chapter {i} missing title")
        out.append({
            "index": int(ch.get("index", i + 1)),
            "title": str(ch["title"]).strip(),
            "synopsis": str(ch.get("synopsis", "")).strip(),
            "target_words": int(ch.get("target_words", 0)) or 0,
            "beats": [str(b) for b in ch.get("beats", []) if str(b).strip()],
        })
    return out


def assemble_script(chapter_texts: list[str]) -> str:
    """Join chapters with the same blank-line separator the legacy
    multi-pass used, so parse_markers() never merges sentences across a
    chapter boundary."""
    return "\n\n".join(t.strip() for t in chapter_texts if t.strip())
```

- [ ] **Step 4: Ejecutar el test (debe pasar)**

Run: `cd apps/sidecar-py && python -m pytest tests/test_chapters.py -q 2>&1 | tail -5`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/chapters.py apps/sidecar-py/tests/test_chapters.py
git commit -m "feat(py): chapters.py — outline parse/validate + assemble (pure)"
```

### Task 5: Prompts de outline / capítulo / summary

**Files:**
- Modify: `apps/sidecar-py/src/xianxia_ai/prompts.py` (añadir 3 constantes al final)

- [ ] **Step 1: Añadir las constantes**

Al final de `prompts.py` (usan los placeholders `{topic} {minutes} {language_name} {context_facts} {n_chapters} {outline_block} {chapter_index} {chapter_title} {chapter_synopsis} {chapter_beats} {target_words} {running_summary}`):

```python
OUTLINE_PROMPT_TEMPLATE = """You are the story architect for a {minutes}-minute long-form documentary narration about: {topic}.

{context_facts}

Design a chapter outline of EXACTLY {n_chapters} chapters that STAGES the topic like a mystery (hook → setup → escalation → reveal → resolution), NOT a flat list. Each chapter must move the narrative forward and not overlap the others.

Return ONLY a JSON object, no prose, no code fence:
{{"chapters":[{{"index":1,"title":"<2-4 evocative words in {language_name}, NOT 'Chapter 1'>","synopsis":"<2-3 sentences, what this chapter covers>","target_words":<int ~ {minutes}*150/{n_chapters}>,"beats":["<concrete beat>","<concrete beat>"]}}]}}"""

CHAPTER_PROMPT_TEMPLATE = """You are narrating chapter {chapter_index} of a long-form documentary in {language_name} about: {topic}.

FULL OUTLINE (for global coherence — do NOT re-tell other chapters):
{outline_block}

WHAT HAS ALREADY BEEN NARRATED (running summary — continue from here, never repeat it):
{running_summary}

Write ONLY chapter {chapter_index} — "{chapter_title}".
Synopsis: {chapter_synopsis}
Beats to hit, in order: {chapter_beats}
Length: about {target_words} words.

Rules:
- Open the chapter with the marker [CHAPTER: {chapter_title}] on its own line.
- Insert [IMAGE: english visual description] every 25-40 words, matching the LITERAL narrated content.
- Insert [MUSIC: mood=epic|serene|mystic|emotional|tense|melancholic|reveal] at mood shifts.
- Narration prose in {language_name}; marker bodies in English.
- Stay strictly on topic. Do NOT summarise other chapters. Do NOT write a closing/CTA unless told this is the final chapter.
{final_clause}"""

SUMMARY_PROMPT_TEMPLATE = """Summarise the documentary narration so far so the next chapter can continue coherently WITHOUT repeating anything.

NARRATION SO FAR (chapters 1..{chapter_index}):
{running_summary}

NEW CHAPTER JUST WRITTEN:
{new_chapter}

Return ONLY a JSON object, no prose:
{{"told":"<=120 words, the storyline covered so far>","open_threads":["<unresolved hook/question>"],"used_facts":["<specific fact/name/date already used>"],"last_paragraph":"<verbatim last paragraph of the new chapter, for voice continuity>"}}"""
```

- [ ] **Step 2: Verificar import sano**

Run: `cd apps/sidecar-py && python -c "from xianxia_ai.prompts import OUTLINE_PROMPT_TEMPLATE, CHAPTER_PROMPT_TEMPLATE, SUMMARY_PROMPT_TEMPLATE; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/prompts.py
git commit -m "feat(py): prompts outline/chapter/summary para long-form"
```

---

## Phase 3 · Endpoints `/script/outline` y `/script/chapter`

### Task 6: Endpoint `/script/outline`

**Files:**
- Modify: `apps/sidecar-py/src/xianxia_ai/routes/script.py`

- [ ] **Step 1: Añadir modelos + endpoint**

Tras la definición de `ScriptResponse` (línea ~75, antes de `@router.post("", ...)`), añadir. Reusa el `context_facts` que `generate_script` ya construye desde RAG; aquí lo aceptamos como input opcional ya resuelto por el orquestador Rust o se reconstruye igual que en `generate_script` (misma función auxiliar — NO duplicar: extraer la construcción de `context_facts` a un helper `_build_context_facts(req)` si aún es inline, y llamarlo desde ambos):

```python
from ..prompts import OUTLINE_PROMPT_TEMPLATE, CHAPTER_PROMPT_TEMPLATE, SUMMARY_PROMPT_TEMPLATE
from ..chapters import parse_outline, chapter_count_for


class OutlineRequest(BaseModel):
    topic: str
    target_minutes: int
    language: str = "es"
    context_facts: str = ""


class OutlineResponse(BaseModel):
    chapters: list[dict]


@router.post("/outline", response_model=OutlineResponse)
async def generate_outline(req: OutlineRequest) -> OutlineResponse:
    language_name = _language_name(req.language)  # reuse existing helper
    n = chapter_count_for(req.target_minutes)
    prompt = OUTLINE_PROMPT_TEMPLATE.format(
        topic=req.topic, minutes=req.target_minutes,
        language_name=language_name, n_chapters=n,
        context_facts=req.context_facts or "(write from general knowledge, stay faithful to the topic)",
    )
    log_event("info", "outline_start", topic=req.topic[:60], chapters=n)
    async with httpx.AsyncClient(timeout=900.0) as client:
        for attempt in (1, 2):
            try:
                result = await llm_generate(
                    model=None, system=None, prompt=prompt,
                    options={"temperature": 0.4, "top_p": 0.9,
                             "num_ctx": 8192, "num_predict": 1800},
                    think=False, max_continuations=0, client=client, timeout=900.0,
                )
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
            try:
                chapters = parse_outline(result.get("response") or "")
                log_event("info", "outline_ok", chapters=len(chapters), attempt=attempt)
                return OutlineResponse(chapters=chapters)
            except ValueError as e:
                log_event("warn", "outline_parse_failed", attempt=attempt, error=str(e)[:160])
        raise HTTPException(status_code=422, detail="outline could not be parsed after 2 attempts")
```

> NOTE: si `_language_name` / `model=None` no son las firmas reales en `script.py`/`llm.py`, ajustar a las existentes (verificar leyendo `generate_script` líneas 76-190 y la firma de `llm_generate` en `llm.py`). El contrato no cambia; solo se reusa lo que ya hay.

- [ ] **Step 2: Probar el endpoint con el sidecar bundled (capa 2)**

Run (sidecar arrancado en :8731): `curl -s -X POST localhost:8731/script/outline -H "Content-Type: application/json" -d "{\"topic\":\"la batalla de las Termópilas\",\"target_minutes\":10,\"language\":\"es\"}" | python -m json.tool | head -20`
Expected: JSON con `chapters` (3-6 items, títulos en español, no "Chapter 1").

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/routes/script.py
git commit -m "feat(py): endpoint /script/outline (planner LLM)"
```

### Task 7: Endpoint `/script/chapter` + running summary

**Files:**
- Modify: `apps/sidecar-py/src/xianxia_ai/routes/script.py`

- [ ] **Step 1: Añadir modelos + endpoint**

```python
class ChapterRequest(BaseModel):
    topic: str
    language: str = "es"
    outline: list[dict]
    chapter_index: int          # 1-based
    running_summary: str = ""   # serialized JSON or "" for the first chapter
    is_final: bool = False


class ChapterResponse(BaseModel):
    text: str
    running_summary: str        # updated summary for the NEXT chapter
    words: int


def _outline_block(outline: list[dict]) -> str:
    return "\n".join(
        f'{c["index"]}. {c["title"]} — {c.get("synopsis","")}' for c in outline
    )


@router.post("/chapter", response_model=ChapterResponse)
async def generate_chapter(req: ChapterRequest) -> ChapterResponse:
    language_name = _language_name(req.language)
    ch = next((c for c in req.outline if c["index"] == req.chapter_index), None)
    if ch is None:
        raise HTTPException(status_code=422, detail="chapter_index not in outline")
    final_clause = (
        "This IS the final chapter: after the beats, deliver a narrative "
        f"resolution that echoes the opening, then a short {language_name} "
        "audience CTA (like, share, subscribe, thanks)."
        if req.is_final else
        "This is NOT the final chapter: keep building, do not close."
    )
    prompt = CHAPTER_PROMPT_TEMPLATE.format(
        topic=req.topic, language_name=language_name,
        outline_block=_outline_block(req.outline),
        running_summary=req.running_summary or "(this is the first chapter)",
        chapter_index=req.chapter_index, chapter_title=ch["title"],
        chapter_synopsis=ch.get("synopsis", ""),
        chapter_beats="; ".join(ch.get("beats", [])) or "(use your judgement)",
        target_words=ch.get("target_words", 0) or 350,
        final_clause=final_clause,
    )
    async with httpx.AsyncClient(timeout=900.0) as client:
        try:
            result = await llm_generate(
                model=None, system=None, prompt=prompt,
                options={"temperature": 0.85, "top_p": 0.92,
                         "num_ctx": 16384, "num_predict": 4096},
                think=False, max_continuations=0, client=client, timeout=900.0,
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"LLM error: {e}") from e
        chapter_text = (result.get("response") or "").strip()
        if f"[CHAPTER:" not in chapter_text:
            chapter_text = f'[CHAPTER: {ch["title"]}]\n' + chapter_text

        summary_prompt = SUMMARY_PROMPT_TEMPLATE.format(
            chapter_index=req.chapter_index,
            running_summary=req.running_summary or "(nothing yet)",
            new_chapter=chapter_text[-4000:],
        )
        try:
            s = await llm_generate(
                model=None, system=None, prompt=summary_prompt,
                options={"temperature": 0.3, "num_ctx": 8192, "num_predict": 700},
                think=False, max_continuations=0, client=client, timeout=900.0,
            )
            new_summary = (s.get("response") or "").strip()
        except httpx.HTTPError:
            new_summary = req.running_summary  # graceful: keep previous
    return ChapterResponse(
        text=chapter_text,
        running_summary=new_summary or req.running_summary,
        words=len(chapter_text.split()),
    )
```

- [ ] **Step 2: Probar continuidad (capa 2, sidecar real)**

Run: generar outline (Task 6 Step 2), tomar su `chapters`, llamar `/script/chapter` con `chapter_index:1` y luego `chapter_index:2` pasando el `running_summary` devuelto; verificar que el capítulo 2 NO repite el 1 y que `[CHAPTER:` aparece. (Comando curl con el JSON del outline; inspección manual del texto.)
Expected: capítulo 2 continúa, no repite; `running_summary` es JSON con `told/open_threads/used_facts/last_paragraph`.

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/routes/script.py
git commit -m "feat(py): endpoint /script/chapter + running summary continuation"
```

---

## Phase 4 · Orquestación Rust: long-form por capítulos + resume

### Task 8: Auditar la fase guion y la timeline actual

**Files:** ninguno (lectura — produce notas para Task 9/12).

- [ ] **Step 1: Localizar la llamada a `/script` y el uso de `output_json`**

Run: `cd apps/desktop/src-tauri && grep -n "\"/script\"\|script request\|persist_step(pool, pid, 1\|normalise_beat_timeline\|fn normalise_beat_timeline\|audio.*duration\|measured" src/pipeline/mod.rs | head -20`
Expected: ubica (a) dónde se hace la request de fase 1, (b) `persist_step(...,1,...)`, (c) `normalise_beat_timeline` y de dónde saca la duración (medida vs estimada). Anotar números de línea para Task 9 y Task 12.

- [ ] **Step 2: Confirmar firma de `start_generation` y reentrada**

Run: `grep -n "pub async fn start_generation\|run_pipeline\|async fn run(" src/pipeline/mod.rs src/commands.rs | head`
Expected: punto de entrada del pipeline (para insertar el chequeo de resume en Task 10).

### Task 9: Fase guion long-form en el pipeline

**Files:**
- Modify: `apps/desktop/src-tauri/src/pipeline/mod.rs` (rama fase 1)

- [ ] **Step 1: Implementar la bifurcación long-form**

En la fase 1 (donde hoy llama a `/script`), envolver: si `req.target_minutes >= 7`, ejecutar el flujo nuevo; si no, el actual sin cambios. Pseudocódigo concreto a insertar (adaptar nombres reales de `client`, `pid`, `pool`, helper HTTP existente):

```rust
// v0.5.0 — long-form via outline + per-chapter. Short stays on the
// legacy single-call /script path (unchanged).
let script_text: String = if req.target_minutes >= 7 {
    wake_llm(&client).await; // project rule
    // 1. outline (reuse persisted one if resuming)
    let outline_json = match crate::db::chapters::get_outline(pool, pid).await {
        Ok(Some(j)) => j,
        _ => {
            let body = serde_json::json!({
                "topic": req.topic, "target_minutes": req.target_minutes,
                "language": req.script_language, "context_facts": ""
            });
            let resp = client.post("http://127.0.0.1:8731/script/outline")
                .json(&body).send().await
                .context("phase 1: outline request failed")?;
            let v: serde_json::Value = resp.json().await?;
            let j = serde_json::to_string(&v)?;
            let _ = crate::db::chapters::save_outline(pool, pid, &j).await;
            j
        }
    };
    let parsed: serde_json::Value = serde_json::from_str(&outline_json)?;
    let chapters = parsed.get("chapters").and_then(|c| c.as_array())
        .cloned().unwrap_or_default();
    // 2. per-chapter loop with resume + running summary
    let done = crate::db::chapters::list_chapters(pool, pid).await.unwrap_or_default();
    let mut running = String::new();
    let mut parts: Vec<String> = Vec::new();
    for (i, ch) in chapters.iter().enumerate() {
        let idx = (i + 1) as i64;
        if let Some(d) = done.iter().find(|d| d.chapter_index == idx && d.status == "done") {
            if let Some(p) = &d.narration_path {
                if let Ok(t) = std::fs::read_to_string(p) {
                    parts.push(t);
                    running = d.summary_text.clone().unwrap_or_default();
                    emit(app, pid, 1, "running",
                         (idx as f64) / (chapters.len() as f64) * 50.0,
                         &format!("Capítulo {} reanudado", idx));
                    continue;
                }
            }
        }
        emit(app, pid, 1, "running",
             (idx as f64) / (chapters.len() as f64) * 50.0,
             &format!("Escribiendo capítulo {}/{}", idx, chapters.len()));
        let body = serde_json::json!({
            "topic": req.topic, "language": req.script_language,
            "outline": chapters, "chapter_index": idx,
            "running_summary": running,
            "is_final": idx as usize == chapters.len()
        });
        let resp = client.post("http://127.0.0.1:8731/script/chapter")
            .json(&body).send().await
            .context("phase 1: chapter request failed")?;
        let cv: serde_json::Value = resp.json().await?;
        let text = cv.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
        running = cv.get("running_summary").and_then(|s| s.as_str())
            .unwrap_or("").to_string();
        // persist chapter narration to project dir for resume
        let cpath = project_dir(pid).join(format!("chapter-{:02}.txt", idx));
        let _ = std::fs::write(&cpath, &text);
        let _ = crate::db::chapters::upsert_chapter(pool, &crate::db::chapters::NewChapter {
            project_id: pid.to_string(), chapter_index: idx,
            title: ch.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            status: "done".into(),
            narration_path: Some(cpath.to_string_lossy().to_string()),
            summary_text: Some(running.clone()),
            words: Some(text.split_whitespace().count() as i64),
            error_message: None,
        }).await;
        parts.push(text);
    }
    parts.join("\n\n")
} else {
    /* === camino actual sin cambios: la llamada a /script de hoy === */
    legacy_single_call_script(/* args actuales */).await?
};
```

> El bloque legacy se conserva tal cual está hoy, solo movido al `else`. `project_dir(pid)` es el helper ya usado por el pipeline para la carpeta del proyecto (verificar nombre real en Task 8).

- [ ] **Step 2: cargo check**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -2`
Expected: `Finished`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/pipeline/mod.rs
git commit -m "feat(pipeline): fase guion long-form (outline + capítulos + resume)"
```

### Task 10: Resume del pipeline desde `pipeline_steps`

**Files:**
- Modify: `apps/desktop/src-tauri/src/pipeline/mod.rs` (entrada del pipeline + cada fase tardía)

- [ ] **Step 1: Helper de skip por fase**

Añadir junto a `persist_step`:

```rust
/// True if this phase already completed in a prior run AND its recorded
/// artifact still exists on disk → safe to skip (resume).
async fn phase_already_done(pool: &DbPool, pid: &str, phase: u8) -> Option<serde_json::Value> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT status, output_json FROM pipeline_steps
          WHERE project_id = ? AND phase = ?",
    ).bind(pid).bind(phase as i64).fetch_optional(pool).await.ok()?;
    let (status, oj) = row?;
    if status != "done" { return None; }
    let v: serde_json::Value = serde_json::from_str(&oj?).ok()?;
    // each phase records its artifact path under "path"/"video_id"/etc;
    // if a filesystem path is present it must still exist.
    if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
        if !std::path::Path::new(p).exists() { return None; }
    }
    Some(v)
}
```

- [ ] **Step 2: Aplicar skip en las fases caras y reanudables**

Al inicio de las fases TTS, render narrativo y upload (las que producen artefacto con path en `output_json`), anteponer:

```rust
if let Some(out) = phase_already_done(pool, pid, PHASE_N).await {
    emit(app, pid, PHASE_N, "done", 100.0, "Reanudado (ya completado)");
    /* reusar paths de `out` en lugar de recomputar */
} else {
    /* trabajo normal de la fase + persist_step(..., "done", {"path": ...}) */
}
```

Asegurar que cada una de esas fases YA escribe su path en `persist_step(..., output_json)`; las que no lo hagan, añadir el `"path"` al JSON (cambio aditivo, no altera comportamiento).

- [ ] **Step 3: cargo test**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -3`
Expected: `test result: ok.` (≥ 12 passed; los nuevos de chapters incluidos)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/pipeline/mod.rs
git commit -m "feat(pipeline): resume granular saltando fases done con artefacto"
```

---

## Phase 5 · Crossfade TTS sin desincronizar la timeline

### Task 11: Verificar sintaxis `acrossfade` (regla verificar-upstream)

**Files:** ninguno (investigación).

- [ ] **Step 1: Consultar context7**

Usar la skill/herramienta context7: resolve-library-id "ffmpeg" → query-docs "acrossfade filter syntax curve nb_samples duration concatenating wav segments". Anotar la sintaxis exacta del filtro `acrossfade` (parámetros `d`, `c1`, `c2`) y si requiere `aresample`/timestamps.
Expected: nota con el comando ffmpeg correcto para encadenar N WAV con crossfade de 80 ms equal-power (`acrossfade=d=0.08:c1=tri:c2=tri` encadenado, o vía `concat` + `acrossfade` por pares).

### Task 12: Crossfade en el concat de chunks

**Files:**
- Modify: `apps/sidecar-py/src/xianxia_ai/routes/tts.py` (punto de concat de WAVs)
- Create/extend test: `apps/sidecar-py/tests/test_chapters.py` (caso duración)

- [ ] **Step 1: Test de invariante de duración**

Añadir a `tests/test_chapters.py` una función pura `expected_crossfade_duration(durations, xfade)` en `chapters.py` y su test:

```python
# en chapters.py
def expected_crossfade_duration(seg_seconds: list[float], xfade: float) -> float:
    """Total duration after chaining N segments with `xfade` s crossfade
    on each of the N-1 joins."""
    if not seg_seconds:
        return 0.0
    return sum(seg_seconds) - xfade * (len(seg_seconds) - 1)

# en test_chapters.py
def test_expected_crossfade_duration():
    from xianxia_ai.chapters import expected_crossfade_duration
    assert abs(expected_crossfade_duration([10.0, 10.0, 10.0], 0.08) - 29.84) < 1e-6
    assert expected_crossfade_duration([], 0.08) == 0.0
    assert expected_crossfade_duration([5.0], 0.08) == 5.0
```

- [ ] **Step 2: Ejecutar (rojo) y luego implementar**

Run: `cd apps/sidecar-py && python -m pytest tests/test_chapters.py::test_expected_crossfade_duration -q 2>&1 | tail -3`
Expected: FAIL (función no existe) → añadir la función → re-run → `1 passed`.

- [ ] **Step 3: Aplicar crossfade en el concat real**

En el punto de `tts.py` donde hoy se concatenan los WAVs de chunk en el WAV final (concat crudo), sustituir por encadenado con `acrossfade` de 80 ms usando la sintaxis verificada en Task 11. Mantener fallback: si el comando ffmpeg con `acrossfade` retorna ≠ 0, caer al concat crudo actual (log `warn`). NO aplicar crossfade en fronteras de capítulo (esas uniones llevan pausa intencional) — el crossfade es solo intra-capítulo (entre chunks de un mismo `/tts` request).

- [ ] **Step 4: Timeline desde duración MEDIDA**

Con las líneas anotadas en Task 8: si `normalise_beat_timeline` (o el cálculo de timestamps de beats) usa duración **estimada por palabras**, cambiarlo para que use la **duración real del WAV final** (ffprobe o la librería de audio ya presente). Si ya usa duración medida, no tocar (solo dejar comentario confirmándolo). Esto hace el crossfade transparente para la sincronía imagen/capítulo.

- [ ] **Step 5: Validación capa 2 (audio real)**

Run: generar un TTS multi-chunk real y medir duración con ffprobe; comparar con `expected_crossfade_duration`. Expected: |medida − esperada| < 0.2 s y sin clic audible en las uniones (inspección).

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/routes/tts.py apps/sidecar-py/src/xianxia_ai/chapters.py apps/sidecar-py/tests/test_chapters.py apps/desktop/src-tauri/src/pipeline/mod.rs
git commit -m "feat(tts): crossfade 80ms entre chunks + timeline desde duración medida"
```

---

## Phase 6 · UI previewer de capítulos + ETA

### Task 13: Evento de capítulo y store

**Files:**
- Modify: `apps/desktop/src-tauri/src/pipeline/mod.rs` (emitir evento capítulo)
- Modify: `apps/desktop/src/lib/pipelineStore.ts` (estado chapters+eta)
- Modify: `apps/desktop/src/lib/events.ts` (listener)

- [ ] **Step 1: Emitir evento `chapter`**

En el loop de capítulos (Task 9), tras cada `upsert_chapter`, emitir por el `AppHandle` un evento `pipeline:chapter` con payload `{ project_id, index, total, title, status, words }`. Usar el mismo mecanismo que `emit()` (verificar cómo `emit()` publica eventos Tauri y replicar el canal).

- [ ] **Step 2: Extender `pipelineStore.ts`**

Añadir a `interface PipelineState`:

```typescript
  chapters: Record<number, { title: string; status: 'pending'|'writing'|'done'|'failed'; words: number }>;
  eta: { secondsLeft: number; basis: string } | null;
```

Inicializar `chapters: {}`, `eta: null`. Añadir acción:

```typescript
  applyChapter: (c: { index: number; title: string; status: 'pending'|'writing'|'done'|'failed'; words: number }) =>
    set((s) => ({ chapters: { ...s.chapters, [c.index]: { title: c.title, status: c.status, words: c.words } } })),
```

Resetear `chapters`/`eta` en la acción que ya limpia `phaseState` al iniciar generación.

- [ ] **Step 3: Listener en `events.ts`**

Donde se registran los listeners de `pipeline:*`, añadir uno para `pipeline:chapter` que llame `pipelineStore.getState().applyChapter(payload)`.

- [ ] **Step 4: tsc + cargo check**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && pnpm --filter @xianxia/desktop exec tsc -b 2>&1 | tail -3 && cd apps/desktop/src-tauri && cargo check 2>&1 | tail -2`
Expected: sin errores TS; `Finished`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/pipeline/mod.rs apps/desktop/src/lib/pipelineStore.ts apps/desktop/src/lib/events.ts
git commit -m "feat(ui): evento de capítulo + estado chapters/eta en pipelineStore"
```

### Task 14: Componente `<ChapterPreview/>` + ETA

**Files:**
- Create: `apps/desktop/src/components/chapter-preview.tsx`
- Modify: `apps/desktop/src/routes/generator.tsx` (montarlo)

- [ ] **Step 1: Escribir el componente**

`apps/desktop/src/components/chapter-preview.tsx` — consume `pipelineStore`; si `Object.keys(chapters).length === 0` devuelve `null` (cero datos demo). Usa primitivas Liquid Glass existentes (`lg-tile`, `group`, `row` de `@/components/ui-glass`), **sin partículas/canvas** (regla dura). Lista capítulos ordenados por índice con su estado (color: pending=tertiary, writing=accent, done=green, failed=red) y, si `eta != null`, una línea "≈ Xm Ys restantes ({basis})". ETA se calcula en el backend; el componente solo lo muestra.

- [ ] **Step 2: Montar en `generator.tsx`**

Importar y renderizar `<ChapterPreview/>` dentro del panel de progreso de generación (junto al render de fases existente), sin alterar la lógica de fases actual.

- [ ] **Step 3: ETA en backend**

En `pipeline/mod.rs`, durante la fase guion long-form, calcular `secondsLeft` simple: `(capítulos_restantes) * media_seg_por_capítulo_observada` (medida con `started_at` del primer capítulo). Emitir en el evento `pipeline:chapter` un campo `eta_seconds` (o evento separado `pipeline:eta`) y mapearlo en el store. Si no hay base (primer capítulo aún en curso) → no emitir ETA (queda `null`, UI no muestra nada).

- [ ] **Step 4: Build frontend**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && pnpm --filter @xianxia/desktop build 2>&1 | tail -3`
Expected: `✓ built`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/chapter-preview.tsx apps/desktop/src/routes/generator.tsx apps/desktop/src-tauri/src/pipeline/mod.rs
git commit -m "feat(ui): ChapterPreview (capítulos + ETA, sin datos demo)"
```

---

## Phase 7 · Blindaje, validación E2E y release

### Task 15: Invariantes parity-check

**Files:**
- Modify: `scripts/parity-check.mjs`

- [ ] **Step 1: Añadir checks**

Añadir invariantes (string/regex sobre los ficheros, estilo de los checks existentes):
1. `migrations/0003_chapters_resume.sql` existe y contiene `chapter_state` y `script_outline`; `0001_init.sql` y `0002_voices_expanded.sql` sin cambios de hash (comparar que no contienen `chapter_state`).
2. `routes/script.py` define `@router.post("/outline"` y `@router.post("/chapter"`.
3. `script.py` conserva el camino corto: existe la guarda `target_minutes >= 7` (long-form) y el `else` legacy.
4. `chapters.py` exporta `parse_outline`, `assemble_script`, `expected_crossfade_duration`.
5. `tts.py` tiene fallback de `acrossfade` (busca `acrossfade` y un `except`/return-code guard).
6. `chapter-preview.tsx` no contiene `particle`/`canvas`/`Math.random` decorativo y retorna `null` sin datos.

- [ ] **Step 2: Ejecutar parity-check**

Run: `node scripts/parity-check.mjs 2>&1 | tail -5`
Expected: `✓ All parity invariants satisfied.`

- [ ] **Step 3: Commit**

```bash
git add scripts/parity-check.mjs
git commit -m "test: invariantes parity-check para capítulos largos v0.5.0"
```

### Task 16: E2E real long-form + resume

**Files:**
- Create: `tests/manual/test_longform_chapters.py` (script manual, va a `tests/manual/` por la organización v0.4.0; **no** a la raíz)

- [ ] **Step 1: Escribir el smoke E2E**

Script que: arranca contra el sidecar real, pide `/script/outline` (10 min), genera los capítulos encadenando `running_summary`, ensambla, y verifica: nº capítulos 3-6, cada uno con `[CHAPTER:`, sin solape Jaccard alto entre capítulos consecutivos, palabras totales ≥ 85% del objetivo. Sin mock: usa el LLM local real.

- [ ] **Step 2: Ejecutarlo**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && python tests/manual/test_longform_chapters.py 2>&1 | tail -15`
Expected: `OK` con el resumen de capítulos y conteo de palabras dentro de objetivo.

- [ ] **Step 3: Resume manual**

Generar un proyecto largo real desde la UI, matar el proceso tras 2 capítulos, relanzar la generación del mismo proyecto y confirmar en logs `Capítulo 1/2 reanudado` y que NO se regeneran (los `done` se reutilizan).
Expected: reanuda en el capítulo pendiente; guion final completo y coherente.

- [ ] **Step 4: Commit**

```bash
git add tests/manual/test_longform_chapters.py
git commit -m "test: E2E real long-form chapters + resume manual"
```

### Task 17: Versión + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`; `package.json`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml` (vía script)

- [ ] **Step 1: Bump de versión**

Run: `node scripts/bump-version.mjs 0.5.0 2>&1 | tail -6`
Expected: `✓ package.json … ✓ Cargo.toml`

- [ ] **Step 2: Entrada CHANGELOG `[0.5.0]`**

Añadir bajo `## [Unreleased]` una entrada `## [0.5.0] — <fecha>` que describa: planner+outline, generación por capítulo con summary continuation, schema 0003 + resume granular, crossfade TTS, UI previewer+ETA; nota de que el camino corto v0.1.38 y los contratos de marcadores quedan intactos; validación realizada.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
git commit -m "release: v0.5.0 — capítulos largos robustos"
```

### Task 18: Bundle final (SOLO, sin dev server) + push

**Files:** ninguno (build + git).

- [ ] **Step 1: Garantizar entorno limpio (lección crash libuv)**

Run (PowerShell): matar cualquier listener en :1420 y procesos `xianxia_studio/link/cargo/rustc` huérfanos; confirmar `Puerto 1420 libre`.

- [ ] **Step 2: Build del bundle SOLO**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && pnpm tauri:build` (en background; ningún dev server concurrente).
Expected: exit 0; `Xianxia Studio_0.5.0_x64-setup.exe` en `target/release/bundle/nsis/`.

- [ ] **Step 3: Merge a main + tag + push**

```bash
git checkout main
git merge --no-ff feat/v0.5.0-capitulos-largos -m "release: v0.5.0 — capítulos largos robustos"
git tag v0.5.0
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main --follow-tags
```
Expected: push OK; el CI `release.yml` crea el GitHub Release v0.5.0 firmado.

- [ ] **Step 4: Verificación post-release**

Run: `gh run list --limit 1 && gh release list --limit 1`
Expected: run `success`; release `v0.5.0` `Latest`.

- [ ] **Step 5: Memoria**

Actualizar `memory/architecture_xianxia.md` + `MEMORY.md` + Engram: el flujo long-form ahora es outline+por-capítulo con resume; tareas #152-160 cerradas; spec/plan en `docs/superpowers/`.

---

## Self-Review

**1. Spec coverage:**
- Pieza 1 (planner+outline) → Tasks 4,5,6 ✓
- Pieza 2 (chapter + summary continuation) → Tasks 5,7,9 ✓
- Pieza 3 (schema DB + resume) → Tasks 1,2,3,9,10 ✓
- Pieza 4 (crossfade TTS + timeline medida) → Tasks 11,12 ✓
- Pieza 5 (UI previewer + ETA) → Tasks 13,14 ✓
- Compatibilidad/contratos → guarda `>=7` en Task 9, parity Task 15 ✓
- Restricciones (wake_llm, GPU-only, cero mock, verificar upstream, migración nueva) → Tasks 6/9 (wake_llm), 11 (context7), 1 (migración nueva), 14/15 (sin demo) ✓
- Testing (cargo/pytest/parity/E2E) → Tasks 2,4,10,12,15,16 ✓
- Release → Tasks 17,18 ✓

**2. Placeholder scan:** Los puntos marcados "verificar nombre real / firma real" (Tasks 6,8,9,10,12,13) son **instrucciones de verificación contra el código existente**, no placeholders de diseño — el plan da el código completo y señala explícitamente qué identificador confirmar (`_language_name`, `llm_generate` args, `project_dir`, canal de `emit()`, `normalise_beat_timeline`). Task 8 es la tarea dedicada a resolver esas incógnitas antes de las Tasks 9-12 que dependen de ellas. Sin "TBD/TODO/implement later" reales.

**3. Type consistency:** `NewChapter`/`ChapterRow` (Task 2) usados consistentes en Tasks 3,9. `parse_outline`/`assemble_script`/`expected_crossfade_duration` (Tasks 4,12) coinciden con parity (Task 15) y tests. `applyChapter` y la forma de `chapters`/`eta` coinciden entre Tasks 13 y 14. Endpoints `/script/outline` y `/script/chapter` coinciden entre Tasks 6,7 (Python) y 9 (Rust) y 15 (parity).
