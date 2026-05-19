# v0.6.0 — LTX-2.3 vídeo real (opt-in, tier-gated) · Design Spec

**Fecha:** 2026-05-19
**Estado:** Aprobado (enfoque C — "capa de movimiento")
**Autor:** sesión Claude Code + SwonDev

## Contexto

Benchmarks empíricos en la RTX 4060 8GB del usuario (2026-05-19):
- **LTX-2.3 (22B)**: imposible en 8GB. Q2_K (7,4 GB) fijó VRAM en 7.444/8.188
  MiB y crasheó pre-denoise. Oficial: 24-32 GB. Sólo viable en HW potente.
- **LTX-Video 2B v0.9.6**: cabía (pico 5.823 MiB, 7,2× realtime) pero la
  calidad la rechazó el usuario ("basura"). Descartado.

Decisión del usuario: integrar **LTX-2.3 (22B, el de calidad)** como
**opción** para quien tenga hardware capaz; autoinstalable, autodetectable,
autoconfigurable. Alcance: **vídeo completo** (narrativo + Shorts) en HW
capaz si el usuario lo activa.

## INVARIANTE DURO (no negociable)

El método **por defecto/principal es SIEMPRE Z-Image + HyperFrames**, sin
ningún cambio de comportamiento. LTX-2.3 es **estrictamente aditivo** y
**doble-gateado**:

1. `ltx_video_capability() != none` (hardware detectado capaz), **Y**
2. modelos LTX-2.3 instalados, **Y**
3. **opt-in explícito** del usuario por proyecto/ajuste.

Si cualquiera de las tres falla → camino por defecto **byte-idéntico** al
actual. LTX nunca se auto-activa. Cualquier fallo LTX en runtime → fallback
automático a HyperFrames para ese beat. **El programa actual no se altera
en nada.** Esto es un invariante verificado por parity-check.

## Restricciones del proyecto (heredadas)

- **GPU-only**, nunca CPU offload (regla dura). LTX-2.3 sólo se ofrece en
  HW cuya VRAM real lo sostiene GPU-resident; nunca se fuerza en 8GB.
- **100% local, cero mock/datos demo.** UI no muestra LTX si no aplica.
- **Verificar upstream**: nombres exactos de repos/ficheros HF de LTX-2.3
  y de los nodos ComfyUI-LTXVideo se confirman contra GitHub/HF antes de
  escribir el instalador (NO asumir).
- ComfyUI ya en el stack (:8188, runtime en `<data>/runtime/comfyui`,
  patrón workflow `z_image_turbo*.json`); `install_optional_component` +
  `installer/manifest.rs::Component` (patrón aislado acestep/depthflow);
  `hardware.rs` tier router; `ensure_comfyui_vram` VRAM-gate.

## Arquitectura — enfoque C: "capa de movimiento"

Se conserva **íntegro** el pipeline de imagen ya *grounded* (Z-Image +
setting_tag + rewrite-from-narration de v0.5.0 — reglas duras de fidelidad
imagen/narración). El cambio es **únicamente el paso "animar el keyframe"**:

```
por cada beat:
  keyframe = Z-Image grounded (SIN CAMBIOS, igual que hoy)
  if video_engine == "ltx":   clip = LTX-2.3 img2video(keyframe, prompt_grounded, beat_dur)
  else (default):             clip = HyperFrames Ken-Burns/parallax(keyframe)   ← actual
→ render/mux/timeline/TTS/música/subs/SEO/Shorts: SIN CAMBIOS (ya operan sobre clips)
```

HyperFrames pasa a ser el animador *fallback*; LTX el *premium*. Punto de
decisión único; todo aguas abajo intacto. img2video (no text2video) para
preservar el grounding: LTX anima un keyframe ya correcto, no inventa.

## Componentes

### 1. Autodetect — `hardware.rs::ltx_video_capability()`

Nueva función dedicada (NO reusar el tier de LLM). Devuelve enum
`LtxCapability { None, Gguf, Full }` según VRAM real:
- `Full` (FP8/safetensors 22B): VRAM ≥ umbral_full
- `Gguf` (GGUF Qx 22B): VRAM ≥ umbral_gguf
- `None`: por debajo → LTX no se ofrece
Los umbrales exactos se fijan tras **verificar upstream** los requisitos
reales de cada variante (Q4/Q5/Q8/FP8) de LTX-2.3 — placeholder de diseño:
`Full ≥ 24 GB`, `Gguf ≥ 16 GB`, validar antes de implementar. Expuesto a
la UI vía un comando Tauri (`ltx_capability`) + si los modelos están
instalados.

### 2. Autoinstall — `Component` opcional `ltx23-video`

Nueva entrada en `installer/manifest.rs` mirando el patrón aislado de
acestep/depthflow. Descarga, **sólo cuando capable + opt-in**, la variante
adecuada (Full si capability==Full, GGUF Qx si ==Gguf) de LTX-2.3 a
`runtime/comfyui/models/{diffusion_models,vae,text_encoders}` + asegura los
nodos `ComfyUI-LTXVideo` (+ ComfyUI-GGUF si GGUF). Nombres de repo/fichero
HF **verificados upstream** en la fase de plan. Reusa el flujo
`install_optional_component` + barra de progreso existente. Idempotente;
re-instalable; fallback si ausente (no se ofrece LTX).

### 3. Autoconfig — plantillas de workflow ComfyUI

`apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json` y
`ltx23_video_gguf.json` (espejo de `z_image_turbo*.json`). Una ruta Python
(`routes/ltx_video.py`, espejo de cómo `image.py` arma/envía a ComfyUI)
parametriza por beat: init image = keyframe grounded en disco, prompt =
prompt grounded del beat, duración = duración real del beat, resolución y
fps por capability/orientación (horizontal/vertical Short). Devuelve el
clip mp4/secuencia para que el render lo trate igual que un clip
HyperFrames.

### 4. Integración pipeline — `pipeline/mod.rs`

La fase visual se vuelve *engine-aware*. `video_engine` se resuelve UNA
vez al inicio: `ltx` sólo si los 3 gates pasan; si no, `hyperframes`
(rama actual sin tocar). El bucle por beat añade la rama `ltx` (llamada a
`/ltx_video` con el keyframe ya generado); la rama `else` es el código
HyperFrames actual byte-idéntico, sólo movido a `else`. Persistencia/resume
(v0.5.0 `phase_already_done`, `chapter_state`) siguen aplicando: un clip
LTX por beat se cachea como artefacto reanudable igual que los stills.

### 5. Coordinación VRAM

LTX-2.3 es muy pesado. Reusa `ensure_comfyui_vram` + la disciplina
GPU-only de liberar las demás fases (LLM/TTS/música/whisper) antes de la
fase de vídeo LTX (patrón ya existente en el pipeline). En HW capaz la
VRAM es grande, pero el gate y el unload se aplican igual por robustez.

### 6. UI

Control "Motor de vídeo" (Imágenes+HyperFrames | LTX-2.3 vídeo real) en
Generador y Ajustes. **Visible/activable sólo** si
`ltx_video_capability() != None` **y** modelos instalados; si no, oculto o
deshabilitado con explicación honesta ("requiere ≥X GB VRAM" / "instalar
modelos"). Default = Imágenes. Liquid Glass, sin partículas, sin datos
demo. Botón de instalación de los modelos LTX dentro del flujo de
componentes opcionales existente, sólo si capable.

### 7. Fallback

Cualquier fallo en la fase LTX (OOM, timeout, modelos ausentes, error
ComfyUI) → log `warn` + **fallback automático a HyperFrames para ese
beat**, el vídeo se completa igual. Best-effort, mismo patrón que SEO/
watermark/postprocess del proyecto. Nunca rompe una generación.

## Flujo de datos

`start_generation` → resolver `video_engine` (3 gates) → … fases sin
cambios … → fase visual: keyframe Z-Image grounded (sin cambios) →
[engine==ltx → POST /ltx_video(keyframe,prompt,beat_dur) ; else →
HyperFrames] → render/mux/subs/SEO/Shorts sin cambios.

## Manejo de errores / resume

- Modelos no instalados / capability None / opt-in off → engine=hyperframes
  (camino por defecto, sin error).
- Fallo LTX por beat → fallback HyperFrames ese beat (best-effort).
- Resume: clips LTX por beat son artefactos reanudables (reusa
  `phase_already_done`/`chapter_state` de v0.5.0).

## Testing

- **parity-check**: invariantes nuevos — (a) el camino por defecto
  (engine=hyperframes) es byte-idéntico (no se altera la fase visual
  cuando no hay LTX); (b) LTX triple-gateado (capability AND modelos AND
  opt-in); (c) fallback HyperFrames presente en la rama LTX; (d) `Component`
  ltx23-video sólo se autoinstala si capable+opt-in; (e) workflows LTX
  presentes; (f) UI no ofrece LTX si capability None (sin mock).
- **cargo test / pytest**: capability thresholds, parsing workflow,
  resolución del engine (los 3 gates), fallback.
- **E2E real (HONESTO)**: la generación LTX-2.3 NO se puede validar en la
  4060 8GB de desarrollo (probado: imposible). Se entrega un script de
  smoke + se **documenta como pendiente de validar en HW capaz** (≥24-32
  GB); no se fabrica ningún resultado. El camino por defecto sí se valida
  E2E como siempre.

## Compatibilidad

Aditivo y triple-gateado: en HW no capaz o sin opt-in, **cero cambios de
comportamiento**. Contratos aguas abajo intactos (clips → render/mux).
Reusa instalador/ComfyUI/tier/VRAM-gate existentes. v0.5.0 (long-form
chapters) intacto y compatible (LTX anima los keyframes de cada
capítulo igual).

## Fuera de alcance (YAGNI)

- text2video puro (se usa img2video para preservar grounding).
- Edición manual del clip / re-roll por beat desde UI (futuro).
- LTX en 8GB vía offload (prohibido por regla dura; descartado con datos).
- Optimización de throughput para narrativos largos en LTX (el usuario
  acepta el coste en HW capaz; no se optimiza prematuramente).
