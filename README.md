<div align="center">

<img src="assets/promo/banner.png" alt="Xianxia Studio" width="100%" />

<br/>

[![Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-c9a961?style=for-the-badge&labelColor=0a0a0f)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SwonDev/Xianxia_Studio?style=for-the-badge&color=c9a961&labelColor=0a0a0f)](https://github.com/SwonDev/Xianxia_Studio/releases/latest)
[![Ko-Fi](https://img.shields.io/badge/apoya_el_proyecto-Ko--Fi-52b788?style=for-the-badge&labelColor=0a0a0f&logo=ko-fi&logoColor=white)](https://ko-fi.com/swonproject)

### **Studio cinematográfico de IA local · 100 % offline · Apache 2.0**

[**⬇  Descargar para Windows**](https://github.com/SwonDev/Xianxia_Studio/releases/latest)  ·
[**☕  Invítame a un café**](https://ko-fi.com/swonproject)  ·
[**🐛  Reportar un bug**](https://github.com/SwonDev/Xianxia_Studio/issues/new/choose)

</div>

<br/>

---

## Lo que hace

Escribes un tema. La aplicación entrega un **vídeo cinematográfico listo para subir a YouTube** — guion narrativo, voz, imágenes, banda sonora, montaje con efectos, subtítulos quemados, thumbnail y subida programada.

Todo el procesamiento de IA ocurre **en tu propio equipo**. Sin enviar nada a la nube. Sin claves API. Sin cuotas mensuales. Sin que tus ideas pasen por servidores ajenos.

Pensada para creadores que producen contenido sobre mitología china, *xianxia* y *wuxia*, pero útil para cualquier nicho narrativo.

<br/>

## Lo que incluye

| | |
|---|---|
| 🎬 | **Long-form y Shorts** — 30 s, 5 min o 30 min en horizontal o vertical, calidad cinematográfica |
| ✂️ | **Smart Shorts** — extrae fragmentos virales de un MP4 ya editado, igual que OpusClip pero local |
| 🎙️ | **Voz nativa** — 9 voces multilenguaje + clónala con 5 segundos de tu propio audio |
| 🧠 | **Engagement con neurociencia** — detecta valles aburridos con TRIBE v2 (modelo fMRI de Meta) y los corrige automáticamente |
| 🎨 | **5 estilos de subtítulos** — desde el cinematográfico al estilo MrBeast, con karaoke palabra a palabra |
| 🎥 | **Edición automática** — HyperFrames compone HTML/CSS/GSAP con parallax 2.5D, partículas atmosféricas, transiciones cinemáticas |
| 📤 | **9 presets de exportación** — YouTube, IG Reels, TikTok, X, FB con loudness optimizado para cada plataforma |
| ☁️ | **Subida a YouTube** — programada, con metadata, captions multi-idioma y thumbnail automáticos |
| 🔄 | **Auto-update firmado** — las nuevas versiones llegan solas, verificadas criptográficamente |

<br/>

## Descargar

> **Windows 11 · NVIDIA RTX 4060 (8 GB VRAM) o superior · 30 GB libres**

[**⬇  Última release**](https://github.com/SwonDev/Xianxia_Studio/releases/latest) → elige el `Xianxia_Studio_X.Y.Z_x64-setup.exe` (NSIS, recomendado).

La primera vez que abras la app, un wizard descarga modelos y runtimes (~10 GB obligatorios + ~20 GB opcionales). El stack está optimizado para **8 GB de VRAM**: GGUF cuantizado, offload secuencial, todo cabe sin pelear.

> El instalador no tiene firma Authenticode comercial todavía, así que la primera ejecución muestra "Editor desconocido" en SmartScreen. Pulsa **Más información → Ejecutar de todas formas**. Las actualizaciones posteriores se aplican sin diálogos porque van firmadas con la clave de updater.

<br/>

## Apoya el proyecto ☕

Xianxia Studio es **gratis y open source**. Si te ahorra horas de edición y quieres ayudar a que siga creciendo, puedes invitar a un café:

<div align="center">

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/swonproject)

**[ko-fi.com/swonproject](https://ko-fi.com/swonproject)**

</div>

Cada apoyo va directo a:
- Sostener el desarrollo y documentación
- Probar nuevos modelos a medida que aparecen
- Mantener la app 100 % gratuita y sin tracking

<br/>

## Bajo el capó

<details>
<summary><strong>Pulsa para ver la stack técnica completa</strong></summary>

<br/>

| Capa | Tecnología |
|---|---|
| Desktop shell | Tauri 2 · Rust · React 19 · Vite · Tailwind 4 · TanStack Router |
| LLM | Ollama + Gemma 4 abliterated GGUF Q4_K_M |
| TTS | Qwen3-TTS-12Hz-1.7B-CustomVoice (9 voces + cloning) |
| ASR | faster-whisper-large-v3 (timestamps por palabra) |
| Imagen | ComfyUI + Z-Image-Turbo Q4_K_M GGUF |
| Visión 2.5D | rembg · onnxruntime-gpu · MediaPipe · YOLO11n-pose |
| Música | ACE-Step v1.5 · MusicGen-medium (fallback) |
| **Vídeo · motor** | **[HyperFrames](https://github.com/heygen-com/hyperframes)** — HTML/CSS/GSAP → MP4 con parallax + atmospherics + transiciones |
| Vídeo · post | FFmpeg 8 con NVENC h264, grade cinemático, sidechain ducking |
| Engagement | Meta TRIBE v2 (fMRI) + Yeo 7-network atlas |
| Subida | YouTube Data v3 + OAuth RFC 8252 |
| Orquestación | Tauri Supervisor · Python sidecar (FastAPI) · Node sidecar HyperFrames (Fastify) |

**Filosofía AUTO**: cada modelo, dependencia y backend que toca el pipeline es **autoinstalable** desde la app, **autodetectable** y **autoconfigurable**. Cero comandos en terminal.

</details>

<br/>

## Compilar desde fuente

```bash
git clone https://github.com/SwonDev/Xianxia_Studio.git
cd Xianxia_Studio
pnpm install
pnpm tauri:dev      # arranca en modo desarrollo
pnpm tauri:build    # produce el bundle NSIS + MSI
```

Requisitos: Node 22+, pnpm 10+, Rust stable, Visual Studio Build Tools.
Más detalles operativos: [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`RELEASING.md`](RELEASING.md).

<br/>

## Contribuir

Issues, PRs y feedback bienvenidos. Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de un PR grande. Vulnerabilidades: [`SECURITY.md`](SECURITY.md).

<br/>

## Licencia

[Apache 2.0](LICENSE). Eres libre de usar, modificar, redistribuir y **monetizar comercialmente los vídeos generados**.

Componentes opcionales con licencia distinta: Meta TRIBE v2 está bajo CC-BY-NC-4.0 — su instalación es opcional y los vídeos producidos pueden monetizarse en YouTube si el uso de la aplicación es personal o no comercial respecto al software.

<br/>

---

<div align="center">

Hecho con ❤️ por [@SwonDev](https://github.com/SwonDev) · [☕ Ko-Fi](https://ko-fi.com/swonproject)

<sub>El logo y el nombre Xianxia Studio están bajo Apache 2.0 junto al resto del código.</sub>

</div>
