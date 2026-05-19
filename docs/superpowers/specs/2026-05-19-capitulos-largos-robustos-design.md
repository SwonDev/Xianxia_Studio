# v0.5.0 — Capítulos largos robustos · Design Spec

**Fecha:** 2026-05-19
**Estado:** Aprobado (enfoque A)
**Autor:** sesión Claude Code + SwonDev

## Contexto y problema

La auditoría del 2026-05-19 (ver memoria `architecture/long-form-capítulos…`)
demostró que el plan v0.2.0 de capítulos largos **nunca se implementó como tal**:
se reemplazó por un multi-pass v0.1.38 que genera el guion en pasadas ciegas
inyectando solo los **últimos 1200 chars** como contexto. Funciona y produce
vídeos largos con capítulos en YouTube, pero tiene gaps reales:

1. Coherencia no garantizada en 15-25 min (sin memoria global → deriva/repite).
2. Sin resume: fallo en fase tardía regenera guion+TTS desde cero.
3. TTS concatena chunks en crudo (posibles micro-cortes).
4. Sin UI de capítulos ni ETA.
5. Sin estado persistido de capítulos.

Estado real verificado de las 9 piezas v0.2.0: #157,#158 implementadas;
#153,#155,#156,#159 parciales; #152,#154,#160 inexistentes.

## Objetivo

Cerrar el gap completo manteniendo **intacto** lo que ya funciona: el flujo
corto de una pasada y todos los contratos aguas abajo (marcadores
`[CHAPTER:]/[IMAGE:]/[MUSIC:]`, `script_markers`, tarjetas en `render.ts`,
capítulos YouTube en `seo.py`).

## Restricciones duras del proyecto (heredadas)

- **GPU-only**: ningún modelo cae a CPU. El crossfade es post-proceso ffmpeg
  (CPU), no es un modelo → permitido.
- **100% local, cero mock/datos demo**: la UI no muestra nada inventado; si
  no hay datos, no se muestra.
- **`wake_llm` antes de cualquier fase LLM** (regla `bugfix_llamacpp_respawn`).
- **Verificar upstream**: sintaxis de ffmpeg `acrossfade` se confirma vía
  context7/docs antes de escribir el código, no de memoria.
- **Migración nueva, nunca modificar 0001/0002** (regla `migration modified`):
  sqlx solo aplica migraciones nuevas; el auto-heal v0.1.12 cubre el resto.

## Arquitectura

`target_minutes ≥ 7` (umbral long-form, ya usado por `multi_pass` en
`script.py:164`) conmuta del multi-pass ciego al nuevo flujo
**outline → capítulo-a-capítulo con memoria estructurada**. Por debajo del
umbral, el camino actual de una pasada queda **sin tocar**.

El guion final ensamblado es textualmente equivalente en estructura de
marcadores al actual → `parse_markers`, `script_markers`, `render.ts`
(tarjetas de capítulo v0.1.38), `seo.py` (capítulos YouTube) **no cambian**.

## Componentes

### Pieza 1 · Planner + outline (`#152`)

- Nuevo endpoint Python `POST /script/outline` en `routes/script.py`.
- Input: `topic`, `target_minutes`, `language`, `context_facts` (RAG ya
  existente en `script.py`).
- Output JSON estricto:
  ```json
  {"chapters":[{"index":1,"title":"<2-4 palabras evocativas en idioma>",
    "synopsis":"<2-3 frases>","target_words":<int>,"beats":["<beat>", ...]}]}
  ```
- Nº de capítulos: regla actual (`~minutes/2`, mínimo 3, máximo 6).
- `wake_llm` primero. Temperatura baja (~0.4) para outline estable.
  `num_ctx` suficiente para prompt+outline; `num_predict` ~1500.
- Reintento 1 vez si el JSON no parsea; fallback duro: si tras el reintento
  no hay JSON válido → caer al multi-pass v0.1.38 actual (degradación
  graceful, nunca romper la generación). Se registra el fallback en logs.

### Pieza 2 · Generación por capítulo con summary continuation (`#153`)

- Nuevo endpoint `POST /script/chapter`. Input: `outline`, `chapter_index`,
  `running_summary` (estructurado), `language`, `topic`, `is_final`.
- `running_summary` estructurado (NO 1200 chars crudos): objeto con
  `told` (qué se ha narrado), `open_threads` (hilos sin cerrar),
  `used_facts` (hechos ya usados, para anti-repetición Jaccard — patrón ya
  usado en imágenes), `last_paragraph` (literal, continuidad de voz).
- Tras generar el capítulo: llamada LLM corta (~250 tokens, temp baja)
  que produce el `running_summary` actualizado para el siguiente capítulo.
- El capítulo arranca con `[CHAPTER: <title del outline>]`; inserta
  `[IMAGE:]` cada 25-40 palabras y `[MUSIC:]` en cambios de mood, igual que
  hoy. El último capítulo (`is_final`) entrega resolución + CTA.
- Anti-repetición: Jaccard entre `used_facts` y el nuevo capítulo; si
  supera umbral, una corrección de un tiro pide variar.
- Ensamblado: el orquestador concatena los capítulos en orden con separador
  `\n\n` (igual que el multi-pass actual para que `parse_markers` no
  fusione frases).

### Pieza 3 · Schema DB + resume granular (`#154`, `#155`, `#159`)

Migración `apps/desktop/src-tauri/migrations/0003_chapters_resume.sql`:

```sql
CREATE TABLE IF NOT EXISTS script_outline (
    project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    outline_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_state (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL,           -- pending|writing|done|failed
    narration_path TEXT,                   -- por-capítulo en disco proyecto
    summary_text  TEXT,                    -- running_summary serializado
    words         INTEGER,
    error_message TEXT,
    updated_at    INTEGER NOT NULL,
    UNIQUE(project_id, chapter_index)
);
CREATE INDEX IF NOT EXISTS idx_chapter_state_project
    ON chapter_state(project_id, chapter_index);
```

- **Resume del guion**: si la generación se cortó, los capítulos `done` no
  se regeneran; se continúa desde el primer `pending|failed`.
- **Resume del pipeline**: al arrancar `start_generation`, si el proyecto
  tiene filas en `pipeline_steps` con `status='done'`, se **reanuda**:
  cada fase comprueba su `pipeline_steps.output_json`; si está `done` y el
  artefacto referenciado existe en disco, se salta y se reutiliza. Se
  estandariza que cada fase escriba en `output_json` los paths reanudables
  (guion, wav TTS final, render). Las fases que ya lo hacen se respetan;
  las que no, se amplían (cambio aditivo).
- **Cancelación**: `abort_generation` sigue siendo abort de la tarea tokio
  (no se introduce kill por sub-paso). "Granular" = el estado persistido
  permite que el siguiente run reanude por fase y por capítulo en vez de
  empezar de cero. Botón explícito "regenerar desde cero" en la UI limpia
  `pipeline_steps`/`chapter_state`/`script_outline` del proyecto.
- Acceso DB en módulo nuevo `db/chapters.rs` (espejo del patrón
  `db/scheduled.rs`: structs `FromRow`, funciones `record/get/list/reset`,
  `sqlx::query`; **verificar cada identificador SQL a mano contra esta
  migración** — regla del catálogo: `sqlx::query()` no valida en
  compile-time).

### Pieza 4 · Crossfade TTS (`#156`)

- Crossfade equal-power ~80 ms en las uniones de chunk **dentro de un
  capítulo**; no en fronteras con pausa intencional.
- Anti-desync: la timeline de beats DEBE derivarse de la **duración medida
  del WAV final tras concatenar**, no estimada. Acción: auditar
  `normalise_beat_timeline` (Rust `pipeline/mod.rs`) y la medición de
  duración del audio; si usa estimación por palabras en lugar de duración
  real del WAV, corregirlo a duración medida (ffprobe/symphonia ya en uso).
- Implementación en Python (`tts.py` concat) con ffmpeg `acrossfade`
  (sintaxis verificada vía context7 antes de codificar). Fallback: si
  `acrossfade` falla, concat crudo actual (degradación graceful).

### Pieza 5 · UI previewer + ETA (`#160`)

- `pipelineStore.ts`: añadir `chapters: Record<number,{title:string;
  status:'pending'|'writing'|'done'|'failed';words:number}>` y
  `eta:{secondsLeft:number;basis:string}|null`.
- Backend emite eventos `chapter_started`/`chapter_done` (title, index,
  words) por el mismo canal `emit()` que las fases.
- ETA: combinación de (a) palabras objetivo vs generadas en fase guion,
  (b) duración histórica de fases (`pipeline_steps.started_at/finished_at`
  de proyectos previos del mismo equipo). Si no hay base suficiente →
  `eta=null` y la UI no muestra ETA (nada inventado).
- `generator.tsx`: lista de capítulos con su estado y, si `eta!=null`,
  una línea de tiempo estimado. Primitivas Liquid Glass existentes
  (`lg-tile`, `group`, `row`), **sin partículas/canvas** (regla dura
  `feedback_no_particles`), sin datos demo.

## Flujo de datos

```
target_minutes ≥ 7 ?
  └─ sí → /script/outline → persist script_outline
          loop idx: /script/chapter(outline, idx, running_summary)
                    → persist chapter_state(idx, done, summary)
                    → emit chapter_done(idx)
          ensamblar guion (marcadores intactos)
  └─ no → camino v0.1.38 actual (una pasada) — sin cambios
→ parse_markers → script_markers → resto del pipeline IGUAL que hoy
→ TTS: chunks → crossfade 80ms → WAV final → duración MEDIDA → timeline
→ eventos capítulo/ETA → pipelineStore → generator.tsx
```

## Manejo de errores / resume

- Fallo LLM en capítulo N → `chapter_state[N].status='failed'`; re-run
  reanuda en N (los `done` se reutilizan desde `narration_path`).
- Outline inválido tras reintento → fallback a multi-pass v0.1.38.
- Fallo en fase tardía (render) → re-run salta fases `done` reutilizando
  `output_json`; reanuda en la fase fallida.
- `acrossfade` falla → concat crudo (comportamiento actual).
- Todo best-effort respeta `wake_llm`, GPU-only, cero mock.

## Testing

- **Rust** `cargo test`: parsing de outline JSON; `db/chapters.rs`
  record/get/list/reset; lógica de skip de fases `done` en resume
  (unitario sobre una DB en memoria).
- **Python**: outline JSON schema válido; continuidad entre capítulos
  (el summary contiene los hilos esperados); crossfade no altera la
  duración total más de ±ε vs suma de chunks − solapes.
- **parity-check**: nuevos invariantes — (a) long-form usa
  outline+por-capítulo, corto usa una pasada; (b) el guion ensamblado
  preserva `[CHAPTER:]/[IMAGE:]/[MUSIC:]`; (c) migración 0003 presente y
  0001/0002 intactas; (d) crossfade con fallback; (e) UI sin datos demo.
- **E2E real**: un vídeo largo (~10-14 min) generado de verdad
  (sin mock), verificar capítulos coherentes + resume tras matar a mitad.

## Compatibilidad

- Umbral `≥7 min` aísla el cambio; `<7 min` intacto.
- Contratos aguas abajo sin cambios (marcadores).
- Migración `0003` nueva; `0001/0002` no se tocan; auto-heal v0.1.12
  cubre cualquier mismatch heredado.
- Degradaciones graceful en cada pieza → nunca rompe una generación que
  hoy funcionaría.

## Fuera de alcance (YAGNI)

- Edición manual del outline por el usuario antes de generar (futuro).
- Regenerar un solo capítulo desde la UI (futuro; el resume cubre el
  caso de fallo, no el de "no me gusta este capítulo").
- Paralelizar capítulos (el LLM local es un único recurso GPU; secuencial
  es correcto y respeta GPU-only).
