# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/) y
versionado [SemVer](https://semver.org/) (en este proyecto se aplican
solo bumps PATCH: `0.1.0` → `0.1.1` → `0.1.2`…).

## [Unreleased]

## [0.1.9] — 2026-05-06

### Corregido — ComfyUI cache-hit infinito

Generaciones reales con v0.1.8 expusieron un bug que se manifestaba
como pipeline colgado en Phase 4 imagen 2:

- `image.py` invocaba `xianxia_workflow(..., seed=req.seed or 42)`. Si
  el cliente Rust no pasaba `seed` (caso por defecto), TODAS las
  imágenes usaban `seed=42`. ComfyUI considera workflow + seed
  + prompt como clave de cache; si dos prompts colisionan o son
  idénticos en algún sub-paso, ComfyUI marca todos los nodos como
  `execution_cached` y devuelve `outputs: {}` con `status_str=success`.
  El sidecar entraba a poll eternal en /history porque nunca veía
  outputs y eventualmente disparaba el timeout 1800s.
- Fix: `secrets.randbelow(2**31)` genera seed nuevo por request si el
  cliente no lo fija. Imposible cache-hit por colisión de seed.
- Fix de robustez complementario: `comfyui_client.wait_for_image`
  detecta el caso `status=success + outputs={}` (cache-hit residual
  por cualquier otro motivo) y recupera el output buscando la última
  `xianxia_*.png` modificada en el output dir. Si tampoco encuentra
  nada, lanza `RuntimeError` explícito en vez de colgar.

## [0.1.8] — 2026-05-06

### Corregido — pipeline ahora completa de extremo a extremo

Versión consolidada que corrige la cadena de fallos identificada en
generaciones reales: ffmpeg fuera del PATH del sidecar, race condition
HyperFrames vs fallback FFmpeg, traducción de subs abortando el
pipeline, burn-in mudo, sidecar Node huérfano sobreviviendo a los
auto-updates, y varios bugs UI.

#### Las cuatro leyes Auto sobre ffmpeg

- **Autoinstalable**: el manifest del wizard descarga ffmpeg-essentials
  8.0 (gyan.dev) a `runtime/ffmpeg/bin/` cuando el sistema no lo tiene.
- **Autodetectable**: `verify_stack` lo encuentra en runtime,
  `node_modules/.bin/`, PATH del sistema, o WinGet Links — en ese
  orden, devolviendo la primera ruta válida.
- **Autoconfigurable**: el supervisor Rust calcula un PATH ampliado en
  cada `spawn_python()`/`spawn_node()`/`spawn_comfyui()` que prepende
  `runtime/ffmpeg/bin`, `runtime/sidecar-node/node_modules/.bin`,
  `runtime/python/python` y `LOCALAPPDATA/Microsoft/WinGet/Links` al
  PATH heredado, garantizando que cualquier `subprocess.run("ffmpeg")`
  o `execa("ffmpeg")` funcione sin importar la instalación del usuario.
- **Autorreparable**: el sidecar Python autoinyecta el PATH
  (`server.py`) en su entorno como cinturón y tirantes; los endpoints
  de render usan `execa({preferLocal:true})` para que HyperFrames
  encuentre ffmpeg via `node_modules/.bin/`.

#### HyperFrames como motor principal sin race

`Phase 6` esperaba a que el archivo `out_path` apareciera con un único
check. En discos lentos eso disparaba el fallback a FFmpeg directo
incluso cuando HyperFrames había triunfado, perdiendo el parallax 2.5D
y las atmospherics. Ahora `try_hyperframes_render` poll cada 2 s hasta
30 s antes de declarar fallo, y el fallback FFmpeg solo se activa
cuando realmente HyperFrames no produjo nada.

#### Phase 8 subtitles autorreparable

- `_translate_entries` ahora captura excepciones por entrada (Ollama
  500 al traducir es típico cuando ComfyUI acaba de liberar VRAM) y
  reintenta una vez tras 8 s. Si vuelve a fallar, devuelve la entrada
  en inglés como fallback. El endpoint `/subtitles` ya nunca devuelve
  500 por traducción rota.
- `/subtitles/burn-in` valida que el MP4 generado existe y pesa más
  de 1 KB. Antes ffmpeg podía retornar exit 0 con archivo vacío en
  rare quirks NVENC y nadie se daba cuenta.
- En el lado Rust, Phase 8 burn-in es non-fatal: si falla, deja el
  vídeo sin subs como `final_video` con un toast informativo en vez
  de abortar el pipeline.

#### Workflow Z-Image-Turbo con text encoder GGUF

- `z_image_turbo_gguf.json` carga el text encoder Qwen3-4B vía
  `CLIPLoaderGGUF` (custom node ComfyUI-GGUF) usando
  `Qwen_3_4b-imatrix-IQ4_XS.gguf` (~2.2 GB) en lugar del
  `qwen_3_4b_fp8_mixed.safetensors` (~5.4 GB) anterior.
- En tarjetas de 8 GB VRAM esto elimina el thrashing entre Z-Image
  Turbo Q4_K_M y el text encoder: los step times bajan de ~95 s/step
  a ~7-8 s/step (12× más rápido por imagen).
- El manifest entry `z-image-comfy-clip` apunta al GGUF; el wizard lo
  descarga automáticamente desde
  `worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF`.

#### Más fixes

- **`kill_orphan_sidecars`** ahora identifica orphans con criterio
  dual: exe path bajo `<data_dir>/runtime/` O cmdline que apunte ahí.
  El fix anterior dejaba viva una `node.exe` del sistema corriendo
  `runtime/sidecar-node/dist/server.js` tras un auto-update.
- **Botón "Cancelar generación"** en Generator + comando
  `abort_generation` que cancela el JoinHandle del pipeline y marca
  el proyecto como `cancelled`.
- **Sidebar y updater-panel comparten cache de versión**
  (`tauri.getAppVersion` con queryKey `app-version`), eliminando el
  bug `v[object Object]` que aparecía cuando los dos componentes
  fetcheaban la misma key con shapes distintos.
- **`init_memory_pool`** ahora usa `sqlite:file::memory:?cache=shared`
  para que las 4 conexiones del pool compartan el mismo schema.
  Antes cada conexión tenía su propia DB y los `INSERT INTO
  pipeline_steps` fallaban con "no such table" en mid-pipeline cuando
  el setup caía al fallback en memoria.

## [0.1.7] — 2026-05-06

### Corregido

- **HyperFrames vuelve a funcionar como motor primario de render**.
  La integración estaba escrita para una API anterior a HyperFrames 0.4
  (cuando aceptaba un `.html` suelto). En 0.4.45 el CLI exige un
  *directorio de proyecto* con `index.html` + `hyperframes.json` +
  `meta.json` y un schema lint estricto en el HTML
  (`data-composition-id`, `data-width`, `data-height`, registry de
  timeline en `window.__timelines`, sin `Math.random()`, sin selectores
  con template literals). Las tres plantillas (`narrative.html`,
  `short.html`, `thumbnail.html`) están reescritas al nuevo schema; el
  sidecar Node ahora hace **scaffold del project dir + staging de
  todos los assets** (narración, música, imágenes, capas de
  profundidad) dentro de `assets/` para que Chromium los cargue
  (antes los `file://` absolutos eran bloqueados por la sandbox).
- **Fallback automático a FFmpeg si HyperFrames falla**. El pipeline
  ya nunca aborta en Phase 6: intenta HyperFrames, valida que el MP4
  exista en disco después del 200 OK, y solo si no llega cae a
  `/render` del sidecar Python (zoompan + xfade + NVENC + grade
  cinematic). El emit final reporta el motor real usado.
- **Phase 7 (thumbnail) ya no aborta el pipeline**. Si Z-Image se
  cuelga por VRAM thrashing o el render Node falla, el pipeline
  extrae un frame del MP4 generado vía FFmpeg y lo usa como
  thumbnail. Antes un timeout en thumbnail tiraba toda la
  generación. Además ahora liberamos la VRAM (`/unload?target=tts`,
  `/unload?target=music`) antes de invocar ComfyUI para el thumbnail,
  lo que reduce el step de ~95 s a ~7 s.

## [0.1.6] — 2026-05-06

### Corregido

- **Pipeline ya no muere en Fase 2 (Metadatos)**. Gemma 4 a veces
  anidaba `tags` y `chapters` *dentro* del dict `description` en vez
  de ponerlos al nivel superior, lo que reventaba la validación
  Pydantic con un 500 que el cliente Rust traducía como
  `error decoding response body`. Ahora el handler normaliza la
  respuesta del LLM tolerando: `tags` como string CSV o como lista,
  `chapters` como lista o vacío, y `description` con claves no-idioma
  promovidas automáticamente al nivel superior. El pipeline avanza a
  TTS aunque el LLM se desvíe del schema.

## [0.1.5] — 2026-05-06

### Corregido

- **Sidecars huérfanos tras auto-update se cierran solos**. Cuando el
  updater pasivo aplicaba v0.1.X → v0.1.X+1, el `.exe` nuevo arrancaba
  pero los procesos `python.exe` / `node.exe` lanzados por la versión
  anterior seguían ocupando los puertos 8731/8732/8188 con código
  obsoleto (p. ej. el CORS de v0.1.3 no tenía `tauri.localhost`, así
  que «Cargando voces…» no se desbloqueaba pese al fix). El nuevo
  setup llama a `kill_orphan_sidecars()`: identifica todos los
  procesos cuyo ejecutable vive dentro de `<data_dir>/runtime/` y los
  termina, así el supervisor nuevo siempre toma puertos limpios.
- **`state not managed for field 'pool' on command 'start_generation'`**.
  El pool SQLite se inicializaba en una tarea `spawn` y, si el usuario
  pulsaba «Iniciar generación» antes de que terminara, el comando
  fallaba con ese error. Ahora la inicialización se hace bloqueante
  en el `setup` (~1-2 s) y, si SQLite falla por permisos / FS,
  caemos a un pool en memoria con migraciones aplicadas para que
  la UI siga operativa hasta el siguiente arranque.
- **Texto del clip de Qwen3-TTS ajustado a 3-15 s**. La doc oficial
  permite «rapid voice clone» desde 3 s; antes la UI sugería 5-15 s
  innecesariamente.
- **Botón «Ideas IA» informa cuando falla**. Si el endpoint
  `/script/suggest` no responde (servicio caído, LLM timeout) ahora
  se muestra un toast con la causa concreta en vez de quedarse en
  silencio.

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
