# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/) y
versionado [SemVer](https://semver.org/) (en este proyecto se aplican
solo bumps PATCH: `0.1.0` → `0.1.1` → `0.1.2`…).

## [Unreleased]

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

[Unreleased]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/SwonDev/Xianxia_Studio/releases/tag/v0.1.0
