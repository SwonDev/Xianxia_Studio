# Roadmap v0.2.0 — Long-form video generation

Status: **planificado** · Target: tras la validación de v0.1.8 end-to-end

v0.1.8 garantiza vídeos hasta ~15 min de forma determinista en RTX 4060 8 GB
(swap secuencial real entre los 7 modelos del pipeline). v0.2.0 desbloquea
**vídeos de cualquier duración** con coherencia narrativa garantizada vía
arquitectura por capítulos + memoria persistente.

---

## Premisa

El único cuello de botella real para vídeos largos en v0.1.8 es **Phase 1
Script**: Gemma 4 con `num_ctx=32768` (~24K palabras útiles para narración
densa) hace UNA llamada y devuelve la narración entera. Para vídeos de 30+
min, una sola pasada satura el contexto, trunca o repite, y no garantiza
coherencia.

El resto del stack ya escala:
- TTS Qwen3 chunkea internamente
- ACE-Step / MusicGen tienen chunking + crossfade
- FFmpeg `_render_chunked` maneja >30 beats sin filter_complex limits
- HyperFrames GSAP timeline no tiene límite de duración
- faster-whisper transcribe streaming sin tope

La solución es **chunking de script con memoria persistente entre
capítulos**, sin tocar el resto del pipeline.

---

## Filosofía Auto aplicada al long-form

| Ley | Cómo se aplica en v0.2.0 |
|---|---|
| **Autoinstalable** | Planner LLM reusa el Gemma 4 ya instalado. Skill opcional Gemma 4 9B Q4 (fallback OOM) entra al manifest con `required: false` |
| **Autodetectable** | El pipeline detecta `target_minutes > LONG_FORM_THRESHOLD` (default 15) y enruta automático a `run_long_form()`. Cero toggle manual |
| **Autoconfigurable** | Skill router lee VRAM real al arranque + benchmarks ligeros y ajusta batch sizes, quantization, paralelismo según hardware tier |
| **Autoreparable** | Cada capítulo se persiste en SQLite cuando completa. Si el pipeline se interrumpe, "Continuar generación desde capítulo 7/12" en la UI Library |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  v0.1.8 single-shot path (target_minutes ≤ 15)              │
│  Phase 1 → 2 → 3 → 4 → 4b → 5 → 6 → 7 → 8 → 9 → 10          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  v0.2.0 long-form path (target_minutes > 15)                │
│                                                             │
│  Phase 0: /script/outline → outline JSON                    │
│           { chapters: [{idx, title, theme, est_seconds}] }  │
│           Persisted in script_chapters table                │
│                                                             │
│  for ch in chapters:                                        │
│    Phase 1.ch: /script/chapter (with prev summary as ctx)   │
│    Phase 3.ch: /tts/chapter → tts-chN.wav                   │
│    Phase 4.ch: /image batch (markers from this chapter)     │
│    chapter_summaries.insert(ch.idx, summary)                │
│                                                             │
│  Phase 3.merge: /tts/concat → narration-final.wav           │
│  Phase 4b: /depth/batch (all images, single call)           │
│  Phase 5: /music duration_seconds = sum(ch.est_seconds)     │
│  Phase 6: /render/narrative (HyperFrames with global offsets)│
│  Phase 7-10: idéntico a single-shot                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Schema DB (migración 0002_long_form.sql)

```sql
-- Outline + capítulos persistidos
CREATE TABLE script_chapters (
    id TEXT PRIMARY KEY,             -- ulid
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,            -- 0-based chapter index
    title TEXT NOT NULL,
    theme TEXT,
    est_seconds REAL NOT NULL,
    narration TEXT,                  -- llenado tras /script/chapter
    markers_json TEXT,               -- IMAGE/MUSIC/SFX markers JSON
    audio_path TEXT,                 -- relative to project dir
    status TEXT NOT NULL DEFAULT 'pending',  -- pending|generating|done|failed
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id, idx)
);
CREATE INDEX idx_chapters_project ON script_chapters(project_id, idx);

-- Resúmenes ejecutivos (50-200 tokens) inyectados al SYSTEM del siguiente
CREATE TABLE chapter_summaries (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    tokens_used INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, idx)
);

-- Knowledge graph del proyecto: personajes, lugares, plot points
-- Gemma 4 extrae estos elementos como JSON tras cada capítulo y se
-- consolidan aquí para garantizar coherencia.
CREATE TABLE chapter_state (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,               -- 'characters' | 'locations' | 'lore' | etc
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, key)
);
```

---

## Endpoints sidecar Python (nuevos)

### `POST /script/outline`
```json
// Request
{
  "topic": "El ascenso del Inmortal del Trueno",
  "target_minutes": 30,
  "language": "es",
  "style": "xianxia"
}

// Response
{
  "chapters": [
    { "idx": 0, "title": "Origen humilde", "theme": "...",
      "est_seconds": 360, "image_count_hint": 6, "mood_hint": "mystery" },
    { "idx": 1, "title": "El primer encuentro con el Maestro",
      "est_seconds": 480, "image_count_hint": 8, "mood_hint": "epic" },
    ...
  ],
  "total_seconds": 1800,
  "total_chapters": 6,
  "model": "xianxia-llm",
  "tokens_used": 1850
}
```

Coste ~2K tokens, ~5s en RTX 4060. Gemma 4 con SYSTEM prompt
"eres planner de vídeo cinematográfico" devuelve outline estructurado.
Se valida con Pydantic + retry una vez si Gemma se sale del schema
(usa la lección de v0.1.6 sobre tolerar drift).

### `POST /script/chapter`
```json
// Request
{
  "project_id": "01...",
  "chapter_idx": 3,
  "chapter_spec": { "title": "...", "theme": "...", "est_seconds": 360 },
  "previous_summary": "Tras el encuentro con el Maestro, el protagonista...",
  "knowledge_graph": {
    "characters": [{ "name": "Lin Wei", "traits": "..." }, ...],
    "locations": ["Jade Mountain", ...],
    "lore": ["Qi cultivation requires...", ...]
  },
  "language": "es",
  "style": "xianxia"
}

// Response
{
  "narration": "El amanecer rompió sobre las cumbres...",
  "markers": [
    { "kind": "IMAGE", "prompt": "...", "start_seconds": 0 },
    { "kind": "MUSIC", "mood": "epic", "start_seconds": 30 },
    ...
  ],
  "summary": "Lin Wei consigue su primer breakthrough en cultivación tras...",
  "knowledge_delta": {
    "new_characters": [{ "name": "Maestro Wu", ... }],
    "new_lore": ["Breakthroughs require..."],
  },
  "estimated_seconds": 358,
  "word_count": 950
}
```

El `summary` (50-200 tokens) se persiste en `chapter_summaries` y se
inyecta al SYSTEM del siguiente capítulo. El `knowledge_delta` se
mergea en `chapter_state` para mantener consistencia narrativa.

### `POST /tts/chapter`
```json
// Request
{
  "project_id": "01...",
  "chapter_idx": 3,
  "narration": "...",
  "language": "es",
  "speaker": "Vivian"
}

// Response
{
  "audio_path": ".../tts-ch3-XXX.wav",
  "duration_seconds": 358.2
}
```

Idéntico al `/tts` actual pero el filename incluye el chapter_idx para
que `/tts/concat` los pueda ordenar.

### `POST /tts/concat`
```json
// Request
{
  "audio_paths": ["...tts-ch0.wav", "...tts-ch1.wav", ...],
  "out_path": ".../narration-final.wav",
  "crossfade_seconds": 0.3
}

// Response
{
  "out_path": ".../narration-final.wav",
  "duration_seconds": 1798.5
}
```

FFmpeg `concat` filter + `acrossfade` 0.3s para no chasquidos entre
capítulos.

---

## Pipeline Rust orchestrator (`pipeline/long_form.rs`)

```rust
const LONG_FORM_THRESHOLD_MIN: u32 = 15;

pub async fn run(...) -> Result<()> {
    if req.target_minutes <= LONG_FORM_THRESHOLD_MIN {
        return run_single_shot(...).await;
    }
    run_long_form(...).await
}

async fn run_long_form(app, pool, pid, req) -> Result<()> {
    // Phase 0: outline
    let outline = call_outline_endpoint(req).await?;
    persist_outline(pool, pid, outline).await?;

    // Phase 1.N: per-chapter generation
    let mut narration_paths = vec![];
    for chapter in outline.chapters {
        // Resume support: skip if already done
        if db::chapter_done(pool, pid, chapter.idx).await? {
            continue;
        }

        let prev_summary = db::previous_summary(pool, pid, chapter.idx).await?;
        let knowledge = db::knowledge_graph(pool, pid).await?;

        let chapter_resp = call_chapter_endpoint(
            pid, &chapter, prev_summary, knowledge,
        ).await?;

        db::persist_chapter(pool, pid, &chapter_resp).await?;
        db::persist_summary(pool, pid, chapter.idx, &chapter_resp.summary).await?;
        db::merge_knowledge(pool, pid, &chapter_resp.knowledge_delta).await?;

        // Phase 3.ch: TTS for this chapter
        let audio = call_tts_chapter(pid, chapter.idx, &chapter_resp.narration).await?;
        narration_paths.push(audio.audio_path);

        emit(app, pid, 1, "running",
             (chapter.idx as f64 + 1.0) / outline.chapters.len() as f64 * 100.0,
             &format!("Capítulo {}/{}", chapter.idx + 1, outline.chapters.len()));
    }
    unload(&client, "ollama").await;

    // Phase 3.merge
    let final_audio = call_tts_concat(narration_paths).await?;
    unload(&client, "tts").await;

    // Phases 4-10: idénticas, pero markers absolutos calculados sumando offsets
    let beats = build_beats_with_global_offsets(&outline)?;
    // ... resto del pipeline
}
```

**Resume**: si la app se cierra durante un long-form, al reabrir el
proyecto la UI muestra "Continuar generación desde capítulo 7/12". El
orquestador hace `db::chapter_done()` y salta los capítulos ya hechos.

---

## HyperFrames composition con offsets globales

`narrative.html` no cambia. El cambio está en `render.ts` (sidecar Node):

```ts
// Cada beat lleva data-start ABSOLUTO (offset desde t=0 del vídeo entero)
// Para long-form: chapter_offsets[idx] = sum(prev_chapter_durations)
const beatNodes = chapters
  .flatMap(ch => ch.images.map(img => ({
    ...img,
    start: img.start + chapterOffset(ch.idx),  // ← offset global
  })))
  .map((b, i) => buildBeatNode(b, i))
  .join('\n');
```

GSAP timeline maneja sin problemas duraciones de >30 min siempre que
el navegador disponga de suficiente RAM. Validar: para 60 min con 60
imágenes, el composition.html final pesa ~30 KB y carga en <1s.

---

## Skill router por hardware (`installer/skill_router.rs`)

Detecta VRAM al arranque (sysinfo + nvidia-smi) y benchmarks ligeros:

| VRAM | Estrategia |
|---|---|
| **8 GB** (RTX 3060/4060/5060) | Pipeline v0.1.8: Gemma 4 abliterated, Z-Image GGUF Q4_K_M, Qwen3-4B IQ4_XS GGUF text encoder, ACE-Step bf16. Long-form chunked. |
| **12 GB** (RTX 4070) | Quitar GGUF text encoder, usar fp8 mixed. Phase 4 sin reload entre imágenes. |
| **16 GB** (RTX 4080/5070 Ti) | Long-form más cómodo. ACE-Step longer chunks. Whisper large-v3 turbo. |
| **24 GB+** (RTX 4090/5090) | Phase 4 paraleliza 2-3 imágenes. Z-Image bf16 sin quantization. Gemma 27B opcional. |

**Auto-fallback dinámico**: si Gemma 4 da OOM en algún capítulo, el skill
router hace `swap_to(Gemma 4 9B Q4)` automático. El usuario nunca ve
"out of memory" — solo nota que la calidad del texto baja un escalón.

Política: cualquier modelo crítico tiene un "rescue tier" más pequeño
declarado en el manifest. El router lo activa automáticamente.

---

## UI changes (Generator + Library)

### Generator
- Slider de duración llega hasta 120 min (era 30)
- Si `target_minutes > 15`: aparece subsección "Plan del vídeo":
  - Botón "Generar outline" (Phase 0 manual antes de comprometer)
  - Lista de capítulos editable (drag para reordenar, click para editar título/duración)
  - "Iniciar generación" usa el outline aprobado
- Durante run: panel muestra "Capítulo 4/12 · 33%" + ETA dinámico
  basado en velocidad real de los capítulos previos

### Library card
- Long-form muestra estructura del vídeo:
  - Mini-timeline con marcadores por capítulo
  - Click en capítulo → preview del audio de ese capítulo
- Si `status == 'incomplete'`: badge "7/12 capítulos" + botón "Continuar"

---

## Criterios de éxito v0.2.0

1. ✅ Vídeo de **30 min** generado end-to-end coherente (mismo personaje,
   mismo tono, plot continúa) en RTX 4060 8 GB sin OOMs
2. ✅ Vídeo de **60 min** generado end-to-end (~12 capítulos)
3. ✅ Resume desde fallo funciona: si mato la app a mitad de capítulo 7,
   al reabrir continúa desde capítulo 7
4. ✅ Coherencia narrativa: personajes y lugares no cambian de nombre
   entre capítulos. Validable con un test que pasa los nombres del
   capítulo N por knowledge graph y verifica que aparecen en N+5
5. ✅ HyperFrames render exitoso en composition de 60 min sin lag
6. ✅ Auto-detect de tier hardware funcional (probado en 8/12/16/24 GB
   o simulado con `XIANXIA_VRAM_OVERRIDE`)
7. ✅ Botón cancelar generación cancela limpio el capítulo actual,
   deja los anteriores intactos
8. ✅ Cero degradación de calidad en vídeos cortos (<15 min) que sigan
   usando la ruta single-shot

---

## Hoja de implementación (orden recomendado)

1. **#154** — Schema DB long-form (migración 0002)
2. **#152** — Planner LLM `/script/outline`
3. **#153** — Chapter generator `/script/chapter` + memoria persistente
4. **#155** — Pipeline orchestrator long-form (auto-detect threshold)
5. **#156** — TTS chapter accumulator + concat
6. **#157** — HyperFrames offset global
7. **#158** — Skill router hardware
8. **#159** — Resume + cancel granular
9. **#160** — UI previewer + ETA dinámico

Las primeras 4 desbloquean long-form básico funcional. Las 5-9 polish
y robustez.

---

## Notas de diseño

- **El planner LLM no es opcional** — es obligatorio para long-form
  porque garantiza estructura. Sin outline, los capítulos derivarían
- **El summary continuation no es opcional** — sin él, cada capítulo
  empieza de cero en términos narrativos. Coherencia rota.
- **El knowledge graph es el ingrediente secreto** para coherencia a
  largo plazo. Gemma 4 sin él olvida nombres tras 3-4 capítulos
- **El skill router** es el plumbing que permite que los mismos
  archivos `pipeline/mod.rs` corran perfectos en hardware variado
- **Resume** convierte fallos catastróficos en inconvenientes menores

---

## Lo que NO entra en v0.2.0 (pero se puede plantear para v0.3.0)

- Voces que cambian por capítulo (multi-personaje narrado)
- Fade visuales entre capítulos (transiciones específicas largas)
- Trailer auto-generado (highlights del vídeo final)
- Episodios encadenados (serie de N vídeos compartiendo lore)
- Live preview HTML del long-form antes de renderizar
