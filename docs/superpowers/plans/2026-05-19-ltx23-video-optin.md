# LTX-2.3 Vídeo Real Opt-in (v0.6.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir LTX-2.3 como motor de vídeo real opt-in, triple-gateado (hardware capaz AND modelos instalados AND opt-in explícito), sin alterar en nada el camino por defecto Z-Image+HyperFrames.

**Architecture:** Enfoque C "capa de movimiento": el pipeline de imagen *grounded* (Z-Image + setting_tag + rewrite-from-narration de v0.5.0) NO cambia. Sólo el paso "animar el keyframe" se vuelve engine-aware: si `video_engine==ltx` → LTX-2.3 img2video del keyframe; si no → HyperFrames actual byte-idéntico. Todo aguas abajo (render/mux/timeline/TTS/subs/SEO/Shorts) intacto.

**Tech Stack:** Tauri 2 + Rust (`hardware.rs`, `installer/manifest.rs`, `pipeline/mod.rs`, `commands.rs`, `lib.rs`), Python sidecar (FastAPI `routes/ltx_video.py`, `workflows/*.json`, ComfyUI :8188 + ComfyUI-LTXVideo nodes), React 19 + Zustand (`generator.tsx`, `settings.tsx`, `pipelineStore.ts`, `tauri.ts`).

**Restricciones duras:** GPU-only nunca CPU offload; 100% local cero mock; verificar upstream nombres HF (Task 1, bloqueante); el camino por defecto byte-idéntico (invariante parity); fallback HyperFrames por beat ante cualquier fallo LTX; bundle `pnpm tauri:build` SOLO sin dev server (lección libuv). Ejecución por subagentes con doble review (spec+calidad) por tarea.

---

## File Structure

**Create:**
- `docs/superpowers/ltx23-pinned-facts.md` — hechos verificados upstream (Task 1; consumido por Tasks 3,5).
- `apps/sidecar-py/src/xianxia_ai/routes/ltx_video.py` — ruta FastAPI img2video (espejo de `routes/image.py`).
- `apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json` + `ltx23_video_gguf.json` — plantillas ComfyUI (espejo de `z_image_turbo*.json`).
- `apps/sidecar-py/tests/test_ltx_video.py` — tests puros (parametrización de workflow).

**Modify:**
- `apps/desktop/src-tauri/src/hardware.rs` — `LtxCapability` enum + `ltx_video_capability()`.
- `apps/desktop/src-tauri/src/commands.rs` + `lib.rs` — comando `ltx_capability`.
- `apps/desktop/src-tauri/src/installer/manifest.rs` — `Component` `ltx23-video`.
- `apps/desktop/src-tauri/src/pipeline/mod.rs` — fase visual engine-aware.
- `apps/sidecar-py/src/xianxia_ai/server.py` — registrar router `ltx_video`.
- `apps/desktop/src/lib/tauri.ts` — binding `ltxCapability` + tipo.
- `apps/desktop/src/routes/generator.tsx` + `settings.tsx` — control "Motor de vídeo" gated.
- `scripts/parity-check.mjs` — invariantes nuevos.
- `CHANGELOG.md`, `package.json`×2, `tauri.conf.json`, `Cargo.toml` — v0.6.0.

---

## Phase 0 · Preparación

### Task 0: Rama + baseline verde

**Files:** ninguno.

- [ ] **Step 1: Baseline limpio**

Run: `git -C "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" status --porcelain | wc -l`
Expected: `0`

- [ ] **Step 2: Rama**

```bash
git checkout main && git pull --ff-only origin main
git checkout -b feat/v0.6.0-ltx23-video
```

- [ ] **Step 3: Baseline tests**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | grep "test result:" | head -1`
Expected: `test result: ok. 15 passed` (o más; sin fallos)

---

## Phase 1 · Verificación upstream (BLOQUEANTE — regla del proyecto)

### Task 1: Pinned facts de LTX-2.3 (NO asumir nada)

**Files:**
- Create: `docs/superpowers/ltx23-pinned-facts.md`

- [ ] **Step 1: Verificar contra GitHub/HF (no memoria)**

Investigar y APUNTAR con cita+URL: (a) repo+fichero exacto HF de LTX-2.3 variante **FP8/safetensors 22B** y de **GGUF Q4/Q5/Q8** (repo tipo `Lightricks/LTX-2.3` y/o `unsloth/LTX-2.3-GGUF` — verificar nombres reales y tamaños GB); (b) VAE + text-encoder requeridos (LTX-2.3 exige Gemma-3; nombre/repo/size exactos); (c) versión/commit de `Lightricks/ComfyUI-LTXVideo` compatible con LTX-2.3 + si requiere `ComfyUI-GGUF`; (d) VRAM real mínima medible por variante (FP8 full, GGUF Q8/Q5/Q4) según README oficial + reportes; (e) los nodos ComfyUI exactos para img2video con LTX-2.3 (nombres de clase de nodo). Usar WebFetch sobre las URLs oficiales (github.com/Lightricks/LTX-2, huggingface.co/Lightricks/LTX-2.3, github.com/Lightricks/ComfyUI-LTXVideo, docs.comfy.org LTX).

- [ ] **Step 2: Escribir el pinned-facts**

`docs/superpowers/ltx23-pinned-facts.md` con tabla concreta:
```markdown
# LTX-2.3 pinned facts (verificado upstream YYYY-MM-DD)
| Concepto | Valor exacto | Fuente (URL) |
|---|---|---|
| Repo HF FP8/full 22B | <repo>/<fichero.safetensors> (<GB>) | <url> |
| Repo HF GGUF Q8 | <repo>/<fichero.gguf> (<GB>) | <url> |
| Repo HF GGUF Q5 | ... | ... |
| Repo HF GGUF Q4 | ... | ... |
| VAE | <repo>/<fichero> (<GB>) | <url> |
| Text-encoder (Gemma-3) | <repo>/<fichero> (<GB>) | <url> |
| ComfyUI-LTXVideo | commit/tag <x> | <url> |
| Nodo img2video | <ClaseNodo> | <url> |
| VRAM real FP8 full | <GB> | <url> |
| VRAM real GGUF Q8/Q5/Q4 | <GB>/<GB>/<GB> | <url> |
**Umbrales decididos:** Full ≥ <GB>; Gguf ≥ <GB>; None < <GB>.
```
Decidir los umbrales `Full`/`Gguf`/`None` a partir de los GB verificados + el margen de seguridad del proyecto (la fase LTX debe ser GPU-resident con VRAM libre tras liberar otras fases; recuérdese: el benchmark probó Q2_K 7,4GB pinneó 7.444 MiB y crasheó en 8GB → umbral Gguf debe dejar holgura real, p.ej. ≥ VRAM_modelo + 6GB).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ltx23-pinned-facts.md
git commit -m "docs(ltx): pinned facts verificados upstream (repos/VRAM/nodos)"
```

> Tasks 3 y 5 CONSUMEN este fichero. Si una URL no resuelve o un asset no existe, NO inventar: registrar el bloqueo y escalar (regla verify-upstream).

---

## Phase 2 · Autodetect (Rust, aditivo, testeable solo)

### Task 2: `ltx_video_capability()` + comando Tauri

**Files:**
- Modify: `apps/desktop/src-tauri/src/hardware.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`, `src/lib.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`

- [ ] **Step 1: Test (TDD) en hardware.rs**

Añadir al `#[cfg(test)] mod tests` de `hardware.rs`:
```rust
#[test]
fn ltx_capability_thresholds() {
    use super::{ltx_capability_for_vram, LtxCapability};
    assert_eq!(ltx_capability_for_vram(0.0),  LtxCapability::None);
    assert_eq!(ltx_capability_for_vram(8.0),  LtxCapability::None);   // 4060 8GB: NO
    assert_eq!(ltx_capability_for_vram(16.0), LtxCapability::Gguf);
    assert_eq!(ltx_capability_for_vram(24.0), LtxCapability::Full);
    assert_eq!(ltx_capability_for_vram(48.0), LtxCapability::Full);
}
```
(Los números 16.0/24.0 se ajustan a los **umbrales decididos en Task 1 pinned-facts** si difieren — mantener el test alineado con el fichero de hechos.)

- [ ] **Step 2: Ejecutar (rojo)**

Run: `cd apps/desktop/src-tauri && cargo test --lib ltx_capability 2>&1 | tail -5`
Expected: FAIL (símbolos no definidos).

- [ ] **Step 3: Implementar en hardware.rs**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LtxCapability { None, Gguf, Full }

/// Pure threshold fn (testeable). Umbrales = pinned-facts Task 1.
/// Conservador: la fase LTX debe caber GPU-resident tras liberar las
/// demás fases (regla GPU-only, nunca CPU offload). NUNCA viable en 8GB.
pub fn ltx_capability_for_vram(vram_gb: f64) -> LtxCapability {
    if vram_gb >= 24.0 { LtxCapability::Full }
    else if vram_gb >= 16.0 { LtxCapability::Gguf }
    else { LtxCapability::None }
}

/// Public: capability del HW actual (None si no hay GPU/VRAM).
pub fn ltx_video_capability() -> LtxCapability {
    let hw = detect();                 // reusar la fn de detección existente
    let vram = hw.gpu.as_ref().and_then(|g| g.vram_gb).unwrap_or(0.0);
    ltx_capability_for_vram(vram)
}
```
(Ajustar `detect()`/campo gpu/vram al nombre real existente en hardware.rs — leer el fichero; el patrón de `recommend_models` ya hace exactamente este `vram` lookup, replicarlo.)

- [ ] **Step 4: Comando Tauri**

En `commands.rs` (junto a otros comandos hardware-ish):
```rust
#[tauri::command]
pub fn ltx_capability() -> Result<crate::hardware::LtxCapability, String> {
    Ok(crate::hardware::ltx_video_capability())
}
```
En `lib.rs` `generate_handler!` añadir `commands::ltx_capability,` junto a `hardware::detect_hardware,`.
En `tauri.ts`: `export type LtxCapability = 'none'|'gguf'|'full';` y binding `ltxCapability: () => invoke<LtxCapability>('ltx_capability'),`.

- [ ] **Step 5: Verificar (verde) + tsc**

Run: `cd apps/desktop/src-tauri && cargo test --lib ltx_capability 2>&1 | grep "test result:"` → `ok. 1 passed`
Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio/apps/desktop" && pnpm exec tsc --noEmit 2>&1 | tail -2` → 0 errores

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/hardware.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/tauri.ts
git commit -m "feat(hw): ltx_video_capability() None|Gguf|Full + comando ltx_capability"
```

---

## Phase 3 · Autoinstall (Component opcional)

### Task 3: `Component` `ltx23-video` en manifest

**Files:**
- Modify: `apps/desktop/src-tauri/src/installer/manifest.rs`

- [ ] **Step 1: Leer el patrón real**

Leer `installer/manifest.rs`: la `struct Component` (campos exactos: id, label, category, size_bytes, url, kind, required, depends_on…) y los componentes aislados `acestep`/`depthflow` (cómo declaran descarga + dir destino + opcionalidad). El nuevo componente DEBE seguir ese shape exacto.

- [ ] **Step 2: Añadir el componente (datos de pinned-facts Task 1)**

Añadir un `Component` `id:"ltx23-video"`, `category` la que usen los modelos opcionales, `required:false`, con la(s) URL(s)/fichero(s) EXACTOS del `docs/superpowers/ltx23-pinned-facts.md` (FP8 + GGUF Qx + VAE + text-encoder), destino `runtime/comfyui/models/{diffusion_models,vae,text_encoders}`, y `depends_on` los nodos ComfyUI-LTXVideo. Comentario que cite que es opt-in tier-gated y NO se instala salvo capable+opt-in. Mantener bytes/sizes de pinned-facts. NO inventar URLs — si Task 1 las dejó pendientes, este task está BLOQUEADO hasta resolverlas.

- [ ] **Step 3: cargo check**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -2` → `Finished`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/installer/manifest.rs
git commit -m "feat(installer): Component opcional ltx23-video (opt-in tier-gated)"
```

> El gating real (no auto-instalar salvo capable+opt-in) se cablea en Task 6 (UI) + Task 5 (pipeline resuelve engine). El manifest sólo DECLARA el componente; nada lo descarga automáticamente.

---

## Phase 4 · Autoconfig (workflows + ruta Python)

### Task 4: Workflow templates + `routes/ltx_video.py`

**Files:**
- Create: `apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json`, `ltx23_video_gguf.json`
- Create: `apps/sidecar-py/src/xianxia_ai/routes/ltx_video.py`
- Modify: `apps/sidecar-py/src/xianxia_ai/server.py`
- Create: `apps/sidecar-py/tests/test_ltx_video.py`

- [ ] **Step 1: Test puro (TDD) — parametrización del workflow**

`tests/test_ltx_video.py` (mirror sys.path pattern de `test_chapters.py`):
```python
from xianxia_ai.routes.ltx_video import build_ltx_workflow

def test_build_ltx_workflow_params():
    wf = build_ltx_workflow(
        template="gguf", init_image="/k.png", prompt="a misty peak",
        width=768, height=512, seconds=4.0, fps=24, seed=7,
    )
    s = __import__("json").dumps(wf)
    assert "/k.png" in s and "a misty peak" in s
    # frames = round(seconds*fps) ajustado a la regla LTX (div 8 + 1)
    assert wf["__frames"] == 97
    assert wf["__width"] == 768 and wf["__height"] == 512

def test_frames_rule_div8_plus1():
    from xianxia_ai.routes.ltx_video import ltx_frame_count
    assert ltx_frame_count(4.0, 24) == 97      # 96+1
    assert ltx_frame_count(1.0, 24) == 25      # 24 -> 25
    assert ltx_frame_count(0.0, 24) == 9       # mínimo seguro
```

- [ ] **Step 2: Ejecutar (rojo)**

Run: `cd apps/sidecar-py && python -m pytest tests/test_ltx_video.py -q 2>&1 | tail -3`
Expected: FAIL (módulo ausente).

- [ ] **Step 3: Plantillas workflow**

Crear `ltx23_video.json` (FP8/full) y `ltx23_video_gguf.json` (GGUF) ESPEJO estructural de `z_image_turbo.json`/`_gguf.json` (leerlos primero), usando los nombres de NODO de img2video verificados en pinned-facts (Task 1): loader del modelo (FP8 loader o `UnetLoaderGGUF`), VAE, text-encoder Gemma-3, nodo init-image, LTX img2video sampler/scheduler distilled, save. Placeholders sustituibles `%INIT_IMAGE%`, `%PROMPT%`, `%WIDTH%`, `%HEIGHT%`, `%FRAMES%`, `%FPS%`, `%SEED%`.

- [ ] **Step 4: `routes/ltx_video.py`** (mirror `routes/image.py` submission a ComfyUI :8188)

```python
"""LTX-2.3 img2video — anima un keyframe grounded en un clip.
Mirror de routes/image.py (mismo patrón de submit a ComfyUI :8188).
Best-effort desde el lado Rust: si esto falla, Rust hace fallback a
HyperFrames para ese beat. GPU-only (la VRAM la coordina Rust)."""
from __future__ import annotations
import json, math, pathlib
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
_WF_DIR = pathlib.Path(__file__).resolve().parents[1] / "workflows"

def ltx_frame_count(seconds: float, fps: int) -> int:
    """LTX exige (frames-1) divisible por 8. Mínimo 9."""
    raw = max(1, round(seconds * fps))
    n = ((raw // 8) * 8) + 1
    return max(9, n)

def build_ltx_workflow(template: str, init_image: str, prompt: str,
                        width: int, height: int, seconds: float,
                        fps: int, seed: int) -> dict:
    name = "ltx23_video_gguf.json" if template == "gguf" else "ltx23_video.json"
    raw = (_WF_DIR / name).read_text(encoding="utf-8")
    frames = ltx_frame_count(seconds, fps)
    raw = (raw.replace("%INIT_IMAGE%", init_image.replace("\\", "/"))
              .replace("%PROMPT%", json.dumps(prompt)[1:-1])
              .replace("%WIDTH%", str(width)).replace("%HEIGHT%", str(height))
              .replace("%FRAMES%", str(frames)).replace("%FPS%", str(fps))
              .replace("%SEED%", str(seed)))
    wf = json.loads(raw)
    wf["__frames"] = frames; wf["__width"] = width; wf["__height"] = height
    return wf

class LtxClipRequest(BaseModel):
    template: str = "gguf"          # "gguf" | "full"
    init_image: str
    prompt: str
    width: int = 768
    height: int = 512
    seconds: float = 4.0
    fps: int = 24
    seed: int = 0
    out_path: str

class LtxClipResponse(BaseModel):
    out_path: str
    frames: int

@router.post("/clip", response_model=LtxClipResponse)
async def ltx_clip(req: LtxClipRequest) -> LtxClipResponse:
    wf = build_ltx_workflow(req.template, req.init_image, req.prompt,
                            req.width, req.height, req.seconds, req.fps, req.seed)
    # Submit a ComfyUI EXACTAMENTE como routes/image.py (reusar su helper de
    # submit/poll si existe; si no, replicar su patrón http a 127.0.0.1:8188
    # /prompt + /history). Mux de frames -> out_path con ffmpeg igual que el
    # resto del proyecto. Si ComfyUI/LTX falla -> HTTPException 503 (Rust hará
    # fallback). Implementar reusando el helper real de image.py (leerlo).
    raise NotImplementedError  # reemplazar por la lógica espejo de image.py
```
> El cuerpo de submit/poll/mux DEBE replicarse del helper real que `routes/image.py` ya usa para ComfyUI (leerlo y reusar, DRY). Mantener `build_ltx_workflow`/`ltx_frame_count` puros y testeados (Steps 1-2). El `raise NotImplementedError` se sustituye por el espejo de image.py en este mismo step (no dejar placeholder).

- [ ] **Step 5: Registrar router en server.py**

Junto a `app.include_router(image.router, prefix="/image", ...)` añadir
`app.include_router(ltx_video.router, prefix="/ltx_video", tags=["ltx_video"])`
e importar `ltx_video` en el bloque `from xianxia_ai.routes import (...)`.

- [ ] **Step 6: Verde + import**

Run: `cd apps/sidecar-py && python -m pytest tests/test_ltx_video.py -q 2>&1 | tail -3` → `3 passed`
Run: `python -c "import xianxia_ai.routes.ltx_video as m; assert hasattr(m,'ltx_clip') and hasattr(m,'build_ltx_workflow'); print('ok')"` → `ok`

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar-py/src/xianxia_ai/routes/ltx_video.py apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video_gguf.json apps/sidecar-py/src/xianxia_ai/server.py apps/sidecar-py/tests/test_ltx_video.py
git commit -m "feat(py): /ltx_video/clip img2video + workflows ComfyUI LTX-2.3"
```

---

## Phase 5 · Pipeline engine-aware (el corazón — máximo cuidado)

### Task 5a: Auditar la fase visual actual

**Files:** ninguno (lectura → notas para 5b).

- [ ] **Step 1: Localizar la fase visual + HyperFrames**

Run: `cd apps/desktop/src-tauri && grep -n "HyperFrames\|hyperframes\|ken.?burns\|/depthflow\|beat\|keyframe\|emit(app, pid, [0-9]\|persist_step(pool, pid, [0-9]" src/pipeline/mod.rs | head -40`
Anotar: nº de fase de la imagen/animación, dónde se genera el keyframe Z-Image, dónde HyperFrames/Ken-Burns anima, qué variable lleva el clip por beat, cómo `req` expone opciones (para añadir `video_engine`/opt-in), firma de `run()`, helper de cliente HTTP a sidecars, `ensure_comfyui_vram`, patrón de `persist_step`/`phase_already_done` (v0.5.0) por beat.

### Task 5b: Rama `video_engine` en la fase visual

**Files:**
- Modify: `apps/desktop/src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Resolver `video_engine` (triple-gate) al inicio del pipeline**

Insertar tras resolver hardware/req (adaptar nombres reales de 5a):
```rust
// v0.6.0 — motor de vídeo. DEFAULT SIEMPRE hyperframes (byte-idéntico).
// LTX sólo si: capability != None AND modelos instalados AND opt-in.
let video_engine: &str = {
    let cap = crate::hardware::ltx_video_capability();
    let models_ok = ltx_models_installed();          // chequea ficheros en runtime/comfyui/models (pinned-facts)
    let opted_in = req.use_ltx_video.unwrap_or(false); // nuevo campo opcional del request, default false
    if cap != crate::hardware::LtxCapability::None && models_ok && opted_in {
        "ltx"
    } else {
        "hyperframes"
    }
};
tracing::info!(engine = video_engine, "video engine resuelto");
```
Definir `fn ltx_models_installed() -> bool` (existencia de los ficheros clave de pinned-facts en `paths::paths()?.data_dir/runtime/comfyui/models/...`). Añadir `use_ltx_video: Option<bool>` al struct de request (default None→false; el resto del request intacto).

- [ ] **Step 2: Rama en el paso "animar keyframe"**

Donde HOY se anima el keyframe (HyperFrames), envolver SIN tocar la rama actual:
```rust
let clip_path = if video_engine == "ltx" {
    match ltx_animate_beat(&client, pool, pid, &keyframe_path, &beat_prompt,
                           beat_seconds, is_vertical).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(beat = idx, error = %e,
                "LTX falló — fallback HyperFrames este beat");
            hyperframes_animate_beat(/* args ACTUALES, sin cambios */).await?
        }
    }
} else {
    hyperframes_animate_beat(/* el código HyperFrames ACTUAL, byte-idéntico, movido aquí */).await?
};
```
`ltx_animate_beat`: wake nada-LLM (LTX no es LLM); `ensure_comfyui_vram(...)` + unload de fases previas (patrón existente); POST `http://127.0.0.1:8731/ltx_video/clip` con `{template: gguf|full según capability, init_image: keyframe_path, prompt: beat_prompt, width/height por orientación, seconds: beat_seconds, fps, seed}`; devuelve `out_path`. Reutiliza el cliente HTTP y el patrón `.context(...)?` del resto de fases. Resume: el clip por beat se persiste como artefacto reanudable EXACTAMENTE igual que el still/clip actual (reusar `phase_already_done`/`chapter_state` de v0.5.0; clave de cache incluye `engine` para no mezclar artefactos LTX/HF).

- [ ] **Step 3: cargo check + test (sin romper default)**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -2` → `Finished`
Run: `cargo test 2>&1 | grep "test result:"` → todo ok (≥16 passed; el default no se altera).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/pipeline/mod.rs
git commit -m "feat(pipeline): fase visual engine-aware (LTX opt-in, default byte-idéntico, fallback HF)"
```

---

## Phase 6 · UI (gated, sin mock)

### Task 6: Control "Motor de vídeo"

**Files:**
- Modify: `apps/desktop/src/routes/generator.tsx`, `apps/desktop/src/routes/settings.tsx`
- Modify: `apps/desktop/src/lib/tauri.ts` (ya tiene `ltxCapability` de Task 2; añadir binding `ltxModelsInstalled` si hace falta un comando — si Task 5 expone uno, reusar)

- [ ] **Step 1: Comando `ltx_models_installed` (si no existe)**

En `commands.rs` exponer `#[tauri::command] fn ltx_models_installed() -> bool` reusando la `fn` de Task 5b; registrar en `lib.rs`; binding `ltxModelsInstalled: () => invoke<boolean>('ltx_models_installed')` en tauri.ts.

- [ ] **Step 2: Control en generator.tsx**

Añadir un control "Motor de vídeo" (Imágenes+HyperFrames | LTX‑2.3 vídeo real) que:
- Lee `ltxCapability()` + `ltxModelsInstalled()` vía useQuery (patrón existente en la pantalla).
- Si `capability === 'none'`: NO renderiza el toggle LTX (o lo muestra deshabilitado con texto honesto "Requiere ≥X GB VRAM"). Default Imágenes siempre.
- Si `capability !== 'none'` pero modelos no instalados: muestra botón "Instalar modelos LTX-2.3" que dispara `installOptionalComponent('ltx23-video')` (binding existente); el toggle LTX queda deshabilitado hasta instalar.
- Si capable + instalado: toggle activable; su estado va al request de `startGeneration` como `use_ltx_video` (mapear al campo Rust de Task 5b).
Primitivas Liquid Glass existentes (Toggle/Group/Row), sin partículas, sin datos demo (cero placeholders; si no aplica, no se muestra nada inventado).

- [ ] **Step 3: Espejo breve en settings.tsx**

Sección informativa "Vídeo real (LTX-2.3)" en Ajustes: muestra capability detectada + estado de modelos + botón instalar/borrar, gated igual. Reusa el patrón de las otras secciones de Ajustes.

- [ ] **Step 4: Build**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && pnpm --filter @xianxia/desktop build 2>&1 | tail -3` → `✓ built`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/routes/generator.tsx apps/desktop/src/routes/settings.tsx apps/desktop/src/lib/tauri.ts apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(ui): control Motor de vídeo gated (LTX opt-in, default Imágenes)"
```

---

## Phase 7 · Blindaje + release

### Task 7: Invariantes parity-check

**Files:**
- Modify: `scripts/parity-check.mjs`

- [ ] **Step 1: Añadir checks (estilo del fichero)**

1. `pipeline/mod.rs` contiene la guarda triple (`ltx_video_capability`, `ltx_models_installed`, `use_ltx_video`) y la rama `else` HyperFrames sigue presente (default no eliminado).
2. La rama LTX tiene fallback HyperFrames (`fallback` + `hyperframes_animate_beat` dentro del `Err`).
3. `hardware.rs` define `LtxCapability` y `ltx_capability_for_vram` con 8.0→None (4060 nunca capable).
4. `manifest.rs` tiene Component `ltx23-video` con `required:false`.
5. `routes/ltx_video.py` define `/clip` y `server.py` lo registra; workflows `ltx23_video*.json` presentes.
6. UI: `generator.tsx` no ofrece LTX si capability none (busca el gate `=== 'none'`), sin `Math.random`/`<canvas>`.
7. `docs/superpowers/ltx23-pinned-facts.md` existe (verify-upstream realizado).

- [ ] **Step 2: Ejecutar**

Run: `node scripts/parity-check.mjs 2>&1 | tail -5` → `✓ All parity invariants satisfied.`

- [ ] **Step 3: Commit**

```bash
git add scripts/parity-check.mjs
git commit -m "test: invariantes parity-check v0.6.0 (default intacto, triple-gate, fallback)"
```

### Task 8: Versión + CHANGELOG

**Files:** `CHANGELOG.md`, `package.json`×2, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`

- [ ] **Step 1: Bump**

Run: `node scripts/bump-version.mjs 0.6.0 2>&1 | tail -4` → `✓` en los 4 ficheros.

- [ ] **Step 2: Regenerar Cargo.lock (bump no corre cargo)**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -1` (regenera Cargo.lock a 0.6.0). Verificar `grep -A1 'name = "xianxia-studio"' Cargo.lock` = `0.6.0`.

- [ ] **Step 3: CHANGELOG [0.6.0]**

Bajo `## [Unreleased]` añadir `## [0.6.0] — <fecha>`: LTX-2.3 opt-in tier-gated (enfoque C capa de movimiento); INVARIANTE default Z-Image+HyperFrames byte-idéntico; triple-gate; autoinstall/autodetect/autoconfig; fallback HF; **salvedad honesta: E2E LTX-2.3 NO validado (imposible en la 4060 8GB de dev) — pendiente de validar en HW ≥24-32GB; no se fabricó resultado**; pinned-facts verificados upstream.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "release: v0.6.0 — LTX-2.3 vídeo real opt-in tier-gated"
```

### Task 9: Bundle SOLO + merge + release

**Files:** ninguno.

- [ ] **Step 1: Entorno limpio (lección libuv)**

PowerShell: matar listener :1420 + procesos huérfanos `xianxia_studio/link/cargo/rustc`; confirmar `1420 libre`.

- [ ] **Step 2: Bundle SOLO (background, sin dev server)**

Run: `cd "C:/Users/swon_/OneDrive/Documentos/PROYECTOS/VIBECLAUDE/Xianxia_Studio" && pnpm tauri:build` (background; ningún Vite dev server concurrente).
Expected: exit 0; `Xianxia Studio_0.6.0_x64-setup.exe` en `target/release/bundle/nsis/`.

- [ ] **Step 3: Merge + tag ANOTADO + push**

```bash
git checkout main && git -c credential.helper= -c credential.helper='!gh auth git-credential' pull --ff-only origin main
git merge --no-ff feat/v0.6.0-ltx23-video -m "release: v0.6.0 — LTX-2.3 vídeo real opt-in tier-gated"
git tag -a v0.6.0 -m "v0.6.0 — LTX-2.3 vídeo real opt-in"   # ANOTADO (--follow-tags no empuja ligeros)
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main --follow-tags
```

- [ ] **Step 4: Verificar CI release**

Run: `gh run list --limit 1` (Release v0.6.0 in_progress/success) y tras ~20min `gh release view v0.6.0 --json name,assets -q '.name+" assets:"+(.assets|length|tostring)'` → release con assets firmados.

- [ ] **Step 5: Memoria + Engram**

Actualizar `memory/reference_ltx2_video_gen.md` + `MEMORY.md` + Engram: v0.6.0 LTX-2.3 opt-in shippeada; default intacto; E2E pendiente HW capaz; pinned-facts.

---

## Self-Review

**1. Spec coverage:**
- INVARIANTE default byte-idéntico/triple-gate → Task 5b (resolución engine + else byte-idéntico) + parity Task 7 ✓
- (1) autodetect `ltx_video_capability` → Task 2 ✓
- verify-upstream (umbrales/HF names) → Task 1 (bloqueante, consumido por 3/5) ✓
- (2) autoinstall Component → Task 3 ✓
- (3) autoconfig workflows + ruta Python → Task 4 ✓
- (4) pipeline engine-aware + resume → Task 5a/5b ✓
- (5) coordinación VRAM → Task 5b Step 2 (`ensure_comfyui_vram` + unload) ✓
- (6) UI gated → Task 6 ✓
- (7) fallback HF por beat → Task 5b Step 2 (Err→hyperframes) + parity Task 7 ✓
- (8) parity + cargo/pytest + E2E honesto → Tasks 7/2/4 + Task 8 Step 3 (caveat CHANGELOG) ✓
- (9) versión + CHANGELOG + release CI → Tasks 8/9 ✓

**2. Placeholder scan:** Task 1 es una verificación upstream *necesaria* (no se pueden inventar URLs HF — regla dura del proyecto); produce un fichero de hechos concreto que Tasks 3/5 consumen, con bloqueo explícito si una URL no resuelve. NO es un "TBD" de diseño. Task 4 Step 4 incluye `raise NotImplementedError` PERO el propio step ordena sustituirlo por el espejo real de `routes/image.py` en ese mismo step (no se commitea con el NotImplementedError; el helper de submit/poll/mux se replica del código real existente). Sin otros "TBD/handle edge cases/similar to Task N".

**3. Type consistency:** `LtxCapability {None,Gguf,Full}` (Task 2) usado consistente en Task 5b (`!= LtxCapability::None`), Task 6 (`'none'|'gguf'|'full'` serde lowercase), parity Task 7. `ltx_video_capability()`/`ltx_capability_for_vram()`/`ltx_models_installed()`/`use_ltx_video`/`build_ltx_workflow`/`ltx_frame_count`/`/ltx_video/clip` coherentes entre Tasks 2,4,5,6,7. Comando Tauri `ltx_capability` (Task 2) y `ltx_models_installed` (Task 6 Step 1) registrados en lib.rs. Workflows `ltx23_video.json`/`ltx23_video_gguf.json` mismos nombres en Task 4 y parity Task 7.
