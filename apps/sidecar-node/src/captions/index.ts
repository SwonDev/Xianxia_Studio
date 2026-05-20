/**
 * Caption-style catalog — v0.8.0.
 *
 * Catálogo de 15 estilos de captions importado del registry open-source
 * de HeyGen HyperFrames (Apache 2.0). Ver `apps/sidecar-node/NOTICE.md`
 * para la atribución completa.
 *
 * Cada entrada describe un componente HTML/CSS/GSAP self-contained que
 * espera un array `WORDS = [{ text, start, end }]` y renderiza overlays
 * sincronizados con audio. El `render` ya disponible en `render.ts`
 * (Playwright + Chromium + ffmpeg) puede inyectar nuestros word-arrays
 * (producidos por `routes/transcribe.py` con faster-whisper large-v3-turbo
 * + torchaudio forced-alignment) reemplazando el `WORDS` placeholder.
 *
 * v0.8.0 ofrece el catálogo + el mapping por preset; el wire al pipeline
 * (renderer overlay con alpha + composición ffmpeg final) llega en v0.8.1.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STYLES_DIR = join(__dirname, 'styles');

/**
 * Slugs canónicos de los 15 estilos. Se usan en config de preset y en la
 * UI del generator/shorts. `highlight` preserva el aspecto pre-v0.8.0
 * (active-word TikTok-style, ≈ Hormozi) — es el default seguro.
 */
export type CaptionStyleSlug =
  | 'highlight'
  | 'pill-karaoke'
  | 'editorial-emphasis'
  | 'glitch-rgb'
  | 'kinetic-slam'
  | 'neon-glow'
  | 'neon-accent'
  | 'clip-wipe'
  | 'gradient-fill'
  | 'matrix-decode'
  | 'emoji-pop'
  | 'parallax-layers'
  | 'particle-burst'
  | 'texture'
  | 'weight-shift';

export interface CaptionStyle {
  /** Slug canónico (kebab-case sin prefijo "caption-"). */
  slug: CaptionStyleSlug;
  /** Nombre humano para UI. */
  label: string;
  /** Una línea descriptiva del look, para tooltips. */
  description: string;
  /** Tags útiles para autoselección/filtros UI. */
  tags: ReadonlyArray<string>;
  /** Path absoluto al fichero HTML template. */
  templatePath: string;
}

const entries: ReadonlyArray<
  Omit<CaptionStyle, 'templatePath'> & { filename: string }
> = [
  {
    slug: 'highlight',
    label: 'Highlight (Hormozi)',
    description:
      'Active-word con background rojo TikTok-style. El estilo por defecto pre-v0.8.0.',
    tags: ['tiktok', 'shorts', 'hormozi', 'active-word', 'default'],
    filename: 'caption-highlight.html',
  },
  {
    slug: 'pill-karaoke',
    label: 'Karaoke pill',
    description: 'Cápsula tipo lyric/karaoke; ideal cuando la música lleva el peso.',
    tags: ['music', 'lyric', 'karaoke', 'pill'],
    filename: 'caption-pill-karaoke.html',
  },
  {
    slug: 'editorial-emphasis',
    label: 'Editorial emphasis',
    description: 'Documental / cinematográfico con énfasis tipográfico.',
    tags: ['documentary', 'cinematic', 'narrative', 'editorial'],
    filename: 'caption-editorial-emphasis.html',
  },
  {
    slug: 'glitch-rgb',
    label: 'Glitch RGB',
    description: 'Glitch RGB / cyber. Para tech/gaming/edgy.',
    tags: ['cyber', 'glitch', 'tech', 'gaming'],
    filename: 'caption-glitch-rgb.html',
  },
  {
    slug: 'kinetic-slam',
    label: 'Kinetic slam',
    description: 'Slam tipográfico full-screen. Hook agresivo, máximo impacto.',
    tags: ['hook', 'hype', 'shorts', 'high-energy'],
    filename: 'caption-kinetic-slam.html',
  },
  {
    slug: 'neon-glow',
    label: 'Neon glow',
    description: 'Glow neón limpio. Nocturno, vaporwave-friendly.',
    tags: ['neon', 'night', 'vaporwave', 'glow'],
    filename: 'caption-neon-glow.html',
  },
  {
    slug: 'neon-accent',
    label: 'Neon multi-accent',
    description: 'Neón multi-color por palabra. Vibrante, ideal listicles.',
    tags: ['neon', 'multicolor', 'listicle', 'vibrant'],
    filename: 'caption-neon-accent.html',
  },
  {
    slug: 'clip-wipe',
    label: 'Clip-path wipe',
    description: 'Wipe palabra a palabra. Tipografía limpia, marketing-grade.',
    tags: ['wipe', 'clean', 'marketing', 'corporate'],
    filename: 'caption-clip-wipe.html',
  },
  {
    slug: 'gradient-fill',
    label: 'Gradient fill',
    description: 'Gradient animado por palabra. Premium / luxury vibe.',
    tags: ['gradient', 'premium', 'luxury', 'deep-dive'],
    filename: 'caption-gradient-fill.html',
  },
  {
    slug: 'matrix-decode',
    label: 'Matrix decode',
    description: 'Decode sci-fi (caracteres aleatorios resolviendo). Mystery/tech.',
    tags: ['scifi', 'mystery', 'reveal', 'tech'],
    filename: 'caption-matrix-decode.html',
  },
  {
    slug: 'emoji-pop',
    label: 'Emoji pop',
    description: 'Palabras con emoji augmented. Engagement / CTAs sociales.',
    tags: ['emoji', 'social', 'cta', 'engagement'],
    filename: 'caption-emoji-pop.html',
  },
  {
    slug: 'parallax-layers',
    label: 'Parallax layers',
    description: 'Layers con depth/parallax. Cinematográfico para narrative épico.',
    tags: ['cinematic', 'parallax', 'depth', 'narrative-epic'],
    filename: 'caption-parallax-layers.html',
  },
  {
    slug: 'particle-burst',
    label: 'Particle burst',
    description: 'Partículas al énfasis. Dramatic moments, comparativas.',
    tags: ['particle', 'dramatic', 'comparative', 'energy'],
    filename: 'caption-particle-burst.html',
  },
  {
    slug: 'texture',
    label: 'Texture fill',
    description: 'Lava/texture fill. Xianxia-friendly por sí mismo (calor, magia).',
    tags: ['texture', 'lava', 'xianxia', 'fantasy', 'mystic'],
    filename: 'caption-texture.html',
  },
  {
    slug: 'weight-shift',
    label: 'Weight shift',
    description: 'Variable font con pulso de peso. Limpio, explainer-friendly.',
    tags: ['variable-font', 'clean', 'explainer', 'minimal'],
    filename: 'caption-weight-shift.html',
  },
];

/** Catálogo completo (orden estable para UI). */
export const CAPTION_STYLES: ReadonlyArray<CaptionStyle> = entries.map((e) => ({
  slug: e.slug,
  label: e.label,
  description: e.description,
  tags: e.tags,
  templatePath: join(STYLES_DIR, e.filename),
}));

/**
 * Mapa preset → estilo recomendado, alineado con los 6 presets de v0.7.0
 * y los modos Shorts. El criterio: cada preset tiene un tono dominante
 * (épico, datos densos, hype, etc.) y se mapea al estilo más coherente.
 *
 * `highlight` queda como **fallback universal** para preservar el aspecto
 * pre-v0.8.0 cuando un preset no esté listado. NUNCA se cambia el default
 * de un preset existente si el usuario no opta-in vía UI.
 */
export const PRESET_TO_STYLE: Record<string, CaptionStyleSlug> = {
  // v0.7.0 presets — orden DESIGN.md.
  narrative_epic: 'parallax-layers', // Cine épico → depth
  documentary: 'editorial-emphasis',
  explainer: 'highlight', // pre-v0.8.0 default
  listicle: 'kinetic-slam', // Listas energéticas
  comparative: 'particle-burst',
  deep_dive: 'gradient-fill', // Premium

  // Modos Shorts existentes.
  shorts_hormozi: 'highlight',
  shorts_general: 'kinetic-slam',
};

/** Resolución segura preset → slug. */
export function resolveStyleForPreset(
  presetId: string | undefined | null,
  override?: CaptionStyleSlug | null,
): CaptionStyleSlug {
  if (override && CAPTION_STYLES.some((s) => s.slug === override)) {
    return override;
  }
  const key = (presetId ?? '').toLowerCase();
  return PRESET_TO_STYLE[key] ?? 'highlight';
}

/** Acceso indexado por slug. */
export const STYLE_BY_SLUG: ReadonlyMap<CaptionStyleSlug, CaptionStyle> =
  new Map(CAPTION_STYLES.map((s) => [s.slug, s] as const));
