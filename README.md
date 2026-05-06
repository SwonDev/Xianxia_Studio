<div align="center">

<img src="apps/desktop/public/logo.svg" width="140" alt="Xianxia Studio" />

# Xianxia Studio

**Studio cinematográfico de IA local para producir vídeos de YouTube de cualquier duración, 100 % offline.**

[![License](https://img.shields.io/badge/license-Apache%202.0-c9a961?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-orange?style=flat-square)](https://www.rust-lang.org)
[![Release](https://img.shields.io/github/v/release/SwonDev/Xianxia_Studio?style=flat-square&color=c9a961)](https://github.com/SwonDev/Xianxia_Studio/releases/latest)

[Descargas](#-descargar) · [Funcionalidades](#-funcionalidades) · [Stack](#-stack) · [Compilar](#-compilar-desde-fuente) · [Contribuir](#-contribuir)

</div>

---

## Qué es

Xianxia Studio es una aplicación de escritorio (Tauri 2 + React 19) que **automatiza la producción de vídeos cinematográficos para YouTube** — desde Shorts virales de 30 segundos hasta long-form de 30 minutos — usando exclusivamente modelos de IA que se ejecutan en tu propia máquina. Sin APIs cloud, sin cuotas mensuales, sin enviar nada a terceros.

Escribes un tema, y la app entrega:

1. **Guion** (LLM Gemma 4 vía Ollama)
2. **Voz narradora** (Qwen3-TTS, 9 voces nativas + clonación de tu propia voz)
3. **Imágenes cinemáticas** (Z-Image-Turbo Q4 GGUF en ComfyUI)
4. **Banda sonora** (ACE-Step v1.5 o MusicGen)
5. **Vídeo** (FFmpeg con Steadicam sway, NVENC, 60 fps, parallax 2.5D)
6. **Subtítulos word-level** quemados en 5 estilos (xianxia, hormozi, mrbeast, minimal, neon)
7. **Thumbnail** dedicado
8. **Análisis de engagement** con TRIBE v2 (modelo fMRI in-silico de Meta) que detecta valles aburridos y los corrige
9. **Auto-Shorts** virales extraídos del long-form
10. **Subida programada a YouTube** con metadata, captions multi-idioma y thumbnail

Pensada para creadores que producen contenido sobre mitología china, *xianxia* y *wuxia*, pero útil para cualquier nicho narrativo.

> **Filosofía AUTO**: cada modelo, dependencia y backend que toca el pipeline es **autoinstalable** desde la app, **autodetectable** y **autoconfigurable**. Cero comandos en terminal: el wizard hace el setup completo y los componentes opcionales se instalan con un clic desde Ajustes.

---

## ✨ Funcionalidades

| | |
|---|---|
| 🎬 **Long-form & Shorts** | Genera 30 s · 5 min · 30 min en horizontal 1920×1080 o vertical 1080×1920. Native aspect, sin crops forzados. |
| ✂️ **Smart Shorts** | Extrae 1-N Shorts virales de cualquier MP4 con LLM scoring (hook + climax + standalone). Drag-and-drop estilo OpusClip pero local. |
| 🧠 **Engagement con neurociencia** | Phase 11 con TRIBE v2 predice respuestas fMRI por segundo, mapea a redes Yeo (Salience/FPN/DMN/Visual/Auditory), genera score 0-100 y auto-corrige valles. |
| 🎙️ **Voice cloning nativo** | Sube 5-10 segundos de audio y Qwen3-TTS genera narración con tu voz. Multi-idioma (ES/EN/ZH + 7 más). |
| 🎨 **5 caption styles** | xianxia · hormozi · mrbeast · minimal · neon. Karaoke word-level con safe zones TikTok. |
| 🎥 **4 animation presets** | cinematic · dynamic · minimal · dramatic. Steadicam sway sinusoidal, parallax 2.5D, NVENC p7. |
| 📤 **9 export presets** | YouTube Shorts/1080p/4K · IG Reels/4:5/1:1 · TikTok · X · FB Reels con LUFS específicos. |
| ☁️ **Subida YouTube programada** | OAuth RFC 8252, resumable upload, captions ES/EN/ZH, thumbnail + #Shorts hashtag automático. |
| 🔌 **Componentes opcionales** | TRIBE v2 (~12 GB) · ACE-Step + MusicGen (~6 GB) · Vision stack. Instálalos cuando los necesites desde Ajustes con un clic. |
| 🔄 **Auto-update** | Updater firmado criptográficamente. Las nuevas versiones se descargan e instalan sin diálogos desde GitHub Releases. |

---

## 📥 Descargar

Ve a la sección [Releases](https://github.com/SwonDev/Xianxia_Studio/releases/latest) y descarga el instalador para tu plataforma:

- **Windows · NSIS** (recomendado, per-user) — `Xianxia_Studio_X.Y.Z_x64-setup.exe`
- **Windows · MSI** (instalación silenciosa, Group Policy) — `Xianxia_Studio_X.Y.Z_x64_en-US.msi`

> La primera vez que abras la app pasarás por el wizard de instalación que descarga modelos y runtimes. El stack base obligatorio cabe en ~10 GB; los componentes opcionales (TRIBE, ACE-Step, Vision) son otros ~20 GB que puedes instalar luego.
>
> Aviso SmartScreen: la primera ejecución mostrará un mensaje de "Editor desconocido" porque la firma actual es de updater (gratis), no Authenticode comercial. Pulsa "Más información" → "Ejecutar de todas formas". Las actualizaciones posteriores se aplican sin diálogos.

### Requisitos de hardware

| | Mínimo recomendado | Óptimo |
|---|---|---|
| GPU | NVIDIA RTX 4060 8 GB VRAM | RTX 4090 24 GB |
| CPU | 8 cores | 16 cores |
| RAM | 32 GB | 64 GB |
| Disco | 30 GB libres (stack completo) | NVMe |
| OS | Windows 11 | Windows 11 / Linux (en roadmap) |

El stack está optimizado para **8 GB VRAM** mediante GGUF Q4 + offload secuencial. Tier alto es opt-in para mejor calidad y velocidad.

---

## 🛠 Stack

| Capa | Tecnología |
|---|---|
| Desktop shell | Tauri 2.11 · Rust · React 19 · Vite 6 · Tailwind 4 · TanStack Router |
| LLM | Ollama 0.23 + Gemma 4 abliterated GGUF |
| TTS | Qwen3-TTS-12Hz-1.7B-CustomVoice (9 voces + cloning) |
| ASR | faster-whisper-large-v3 (word-level timestamps) |
| Imagen | ComfyUI + Z-Image-Turbo Q4_K_M GGUF (sampler dpmpp_sde + beta) |
| Música | ACE-Step v1.5 (preferido) · MusicGen-medium (fallback) |
| Vídeo | FFmpeg · NVENC h264 p7 · 60 fps · 2× canvas + lanczos |
| Engagement | Meta TRIBE v2 (fMRI prediction) + Yeo 7-network atlas mapping |
| Subtítulos | ASS karaoke con 5 estilos · safe zones TikTok |
| Subida | YouTube Data v3 + OAuth RFC 8252 (loopback) |
| Orquestación | Tauri Supervisor (Rust) · Python sidecar (FastAPI :8731) · Node sidecar (Fastify :8732) |
| Persistencia | SQLite vía sqlx |

---

## 🔨 Compilar desde fuente

Requisitos:
- Node.js 22+
- pnpm 10+
- Rust stable
- Python 3.11 (embebido por el wizard; útil tenerlo aparte para desarrollo)
- Visual Studio Build Tools (Windows) o equivalente

```bash
git clone https://github.com/SwonDev/Xianxia_Studio.git
cd Xianxia_Studio
pnpm install
pnpm tauri:dev    # arranca en modo desarrollo con HMR
pnpm tauri:build  # produce el bundle NSIS + MSI en target/release/bundle/
```

Otros scripts útiles:

```bash
pnpm branding       # regenera iconos OS + BMPs del installer desde el logo SVG
pnpm version:bump   # bumpea PATCH en los 4 sources of truth de versión
pnpm typecheck      # tsc -b en el frontend
pnpm lint           # ESLint v9 flat config (0 warnings tolerados)
```

Cómo lanzar una release: ver [`RELEASING.md`](RELEASING.md).
Documento de arquitectura completo: [`docs/PLAN.md`](docs/PLAN.md) · [`docs/XIANXIA_STUDIO_DESIGN.md`](docs/XIANXIA_STUDIO_DESIGN.md) · [`DESIGN.md`](DESIGN.md).

---

## 🤝 Contribuir

Issues, PRs y feedback bienvenidos. Antes de abrir un PR grande, abre un issue para discutir el approach. Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) para los detalles operativos.

Reportar vulnerabilidades de seguridad: [`SECURITY.md`](SECURITY.md).

---

## 📜 Licencia

Software bajo [Apache License 2.0](LICENSE). Eres libre de usar, modificar, redistribuir y monetizar comercialmente los vídeos generados.

**Componentes opcionales con licencia distinta**: Meta TRIBE v2 está bajo CC-BY-NC-4.0 (uso no comercial del propio modelo). Su instalación es opcional desde Ajustes; los vídeos producidos pueden monetizarse en YouTube si el uso de la aplicación es personal o no comercial respecto al software en sí.

---

## 🙏 Créditos

Construido sobre proyectos increíbles de la comunidad open source:

- [Tauri](https://tauri.app) · [React](https://react.dev) · [TanStack](https://tanstack.com)
- [Ollama](https://ollama.com) · [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [ACE-Step](https://github.com/ace-step/ACE-Step) · [audiocraft](https://github.com/facebookresearch/audiocraft)
- [Meta TRIBE v2](https://aidemos.atmeta.com/tribev2)
- [shadcn/ui](https://ui.shadcn.com) · [lucide-react](https://lucide.dev) · [motion](https://motion.dev)
