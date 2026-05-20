# NOTICE — Third-party content

Este archivo lista contenido de terceros incluido en este sub-paquete.

---

## HyperFrames caption-style catalog (v0.8.0)

Xianxia Studio v0.8.0 importa los 15 componentes de caption del registry
open-source de HyperFrames:

- **Upstream**: <https://github.com/heygen-com/hyperframes>
- **Path**: `registry/components/caption-*/`
- **Release importado**: `v0.6.19` (catalog de 15 caption-style components)
- **Importado**: 2026-05-20
- **License**: Apache License 2.0
- **Copyright**: HeyGen, Inc.

Los 15 ficheros están en `apps/sidecar-node/src/captions/styles/`:

| Slug | Component | Descripción |
|---|---|---|
| `highlight` | `caption-highlight.html` | Active-word con highlight rojo TikTok |
| `pill-karaoke` | `caption-pill-karaoke.html` | Karaoke con pill, ideal lyric/música |
| `editorial-emphasis` | `caption-editorial-emphasis.html` | Cinematic / documental |
| `glitch-rgb` | `caption-glitch-rgb.html` | RGB glitch / cyber |
| `kinetic-slam` | `caption-kinetic-slam.html` | Full-screen slam (hook agresivo) |
| `neon-glow` | `caption-neon-glow.html` | Neon glow simple |
| `neon-accent` | `caption-neon-accent.html` | Neon multi-color |
| `clip-wipe` | `caption-clip-wipe.html` | Clip-path wipe palabra a palabra |
| `gradient-fill` | `caption-gradient-fill.html` | Gradient fill premium |
| `matrix-decode` | `caption-matrix-decode.html` | Matrix decode (sci-fi reveal) |
| `emoji-pop` | `caption-emoji-pop.html` | Emoji augmented para CTAs |
| `parallax-layers` | `caption-parallax-layers.html` | Layers con depth/parallax |
| `particle-burst` | `caption-particle-burst.html` | Particle burst on emphasis |
| `texture` | `caption-texture.html` | Lava/texture fill (xianxia-friendly) |
| `weight-shift` | `caption-weight-shift.html` | Variable font weight pulse |

### Cambios respecto al upstream

Cada fichero `.html` añade un **header HTML comentado** con la atribución
y el link al upstream (4 líneas de comentario antes del `<!doctype>`).
El resto del contenido es **idéntico byte por byte** al de
`registry/components/<name>/<name>.html` en `heygen-com/hyperframes@v0.6.19`.

### Apache 2.0 — términos resumidos

- Copy/redistribute permitido (incluida modificación).
- Conservar copyright + LICENSE + NOTICE (este archivo cumple).
- No usar el nombre/marca de HeyGen para endosar productos derivados.
- Texto completo de la licencia: <https://www.apache.org/licenses/LICENSE-2.0>.

### Por qué no usamos el CLI / engine de HeyGen

Xianxia Studio mantiene su propio pipeline de render (HyperFrames
embedded vía `apps/sidecar-node/render.ts` desde v0.1.x, faster-whisper
large-v3-turbo + torchaudio forced-alignment, Qwen3-TTS voice cloning,
NVENC, AudioSeal watermark, smart reframe, 2.5D parallax). Sólo se ha
adoptado el **catálogo visual de captions** (HTML/CSS/GSAP), porque ese
sí es un upgrade real (1 estilo Hormozi → 15 estilos diversos).

El CLI `hyperframes-media` (TTS Kokoro + Whisper small + rembg
u2net_human_seg) es **inferior** al stack actual de Xianxia y NO se
adopta.
