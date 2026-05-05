/**
 * Cinematic post-pass FFmpeg filter graph (Node side).
 *
 * Mirrors apps/sidecar-py/src/xianxia_ai/effects.py so HyperFrames-rendered
 * MP4s receive the same colour grade + sharpen + vignette + grain pass that
 * MoviePy renders get on the Python fallback path.
 *
 * NVENC handles all this in a single pass at ~+5 % over the base encode.
 *
 * Compositional overlays (chapter cards, lower thirds, title cards) are
 * baked into the HyperFrames composition (HTML+GSAP) before reaching this
 * pass — this file only owns the universal finishing layer.
 */

export type CinematicProfile = 'off' | 'light' | 'full';

export interface EffectsConfig {
  colorGrade: boolean;
  sharpen: boolean;
  vignette: boolean;
  filmGrain: boolean;
  contrast: number;
  saturation: number;
  gamma: number;
  sharpenStrength: number;
  vignetteAngle: string;
  grainAmount: number;
}

export function effectsConfig(profile: CinematicProfile): EffectsConfig {
  if (profile === 'off') {
    return {
      colorGrade: false, sharpen: false, vignette: false, filmGrain: false,
      contrast: 1, saturation: 1, gamma: 1,
      sharpenStrength: 0, vignetteAngle: 'PI/5', grainAmount: 0,
    };
  }
  if (profile === 'light') {
    return {
      colorGrade: true, sharpen: true, vignette: true, filmGrain: false,
      contrast: 1.03, saturation: 1.05, gamma: 0.98,
      sharpenStrength: 0.4, vignetteAngle: 'PI/6', grainAmount: 0,
    };
  }
  // full
  return {
    colorGrade: true, sharpen: true, vignette: true, filmGrain: true,
    contrast: 1.06, saturation: 1.12, gamma: 0.96,
    sharpenStrength: 0.6, vignetteAngle: 'PI/5', grainAmount: 8,
  };
}

export function cinematicLookFilters(cfg: EffectsConfig): string[] {
  const parts: string[] = [];
  if (cfg.colorGrade) {
    parts.push(`eq=contrast=${cfg.contrast}:saturation=${cfg.saturation}:gamma=${cfg.gamma}`);
    parts.push(
      'colorbalance=rs=0.04:gs=-0.01:bs=-0.06:rm=0.02:gm=0.0:bm=-0.02:rh=-0.04:gh=0.02:bh=0.06',
    );
  }
  if (cfg.sharpen) {
    const chroma = (cfg.sharpenStrength * 0.5).toFixed(3);
    parts.push(`unsharp=5:5:${cfg.sharpenStrength}:3:3:${chroma}`);
  }
  if (cfg.vignette) {
    parts.push(`vignette=${cfg.vignetteAngle}`);
  }
  if (cfg.filmGrain) {
    parts.push(`noise=alls=${cfg.grainAmount}:allf=t+u`);
  }
  return parts;
}

export function musicDuckingFilterComplex(opts: {
  narrationIdx: number;
  musicIdx: number;
  outLabel?: string;
  threshold?: number;
  ratio?: number;
  attackMs?: number;
  releaseMs?: number;
  musicVolume?: number;
}): string {
  const {
    narrationIdx, musicIdx,
    outLabel = 'mixed',
    threshold = 0.04, ratio = 10, attackMs = 20, releaseMs = 350,
    musicVolume = 0.32,
  } = opts;
  return (
    `[${musicIdx}:a]volume=${musicVolume},asplit=2[m1][m_pad];` +
    `[${narrationIdx}:a]asplit=2[n1][n2];` +
    `[m1][n1]sidechaincompress=` +
    `threshold=${threshold}:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}` +
    `:makeup=1.0[duck];` +
    `[duck][n2]amix=inputs=2:duration=first:dropout_transition=0[${outLabel}]`
  );
}
