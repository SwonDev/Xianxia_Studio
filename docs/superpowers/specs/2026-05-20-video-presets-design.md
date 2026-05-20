# v0.7.0 · "Tipo de vídeo" — Presets de pipeline

**Fecha**: 2026-05-20  
**Autor**: Claude (Opus 4.7, 1M ctx) con SwonDev  
**Estado**: spec aprobado por el usuario; pendiente self-review + revisión usuario antes de pasar a writing-plans.  
**Versión objetivo**: v0.7.0 (cambio mayor, no patch).

## Contexto

Hoy el pipeline está afinado para **narrativa épica cinematográfica**:
guion dramático en tono mítico, imágenes cinematográficas, música épica,
voz inmersiva. Funciona — y es lo que produce un buen vídeo "tema
xianxia / mitología" — pero **bloquea otros casos de uso reales** del
usuario: hacer un vídeo divulgativo de cultura nórdica explicado de
forma fidedigna y descriptiva, un Top-N, una comparativa, un
documental, o un deep-dive analítico salen forzados o directamente
mal si el motor sigue dramatizando todo como un cuento épico.

Esta spec define un **selector "Tipo de vídeo"** con 6 presets, cada
uno un mini-pipeline que cambia *qué le pedimos al motor*, sin cambiar
*el motor*. Los 6 presets son ortogonales (cubren tipos de YouTube
reales), aprovechan TODO lo que ya existe (long-form chapters de
v0.5.0, RAG Wikipedia, filtro iconography de v0.6.8), y se introducen
con **cero regresión** para usuarios actuales gracias al invariante
byte-idéntico del preset por defecto.

## Goal

Que el usuario pueda escoger en el Generator entre 6 tipos de vídeo y
que el guion + voz + imágenes + música cambien coherentemente a ese
tipo, sin tocar la arquitectura ni el motor de generación.

## Arquitectura (no cambia el motor)

```
Generator UI ──→ start_generation(preset_id) ──→ pipeline/mod.rs
                                                      │
                                                      ▼
                                  ┌───────────────────┴──────────────────┐
                                  ▼                                       ▼
                          /script + /outline             _rewrite_image_prompts_from_narration
                          (system_prompt = preset.       (_STYLE_SUFFIX = IMAGE_STYLE_BIAS[...])
                          llm_style_directive + base)               │
                                  │                                  ▼
                                  │                          _inject_auto_image_markers
                                  ▼                          (mismo style bias)
                          ╔══════════════════════╗
                          ║  apps/sidecar-py/    ║
                          ║  src/xianxia_ai/     ║
                          ║   presets.py (nuevo) ║
                          ║                      ║
                          ║  PRESETS dict[6]     ║
                          ║  + 3 mapping tables  ║
                          ╚══════════╤═══════════╝
                                     │
                          ┌──────────┼──────────┐
                          ▼          ▼          ▼
                       /music     /tts        long-form gate
                  (prompt seed   (voice    (force chapters if
                   = mood_to_     descriptor) preset.use_chapters)
                   prompt)
```

**Punto único de cambio** = `presets.py`. Si mañana se añade un 7º
preset, se hace ahí; ningún otro archivo cambia salvo el chequeo de
parity y el selector del Generator.

## El esquema `VideoPreset`

```python
@dataclass(frozen=True)
class VideoPreset:
    id: str                          # estable, snake_case, key del dict
    label_es: str                    # texto en el chip de UI
    description_es: str              # hint 1-línea al hover
    llm_style_directive: str         # bloque inyectado en system prompt de /script + /outline
    voice_tone: str                  # key en VOICE_TONE_TO_DESCRIPTOR
    image_style: str                 # key en IMAGE_STYLE_BIAS
    music_mood: str                  # key en MUSIC_MOOD_TO_PROMPT
    target_minutes_default: int      # duración propuesta por defecto si el usuario no marca
    markers_per_minute: float        # densidad de [IMAGE:] markers (ratio actual = 5.0)
    hook_style: str                  # "epic_question" | "fact_hook" | ...
    cta_style: str                   # "epic_call" | "didactic_close" | ...
    use_chapters: bool               # True = fuerza long-form chapters; False = auto-detect actual
```

## Los 6 presets

| id | label | tono voz | estilo imagen | mood música | min def | mark/min | chapters | uso típico |
|---|---|---|---|---|---|---|---|---|
| `narrative_epic` ⭐ | Narrativa épica | dramatic | cinematic | epic | 10 | 5.5 | auto | mitología, fantasía, cuento épico (default — preserva comportamiento actual byte-idéntico) |
| `documentary` | Documental | narrator_measured | documentary | sober | 8 | 4.5 | auto | hechos históricos, biografía, evento real con voz tipo BBC |
| `explainer` | Divulgativo | didactic_warm | editorial_illustrative | sober_curiosity | 6 | 5.0 | auto | "qué es la cultura nórdica" — explicar fidedigna y descriptivamente |
| `listicle` | Top-N | energetic | editorial_dynamic | energetic | 6 | 5.5 | auto | "10 cosas que no sabías de…", "Top 7 X" |
| `comparative` | Comparativa A vs B | analytical | editorial_dual | analytical | 8 | 5.0 | auto | "Vikings vs Samurai" (topic debe nombrar ambos) |
| `deep_dive` | Deep-dive / Análisis | analytical_calm | editorial_documentary | analytical | 15 | 4.0 | **forzado** | análisis largo (podcast-style), siempre long-form con capítulos |

### Directivas LLM por preset (literal)

- **`narrative_epic`** (DEFAULT, byte-idéntico al actual)  
  Cuento épico cinematográfico con dramatización vívida, imaginería
  sensorial, marco mítico, lenguaje emocionalmente cargado. Hook =
  escena/pregunta épica; cierre temático + CTA.  
  *Esta directiva debe matchear letra a letra el system prompt actual
  de `prompts.py` — la transición v0.6.x → v0.7.0 NO debe regenerar de
  forma distinta para quien no toque el selector.*

- **`documentary`**  
  Documental fiel; precisión estricta sobre el brief Wikipedia. Estructura:
  contexto (quién/cuándo/dónde) → 3-5 segmentos cronológicos o temáticos
  → contexto/legado. Voz narrador medido (estilo archivo BBC). Sin
  diálogo inventado, sin exageración mítica. `[IMAGE:]` apuntan a
  artefactos reales, mapas, fotos de archivo, escenas histórico-fieles.

- **`explainer`** (clave para el caso "cultura nórdica fidedigna")  
  Explicación fiel y descriptiva. Precisión factual desde el brief
  Wikipedia. Claridad, ejemplos concretos, progresión pedagógica de lo
  básico a lo matizado. **Prohibido** dramatización, diálogo inventado,
  marco narrativo mítico. Voz: profesor cálido seguro explicando a un
  adulto curioso. Estructura: hook (1 dato sorprendente verificado) →
  3-5 secciones temáticas con sub-puntos concretos → resumen + invitación
  a explorar. Imágenes ILUSTRATIVAS (escenas histórico-fieles, artefactos
  reales, localizaciones, figuras clave), NO dramatizaciones cinematográficas.

- **`listicle`**  
  Formato lista "N cosas que no sabías de…" con N entre 5–10 según
  riqueza del tema. Cada ítem numerado explícitamente ("Número cinco:"):
  hecho sorprendente + 1-2 frases contexto + ejemplo concreto. Hook:
  teaser del item más sorprendente. Cierre: recap + CTA a comentar.
  1 imagen por ítem + 1-2 atmosféricas.

- **`comparative`**  
  Comparativa A vs B (el topic nombra ambos, p.ej. "Vikings vs Samurai").
  Estructura: presentar contendientes → 4-6 dimensiones (combate,
  sociedad, religión, tecnología…), para cada dimensión A primero luego
  B → síntesis honesta (quién gana en qué, o "no son realmente
  comparables pero esto significa culturalmente"). Voz analítica,
  equilibrada, sin fanboying. Imágenes alternan A/B por dimensión.

- **`deep_dive`**  
  Análisis profundo de gran formato. Hook "por qué importa este tema" →
  4-8 capítulos cada uno con sub-tesis, desarrollo factual, ejemplos,
  transiciones → síntesis + pregunta abierta. Voz tranquila, profundamente
  curiosa, estilo podcaster que ha hecho los deberes. Grounding estricto
  Wikipedia, fraseo "según el registro histórico". `use_chapters=True`
  engancha directo con el long-form de v0.5.0.

## Tablas de mapeo (literales)

```python
VOICE_TONE_TO_DESCRIPTOR: dict[str, str] = {
    "dramatic":          "epic cinematic narrator, intense emotion",
    "didactic_warm":     "warm patient teacher, clear articulation",
    "narrator_measured": "measured documentary narrator, calm authority",
    "analytical":        "balanced analyst, even pacing",
    "analytical_calm":   "thoughtful host, contemplative",
    "energetic":         "upbeat enthusiastic presenter, fast pace",
}

MUSIC_MOOD_TO_PROMPT: dict[str, str] = {
    "epic":            "cinematic orchestral epic, swelling strings, hero theme",
    "sober":           "subtle documentary score, restrained strings + piano",
    "sober_curiosity": "gentle curious score, soft piano + woodwinds",
    "energetic":       "modern upbeat instrumental, light percussion, no vocals",
    "analytical":      "minimalist thoughtful, soft synth pad + piano",
    "neutral":         "ambient bed, very low, non-distracting",
}

IMAGE_STYLE_BIAS: dict[str, str] = {
    "cinematic":              "cinematic, dramatic lighting, photoreal, atmospheric",  # ← actual byte-idéntico
    "documentary":            "documentary photograph, archive-style, period-accurate, naturalistic",
    "editorial_illustrative": "editorial illustration, encyclopedia-style, clear, period-accurate",
    "editorial_dynamic":      "editorial illustration, dynamic composition, infographic feel",
    "editorial_dual":         "editorial split composition, A vs B framing, clean",
    "editorial_documentary":  "editorial documentary photography, illustrative, period-accurate",
}
```

## UI (Generator)

Nuevo segmented control en `apps/desktop/src/routes/generator.tsx`,
posicionado junto a "Animation preset" (mismo bloque de "Estilo"):

```
Tipo de vídeo
[Narrativa épica] [Documental] [Divulgativo] [Listicle] [Comparativa] [Deep-dive]
```

- Default seleccionado: **Narrativa épica**.
- Cada chip muestra `description_es` en tooltip.
- Persistido en `pipelineStore` draft (mismo store que `animation`, `topic`).
- Enviado como `preset_id` en el `start_generation` IPC.

## Cableado al pipeline (puntos de inyección)

| Componente | Cambio | Notas |
|---|---|---|
| `generator.tsx` | `useState<PresetId>('narrative_epic')` + segmented control + pasa `preset_id` en start_generation | UI nueva, sin tocar el flujo |
| `pipeline/mod.rs` (Rust) | Recibe `preset_id`, lo persiste en project state, lo propaga a cada llamada al sidecar | Lectura simple |
| `routes/script.py::ScriptRequest`/`OutlineRequest` | Nuevo campo `preset_id: str = "narrative_epic"` | Default → retro-compat |
| `generate_script` / `generate_outline` | `system_prompt = preset.llm_style_directive + base_prompt`; usa `target_minutes_default` si el cliente no envía minutos; usa `markers_per_minute` para `expected_min` | Único cambio funcional del prompt LLM |
| `_rewrite_image_prompts_from_narration` | `_STYLE_SUFFIX` ← `IMAGE_STYLE_BIAS[preset.image_style]` | El filtro iconography v0.6.8 se preserva |
| `_inject_auto_image_markers` | Mismo `IMAGE_STYLE_BIAS[preset.image_style]` | Coherencia |
| `routes/music.py` | Prompt seed ← `MUSIC_MOOD_TO_PROMPT[preset.music_mood]` | Reemplaza el hardcoded actual |
| `routes/tts.py` | Voice descriptor enriquecido con `VOICE_TONE_TO_DESCRIPTOR[preset.voice_tone]` | Cuando aplica al TTS clonado |
| Long-form gate (`pipeline/mod.rs`) | Si `preset.use_chapters` → fuerza branch long-form; si no → auto-detect actual por min ≥ 7 | Reutiliza v0.5.0 sin tocar |

## Invariantes (`scripts/parity-check.mjs`)

1. **`narrative_epic` byte-idéntico al comportamiento actual.** El
   `llm_style_directive` del preset + `IMAGE_STYLE_BIAS["cinematic"]` +
   `VOICE_TONE_TO_DESCRIPTOR["dramatic"]` + `MUSIC_MOOD_TO_PROMPT["epic"]`
   deben coincidir letra a letra con los hardcoded actuales en
   `prompts.py` / `_STYLE_SUFFIX` / `tts.py` / `music.py`. **Cero
   regresión** para quien no toque el selector.
2. `presets.PRESETS` tiene exactamente 6 keys: `narrative_epic`,
   `documentary`, `explainer`, `listicle`, `comparative`, `deep_dive`.
3. Cada preset tiene los 11 campos del schema (no `None`/vacíos).
4. `deep_dive.use_chapters == True` (forzado).
5. Cada `preset.voice_tone` está en `VOICE_TONE_TO_DESCRIPTOR`; cada
   `preset.music_mood` está en `MUSIC_MOOD_TO_PROMPT`; cada
   `preset.image_style` está en `IMAGE_STYLE_BIAS`. (Sanity contra
   typos.)
6. `get_preset("unknown_id")` devuelve `narrative_epic` (fallback
   defensivo).

## Tests (`apps/sidecar-py/tests/test_presets.py`)

- `test_all_six_presets_exist_with_required_fields`.
- `test_narrative_epic_is_byte_identical_to_current_behavior`
  (snapshot del system prompt completo + suffix + voice/music descriptors).
- `test_each_preset_keys_resolve_in_mapping_tables`.
- `test_explainer_directive_forbids_dramatization_keywords`
  (assert que "dramatization", "mythic", "epic narrative", "cinematic
  scene" NO aparecen en el `llm_style_directive` del `explainer`).
- `test_documentary_directive_demands_factual_accuracy` (assert que
  "Wikipedia brief" / "factual" / "archive" aparecen).
- `test_unknown_preset_id_falls_back_to_narrative_epic`.
- `test_deep_dive_use_chapters_is_forced_true`.

## Caveat honesto

La validación visual/auditiva final por preset (¿el divulgativo SUENA
a profesor cálido? ¿el documental PARECE documental? ¿las imágenes del
listicle SON dinámicas editoriales?) **solo se confirma generando
vídeos reales con cada preset**. Eso son ~6 generaciones × ~30 min
≈ 3 horas en la 4060 8 GB. La validación estática (parity + tests +
snapshot del prompt) confirma:

- el cableado funciona,
- `narrative_epic` no regresa,
- la directiva LLM tiene las palabras-clave del tono pedido y NO tiene
  las prohibidas.

El **ajuste fino del tono** (¿el "didactic_warm" suena demasiado
infantilizante? ¿el "analytical" demasiado plano?) se itera tras los
primeros vídeos reales por preset. Esto se hace cambiando las strings
en `presets.py` — un solo archivo — sin tocar el resto.

## Out of scope (v0.7.x posterior)

- Mezcla de presets (p.ej. "documental con tono divulgativo") — sería
  una matriz de combinaciones; no se justifica hasta ver uso real.
- Detección automática del preset por el tema (rechazado en
  brainstorming — reglas blandas a Gemma 4B han regresado siempre en
  este proyecto).
- Editor visual de presets para el usuario — los 6 son fijos en v0.7.0.
- Presets de duración (5-min express, 30-min long-form): el campo
  `target_minutes_default` ya es un punto natural de extensión.

## Migración / compatibilidad

- Esquema DB: NO cambia (el `preset_id` se pasa por IPC; no se persiste
  en la DB de proyectos en v0.7.0 — si re-abres un proyecto antiguo se
  asume `narrative_epic`).
- Usuarios existentes: al instalar v0.7.0, su próxima generación sin
  tocar el selector usa `narrative_epic` → comportamiento idéntico.
- Settings: no se añade nada nuevo a settings.tsx; el selector vive en
  generator.tsx.

## Plan siguiente

Una vez aprobado este spec por el usuario:

1. `superpowers:writing-plans` → `docs/superpowers/plans/2026-05-20-video-presets-plan.md`
   con tareas bite-sized (TDD por componente: presets.py + tests →
   parity invariants → cableado script.py → cableado music.py / tts.py
   → UI generator.tsx → Rust pipeline pass-through → CHANGELOG +
   release v0.7.0).
2. Ejecución con `superpowers:subagent-driven-development` (subagente
   por tarea + doble review spec+calidad por tarea — el patrón que
   funcionó en v0.5.0 y v0.6.0).
3. Build local + release.
