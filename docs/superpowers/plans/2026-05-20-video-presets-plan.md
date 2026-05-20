# v0.7.0 · Video Presets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recomendado) o
> `superpowers:executing-plans` para ejecutar este plan tarea por
> tarea. Pasos `- [ ]` para tracking.

**Goal:** Introducir un selector "Tipo de vídeo" con 6 presets
(narrative_epic default, documentary, explainer, listicle, comparative,
deep_dive) que afecte coherentemente al guion + voz + imágenes +
música, sin tocar el motor de generación.

**Architecture:** Módulo central `apps/sidecar-py/src/xianxia_ai/presets.py`
con un `PRESETS: dict[str, VideoPreset]` y 3 tablas de mapeo
(`VOICE_TONE_TO_DESCRIPTOR`, `MUSIC_MOOD_TO_PROMPT`, `IMAGE_STYLE_BIAS`).
5 puntos de inyección consultan el preset por id; el `narrative_epic`
default es byte-idéntico al comportamiento actual.

**Tech Stack:** Python 3.11 + FastAPI (sidecar), Rust + Tauri 2
(supervisor/pipeline), React 19 + TanStack (UI).

**Reference spec:** `docs/superpowers/specs/2026-05-20-video-presets-design.md`

---

### Task 0: Rama feature + baseline

**Files:** (no source changes, solo git)

- [ ] **Step 1**: Crear rama `feat/v0.7.0-video-presets` desde `main`.

```bash
git checkout main && git checkout -b feat/v0.7.0-video-presets
```

- [ ] **Step 2**: Verificar baseline verde antes de tocar nada.

```bash
cd apps/sidecar-py && python -m pytest tests/ -q
cd ../.. && pnpm --filter @xianxia/desktop build
node scripts/parity-check.mjs
```

Esperado: tests sidecar verde (22/22 actualmente), build OK, parity OK.

---

### Task 1: Módulo `presets.py` + tests unitarios

**Files:**
- Create `apps/sidecar-py/src/xianxia_ai/presets.py`
- Create `apps/sidecar-py/tests/test_presets.py`

**Dependencia previa**: leer los hardcoded actuales para clavar
`narrative_epic` byte-idéntico — `apps/sidecar-py/src/xianxia_ai/prompts.py`
(system prompt) y `apps/sidecar-py/src/xianxia_ai/routes/script.py:740`
(`_STYLE_SUFFIX`).

- [ ] **Step 1**: Leer el system prompt actual de `prompts.py` y el
      `_STYLE_SUFFIX` de `script.py`. Copiarlos textualmente al spec del
      `narrative_epic.llm_style_directive` y al
      `IMAGE_STYLE_BIAS["cinematic"]`.

- [ ] **Step 2**: Escribir `presets.py` con:
  - `@dataclass(frozen=True) class VideoPreset` (11 campos del schema).
  - `VOICE_TONE_TO_DESCRIPTOR`, `MUSIC_MOOD_TO_PROMPT`, `IMAGE_STYLE_BIAS`
    (las 3 tablas literales del spec).
  - `PRESETS: dict[str, VideoPreset]` con las 6 entradas pobladas.
  - `def get_preset(id: str) -> VideoPreset` con fallback a
    `narrative_epic`.

- [ ] **Step 3**: Escribir `test_presets.py` con 7 tests del spec:
  - `test_all_six_presets_exist_with_required_fields`
  - `test_narrative_epic_directive_matches_current_prompts_py`
  - `test_each_preset_keys_resolve_in_mapping_tables`
  - `test_explainer_directive_forbids_dramatization_keywords`
  - `test_documentary_directive_demands_factual_accuracy`
  - `test_unknown_preset_id_falls_back_to_narrative_epic`
  - `test_deep_dive_use_chapters_is_forced_true`

- [ ] **Step 4**: Ejecutar tests, ajustar hasta verde.

```bash
cd apps/sidecar-py && python -m pytest tests/test_presets.py -q
```

- [ ] **Step 5**: Commit.

```bash
git add apps/sidecar-py/src/xianxia_ai/presets.py apps/sidecar-py/tests/test_presets.py
git commit -m "feat(presets): central VideoPreset registry + tests (no wiring yet)"
```

---

### Task 2: Invariantes de parity para presets

**Files:** Modify `scripts/parity-check.mjs`

- [ ] **Step 1**: Añadir bloque de invariantes con los 6 ids esperados,
      todos los campos no-vacíos, `deep_dive.use_chapters=True`, todos
      los `voice_tone`/`music_mood`/`image_style` resuelven en sus
      tablas.

- [ ] **Step 2**: Añadir invariante "narrative_epic byte-idéntico":
      cargar `presets.py` (parsear o evaluar literal-equivalent del
      `llm_style_directive`) y assert que coincide con el system prompt
      actual de `prompts.py`. (Si parsing es frágil, alternativa:
      checkear que cierta substring crítica está en ambos.)

- [ ] **Step 3**: Ejecutar parity, debe pasar.

```bash
node scripts/parity-check.mjs
```

- [ ] **Step 4**: Commit.

---

### Task 3: Cableado `/script` y `/outline`

**Files:** Modify `apps/sidecar-py/src/xianxia_ai/routes/script.py`

- [ ] **Step 1**: Añadir `preset_id: str = "narrative_epic"` a
      `ScriptRequest` y `OutlineRequest` (pydantic).

- [ ] **Step 2**: En `generate_script` y `generate_outline`, al inicio:
      `preset = get_preset(req.preset_id)`. Usar
      `preset.llm_style_directive` para componer el system prompt en
      lugar del hardcoded.

- [ ] **Step 3**: Usar `preset.target_minutes_default` si
      `req.target_minutes` es 0/None; usar
      `preset.markers_per_minute` en el cálculo de `expected_min` en
      `_finalize_script` (línea 493).

- [ ] **Step 4**: Tests de regresión: un test que verifica que con
      `preset_id="narrative_epic"` el system prompt resultante coincide
      con el actual.

- [ ] **Step 5**: Commit.

---

### Task 4: Cableado image-style

**Files:** Modify `apps/sidecar-py/src/xianxia_ai/routes/script.py`

- [ ] **Step 1**: `_rewrite_image_prompts_from_narration` y
      `_inject_auto_image_markers` reciben `preset_id` (o el
      `image_style` resuelto).

- [ ] **Step 2**: Reemplazar el uso del constante `_STYLE_SUFFIX`
      hardcodeado por `IMAGE_STYLE_BIAS[preset.image_style]`. El
      `_STYLE_SUFFIX` actual queda como `IMAGE_STYLE_BIAS["cinematic"]`
      para preservar narrative_epic byte-idéntico.

- [ ] **Step 3**: Test: con preset narrative_epic, el suffix usado es
      `_STYLE_SUFFIX` actual exacto (byte-idéntico).

- [ ] **Step 4**: Commit.

---

### Task 5: Cableado música

**Files:** Modify `apps/sidecar-py/src/xianxia_ai/routes/music.py`

- [ ] **Step 1**: Añadir `preset_id` al request body. Usar
      `MUSIC_MOOD_TO_PROMPT[preset.music_mood]` como prompt seed para
      ACE-Step / MusicGen, reemplazando el seed hardcoded actual.

- [ ] **Step 2**: Test: con narrative_epic el seed coincide con el
      actual ("cinematic orchestral epic, …").

- [ ] **Step 3**: Commit.

---

### Task 6: Cableado voz TTS

**Files:** Modify `apps/sidecar-py/src/xianxia_ai/routes/tts.py`

- [ ] **Step 1**: Añadir `preset_id` al request. Enriquecer el voice
      descriptor con `VOICE_TONE_TO_DESCRIPTOR[preset.voice_tone]`
      (apéndice como guidance hint al descriptor de voz, no reemplaza
      la voz seleccionada).

- [ ] **Step 2**: Test: con narrative_epic el descriptor sigue siendo
      compatible con el comportamiento actual.

- [ ] **Step 3**: Commit.

---

### Task 7: Long-form gate

**Files:** Modify `apps/desktop/src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1**: La estructura de request del pipeline recibe
      `preset_id: String`. Lo persiste en project state.

- [ ] **Step 2**: La rama long-form/short-form ahora consulta también
      `preset.use_chapters`: si True, fuerza long-form aunque
      target_minutes < 7. Si False, mantiene auto-detect por minutos
      (actual).

- [ ] **Step 3**: Pasar `preset_id` a cada llamada al sidecar:
      `/script`, `/outline`, `/music`, `/tts`, etc.

- [ ] **Step 4**: `cargo check` verde.

- [ ] **Step 5**: Commit.

---

### Task 8: UI selector en Generator

**Files:** Modify `apps/desktop/src/routes/generator.tsx` (+ posiblemente
`apps/desktop/src/lib/pipelineStore.ts`)

- [ ] **Step 1**: Tipo `PresetId = 'narrative_epic' | 'documentary' |
      'explainer' | 'listicle' | 'comparative' | 'deep_dive'`. Estado
      local `videoPreset: PresetId` (default `narrative_epic`).
      Persistido en draft del pipelineStore.

- [ ] **Step 2**: Segmented control nuevo en el bloque "Estilo" (junto
      al Animation preset actual):
      `Tipo de vídeo: [Narrativa épica] [Documental] [Divulgativo]
      [Listicle] [Comparativa] [Deep-dive]`.
      Tooltip con `description_es` (replicar las descripciones del spec
      en una constante TS).

- [ ] **Step 3**: Enviar `preset_id: videoPreset` en el comando Tauri
      `start_generation`.

- [ ] **Step 4**: `pnpm --filter @xianxia/desktop build` verde (tsc +
      vite).

- [ ] **Step 5**: Commit.

---

### Task 9: Documentación + invariantes finales

**Files:** Modify `CHANGELOG.md`; modify `scripts/parity-check.mjs`

- [ ] **Step 1**: CHANGELOG entry para v0.7.0 (entrada bonita
      describiendo los 6 presets como feature mayor).

- [ ] **Step 2**: Invariante de parity adicional: assert que
      `generator.tsx` envía `preset_id` en el comando start_generation
      (regex match sobre el código).

- [ ] **Step 3**: Verificar todo el conjunto en verde:
  - `pnpm --filter @xianxia/desktop build` ✓
  - `cd apps/sidecar-py && python -m pytest tests/ -q` ✓
  - `cd apps/desktop/src-tauri && cargo check --quiet` ✓
  - `node scripts/parity-check.mjs` ✓

- [ ] **Step 4**: Commit.

---

### Task 10: Release v0.7.0

**Files:** version files (`package.json`, `apps/desktop/package.json`,
`apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`)

- [ ] **Step 1**: `node scripts/bump-version.mjs 0.7.0`.

- [ ] **Step 2**: `cargo check` para regenerar `Cargo.lock` con la
      versión nueva.

- [ ] **Step 3**: Commit final del bump + CHANGELOG en la rama feature.

- [ ] **Step 4**: Merge a `main` con `--no-ff`, tag anotado `v0.7.0` en
      el merge commit, push con `--follow-tags` (credencial helper
      SwonDev). Borrar rama feature.

- [ ] **Step 5**: Matar `:1420` + huérfanos. `pnpm tauri:build` local
      (NSIS firmado). Verificar `.exe` en `target/release/bundle/nsis/`.

- [ ] **Step 6**: Guardar memoria + Engram (`feat/v0.7.0` decision +
      bugfix_catalog si hay aprendizajes).

---

## Self-Review checklist (per writing-plans)

- ✅ Cada tarea tiene archivos exactos + pasos numerados.
- ✅ Sin placeholders ("TBD/TODO/ajustar después").
- ✅ Consistencia: `narrative_epic` byte-idéntico es invariante
  repetido en T1, T2, T3, T4, T5, T6 — todos coherentes.
- ✅ Scope: 11 tareas, una sola subsistema (presets pipeline). Cabe en
  un solo plan sin descomposición.
- ✅ Sin ambigüedad: cada step dice el archivo y la acción concreta.

## Riesgos conocidos

- **Narrative_epic byte-idéntico es la línea roja**. Si en T1 no se
  consigue clavar al 100% el llm_style_directive contra el current
  prompts.py, parar y refinar antes de seguir. Invariante en T2 lo
  blinda.
- **`preset_id` opcional por defecto**: el campo en pydantic con
  default `"narrative_epic"` garantiza que cualquier cliente antiguo
  (UI no actualizada todavía, o re-build parcial) sigue funcionando
  como hoy.
- **Sidecar bundle vs source**: el sidecar runtime se extrae del
  bundle en cada lanzamiento. Tras v0.7.0 ese bundle traerá
  `presets.py` nuevo. Test post-instalación: el primer launch debe
  extraer el módulo correctamente (smoke check al iniciar la app
  tras instalar).
- **Validación visual por preset = pendiente real**: solo se confirma
  con 6 generaciones reales. La release v0.7.0 deja el motor
  funcionando para todos; el ajuste fino del tono por preset se hace
  iterando sobre `presets.py` en versiones 0.7.x posteriores.
