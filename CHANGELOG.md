# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/) y
versionado [SemVer](https://semver.org/) (en este proyecto se aplican
solo bumps PATCH: `0.1.0` → `0.1.1` → `0.1.2`…).

## [Unreleased]

## [0.1.4] — 2026-05-06

### Corregido

- **CORS bloqueaba al webview Tauri 2 en Windows**. La app instalada
  hace fetch desde el origin `http://tauri.localhost` (WebView2),
  pero los sidecars solo permitían `http://localhost:1420` y
  `tauri://localhost`. El selector "Voz narradora" se quedaba en
  «Cargando voces…» indefinidamente y, en silencio, también fallaban
  `/music/backends`, `/engagement/backend` y otros endpoints. Ahora
  los dos sidecars admiten `http(s)://tauri.localhost` y
  `http://asset.localhost` además de los origins de dev.
- **HyperFrames CLI detectado en producción**. `verify_stack` solo
  miraba el path embebido del workspace (`CARGO_MANIFEST_DIR`), que
  no existe en el .exe instalado. Ahora también escanea
  `<data_dir>/runtime/sidecar-node/node_modules/.bin/hyperframes`
  donde la extracción del bundle lo deja.

## [0.1.3] — 2026-05-06

### Corregido

- **Ventanas de terminal ya no parpadean**. Todos los `Command::new`
  (sidecars, `nvidia-smi`, `ffmpeg`, `wmic`, `ollama serve`, `pip
  install`, `npm install`, ComfyUI, etc.) se lanzan ahora con el flag
  `CREATE_NO_WINDOW` en Windows, vía un nuevo trait `HideConsole` en
  `process_ext.rs`. Antes la app spawneaba terminales constantemente
  durante el arranque y la verificación de stack.
- **Sidecars Python y Node ahora arrancan en el .exe instalado**. El
  build pre-empaqueta `apps/sidecar-py/` (sin `__pycache__` ni venv)
  y `apps/sidecar-node/` con sus `node_modules` reales (incluyendo
  HyperFrames CLI y todas las deps materializadas vía npm) como
  recursos del bundle. En el primer arranque (o tras una actualización)
  Rust los extrae a `<data_dir>/runtime/sidecar-{py,node}/` y la
  supervisión los spawnea como cualquier runtime instalado.
- **Versión real en la sidebar**. Antes la cabecera mostraba `v0.1.0`
  hardcodeado; ahora consume `get_app_version` y refleja la versión
  publicada (`v0.1.3`, `v0.1.4`, …).
- **HyperFrames CLI detectable en el .exe**. Al ir el binario dentro
  del bundle de `node_modules/.bin/hyperframes`, el `verify_stack` lo
  encuentra sin necesidad del workspace de desarrollo.

### Cambios internos

- Nuevo módulo `apps/desktop/src-tauri/src/process_ext.rs` con un
  trait `HideConsole` cross-platform (no-op fuera de Windows).
- Nuevo módulo `apps/desktop/src-tauri/src/sidecars/extract.rs` para
  copiar recursos a `runtime/` con marker `.bundle-version`.
- Nuevo script `scripts/prepare-sidecars.mjs` que sanea la estructura
  para Tauri (excluye caches Python, materializa deps Node con npm).
- `pnpm tauri:build` corre `pnpm sidecars:prepare` antes del bundle.

## [0.1.2] — 2026-05-06

### Corregido

- **HyperFrames como motor primario de render** (era la intención
  original del proyecto). El pipeline lo usaba sólo cuando TODOS
  los beats tenían depth layers segmentados, lo que dejaba fuera
  cualquier vídeo con un fallo puntual de `rembg`. Ahora HyperFrames
  se usa siempre que el Node sidecar esté arriba; los beats sin
  depth siguen renderizando con la composición normal (single
  layer + atmospherics + transitions + grade), y el fallback a
  FFmpeg directo queda reservado para cuando el sidecar no
  responde.
- **HyperFrames también para vertical** (1080×1920). El `width`/
  `height` se pasan al template responsive, así que Shorts y
  vídeos verticales se autoeditan con el mismo motor que el
  long-form horizontal.

### Documentación

- README: la fila Stack `Vídeo` se reescribió para reflejar
  HyperFrames como motor primario, FFmpeg como post-pass + fallback.
  Añadidas filas para ComfyUI custom nodes (ComfyUI-GGUF +
  rgthree-comfy) y la stack de visión 2.5D (rembg + onnxruntime +
  MediaPipe + YOLO11n-pose).

## [0.1.1] — 2026-05-06

### Añadido

- **Engagement Phase 11** con Meta TRIBE v2 — análisis fMRI in-silico
  (Yeo 7-network atlas) para detectar valles aburridos y un score
  global 0-100. Auto-fix opcional con cuts DMN + swells auditivos.
- **Smart Shorts standalone** (ruta `/shorts`) — extrae 1-N Shorts
  virales de un MP4 existente con LLM scoring (hook + climax +
  standalone) sin tocar el flujo de generación principal. Drag-and-drop
  + 5 caption styles + sliders count/duración.
- **ACE-Step v1.5** preferido para música, MusicGen-medium como
  fallback automático. Pre-master FFmpeg unificado a -16 LUFS.
- **Voice cloning nativo Qwen3-TTS** — UI en Ajustes para grabar/subir
  clones, panel de gestión, integración con el pipeline.
- **5 caption styles** (xianxia / hormozi / mrbeast / minimal / neon),
  **4 animation presets** (cinematic / dynamic / minimal / dramatic),
  **9 export presets** multi-plataforma (YouTube Shorts/1080p/4K, IG
  Reels/4:5/1:1, TikTok, X, FB Reels) con LUFS específicos.
- **Componentes opcionales autoinstalables** desde Ajustes — TRIBE
  v2 (~12 GB), ACE-Step + MusicGen (~6 GB), Vision stack. Cada card
  detecta el estado, instala con stream de progreso y respawnea el
  sidecar Python automáticamente.
- **UX**: sistema toast + confirmDialog tematizado (sustituye
  `window.alert`/`confirm`), atajos de teclado globales (`d/g/s/l/p/,`
  + `?` ayuda + `Esc` cierra), draft auto-save del Generator en
  localStorage, sidebar agrupada en 4 categorías, Settings con
  accordion `<details>`, Library con engagement panel + heatmap +
  empty state CTAs.
- **Render**: 60 fps + 2× canvas + lanczos downscale, Steadicam sway
  sinusoidal, NVENC p7 + tune hq + spatial-aq, chunked render
  (>12 beats) via concat demuxer.

### Corregido

- `start_generation` fallaba por `missing field use_musicgen` —
  todos los campos opcionales del `GenerateRequest` ahora son
  `#[serde(default)]`.
- Python sidecar aparecía como STOPPED durante TTS — supervisor
  tolerante (puerto bound + child alive ⇒ Running) y synthesis
  envuelto en `asyncio.run_in_executor`.
- 403 Forbidden en `asset.localhost` desde Library — scope del
  protocol expandido con `$HOME/AppData/Roaming/xianxia/**` y
  variantes macOS/Linux para cubrir el path real de ProjectDirs.
- "Abrir carpeta" de la Library — ahora ejecuta `explorer.exe`
  directamente desde Rust (la regex de `shell:open` rechaza paths
  Windows `C:\…`).
- Spawn loops del supervisor por orphan Python bloqueando el puerto
  8731 — `SpawnGuard` con backoff exponencial 0→5→15→30 s.

### Build & release

- Workflow GitHub Actions `.github/workflows/release.yml` que
  compila NSIS .exe + MSI en `windows-latest` al hacer push de un
  tag `v*` o disparar manualmente.
- Branding completo del installer (NSIS header/sidebar + WiX
  banner/dialog) generado desde el logo SVG master con script
  `pnpm installer:assets`.
- Selector de idioma del installer (Spanish + English).
- Licencia bilingüe ES/EN.
- Script `pnpm version:bump` que sincroniza la versión en
  `package.json`, `apps/desktop/package.json`,
  `apps/desktop/src-tauri/tauri.conf.json` y
  `apps/desktop/src-tauri/Cargo.toml`.

## [0.1.0] — 2026-05-05

Primera línea funcional: pipeline 11 fases (guion → metadatos → voz
→ imágenes → música → vídeo → thumbnail → subs → upload → shorts →
engagement), wizard de instalación con auto-detección de hardware,
biblioteca con engagement panel, scheduler, ajustes con OAuth
YouTube, Tauri 2 supervisor de sidecars (Python FastAPI · Node
Fastify · Ollama · ComfyUI), Z-Image-Turbo Q4_K_M GGUF para
inferencia visual en 8 GB VRAM.

[Unreleased]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/SwonDev/Xianxia_Studio/releases/tag/v0.1.0
