# 🐉 Xianxia Studio

Aplicación de escritorio para producción automatizada de contenido YouTube de mitología china, xianxia, wuxia y lore del cultivo. Todo el procesamiento de IA es **100% local**.

## Estado

🚧 En desarrollo activo. Ver [`docs/PLAN.md`](docs/PLAN.md) y [`docs/XIANXIA_STUDIO_DESIGN.md`](docs/XIANXIA_STUDIO_DESIGN.md).

## Stack

- **Tauri 2** + **Rust** (orquestador nativo)
- **React 19** + **TypeScript** + **Vite** (UI)
- **Tailwind v4** + **shadcn/ui** (estilos)
- **TanStack Router** + **TanStack Query** + **Zustand** (estado)
- **Python sidecar** (FastAPI) → diffusers, Z-Image-Turbo, qwen-tts, faster-whisper, MoviePy
- **Node sidecar** → HyperFrames (HTML→MP4 con GSAP)
- **Ollama** + **Gemma 3** (LLM local)
- **SQLite** (persistencia)

## Filosofía

- 100% local, cero APIs de IA externas
- Todo autoinstalable (Python embebido, modelos, FFmpeg, Ollama)
- Single source of truth visual: `DESIGN.md` (sistema "Celestial Dark")

## Estructura

```
apps/
  desktop/        # Tauri 2 + React 19
  sidecar-py/     # FastAPI + Python AI workloads
  sidecar-node/   # HyperFrames render service
assets/
  music/          # 19 pistas cultivation (provistas)
docs/
  PLAN.md
  XIANXIA_STUDIO_DESIGN.md
DESIGN.md         # sistema de diseño formal
```

## Desarrollo

Requiere: Node ≥ 22, pnpm ≥ 10, Rust 1.91+, Python 3.11+, Ollama instalado.

```bash
pnpm install
pnpm tauri:dev
```

## Licencia

Apache 2.0
