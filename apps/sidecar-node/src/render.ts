/**
 * Render orchestration for HyperFrames-driven compositions.
 *
 * Production flow:
 *   1. Build composition.html from template + per-beat metadata (parallax
 *      layers, atmospheric FX kind, outgoing transition).
 *   2. `hyperframes render <comp.html> --output base.mp4`.
 *   3. FFmpeg post-pass on base.mp4: cinematic colour grade + sharpen +
 *      vignette + grain + narration/music sidechain ducking → final.mp4.
 */

import { execa } from 'execa';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import {
  cinematicLookFilters,
  effectsConfig,
  musicDuckingFilterComplex,
  type CinematicProfile,
} from './effects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

export type AtmosphericFx = 'none' | 'mist' | 'embers' | 'snow' | 'dust_motes' | 'clouds';
export type Transition = 'cross' | 'flash' | 'whip' | 'inkwash';

export interface ImageBeat {
  /** Single base image (used as background and as fallback when no depth layers exist). */
  path: string;
  /** Optional pre-segmented foreground layer (transparent PNG). */
  foreground_path?: string;
  /** Optional mid-distance layer (transparent PNG). */
  mid_path?: string;
  start: number;
  duration: number;
  /** Atmospheric particle overlay played during this beat. */
  fx?: AtmosphericFx;
  /** Transition applied at this beat's outgoing edge. */
  transition?: Transition;
  /** Add subtle directional light rays. */
  light_rays?: boolean;
}

export interface NarrativeRequest {
  project_id: string;
  title: string;
  images: ImageBeat[];
  narration_path: string;
  music_path?: string;
  out_path: string;
  width?: number;
  height?: number;
  fps?: number;
  cinematic?: CinematicProfile;
  music_volume?: number;
  music_ducking?: boolean;
}

export interface RenderResult {
  out_path: string;
  duration_seconds: number;
  cinematic_profile: CinematicProfile;
}

export async function renderNarrative(req: NarrativeRequest): Promise<RenderResult> {
  const fps = req.fps ?? 24;
  const width = req.width ?? 1920;
  const height = req.height ?? 1080;
  const profile: CinematicProfile = req.cinematic ?? 'full';

  const tmpl = await readFile(join(TEMPLATES_DIR, 'narrative.html'), 'utf8');

  const beatNodes = req.images
    .map((b, i) => buildBeatNode(b, i))
    .join('\n');
  const beatFx = req.images.map((b) => ({ kind: b.fx ?? 'none' }));

  const html = tmpl
    .replace(/__TITLE__/g, escapeHtml(req.title))
    .replace(/__WIDTH__/g, String(width))
    .replace(/__HEIGHT__/g, String(height))
    .replace('__NARRATION__', toFileUrl(req.narration_path))
    .replace('__MUSIC__', req.music_path ? toFileUrl(req.music_path) : '')
    .replace('__BEATS__', beatNodes)
    .replace('__BEAT_FX_JSON__', JSON.stringify(beatFx));

  const baseSilent = req.out_path.replace(/\.mp4$/i, '.base.mp4');
  const compPath = join(dirname(req.out_path), `${req.project_id}-narrative.html`);
  await mkdir(dirname(compPath), { recursive: true });
  await writeFile(compPath, html, 'utf8');

  logger.info({ comp: compPath, base: baseSilent }, 'rendering narrative (HyperFrames)');
  await runHyperFrames(compPath, baseSilent, fps);

  // ── FFmpeg cinematic post-pass + audio mix ──────────────────────────
  const duration = req.images.reduce((s, b) => Math.max(s, b.start + b.duration), 0);
  await postProcessCinematic({
    baseSilent,
    out: req.out_path,
    narrationPath: req.narration_path,
    musicPath: req.music_path,
    musicVolume: req.music_volume ?? 0.32,
    musicDucking: req.music_ducking ?? true,
    profile,
  });

  try {
    await unlink(baseSilent);
  } catch {
    /* ignore */
  }

  return { out_path: req.out_path, duration_seconds: duration, cinematic_profile: profile };
}

function buildBeatNode(b: ImageBeat, idx: number): string {
  const dataAttrs =
    `data-start="${b.start}" data-duration="${b.duration}"` +
    (b.transition ? ` data-trans="${b.transition}"` : '');

  // Layered render when depth-segmented assets exist; otherwise single image.
  const layers = b.foreground_path || b.mid_path
    ? `
      <div class="layer bg" style="background-image: url('${toFileUrl(b.path)}');"></div>
      ${b.mid_path ? `<div class="layer mid" style="background-image: url('${toFileUrl(b.mid_path)}');"></div>` : ''}
      ${b.foreground_path ? `<div class="layer fg" style="background-image: url('${toFileUrl(b.foreground_path)}');"></div>` : ''}
    `
    : `<img class="single" src="${toFileUrl(b.path)}" alt="" />`;

  const atmosCanvas = (b.fx && b.fx !== 'none')
    ? `<div class="atmos" id="atmos-${idx}"><canvas></canvas></div>`
    : '';
  const rays = b.light_rays ? `<div class="rays"></div>` : '';

  return `
    <div class="beat" ${dataAttrs}>
      ${layers}
      ${atmosCanvas}
      ${rays}
    </div>`;
}

export async function renderThumbnail(req: {
  title_en: string;
  title_zh?: string;
  background_path: string;
  out_path: string;
}): Promise<{ out_path: string }> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'thumbnail.html'), 'utf8');
  const html = tmpl
    .replace('__TITLE_EN__', escapeHtml(req.title_en))
    .replace('__TITLE_ZH__', escapeHtml(req.title_zh ?? ''))
    .replace('__BG__', toFileUrl(req.background_path));
  const compPath = req.out_path.replace(/\.\w+$/, '.html');
  await mkdir(dirname(compPath), { recursive: true });
  await writeFile(compPath, html, 'utf8');
  await runHyperFrames(compPath, req.out_path, 24, /* still */ true);
  return { out_path: req.out_path };
}

export async function renderShort(req: {
  clip_path: string;
  hook: string;
  subtitles_srt?: string;
  out_path: string;
}): Promise<RenderResult> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'short.html'), 'utf8');
  const html = tmpl
    .replace('__CLIP__', toFileUrl(req.clip_path))
    .replace('__HOOK__', escapeHtml(req.hook));
  const compPath = req.out_path.replace(/\.\w+$/, '.html');
  await mkdir(dirname(compPath), { recursive: true });
  await writeFile(compPath, html, 'utf8');
  await runHyperFrames(compPath, req.out_path, 30);
  return { out_path: req.out_path, duration_seconds: 0, cinematic_profile: 'full' };
}

async function runHyperFrames(
  comp: string,
  out: string,
  fps: number,
  still = false,
): Promise<void> {
  const args = ['render', comp, '--output', out, '--fps', String(fps)];
  if (still) args.push('--still');
  try {
    // preferLocal: true lets execa find `hyperframes` from node_modules/.bin,
    // so the package can be installed locally per-sidecar (autoinstallable).
    await execa('hyperframes', args, { stdio: 'inherit', preferLocal: true });
  } catch (err) {
    logger.error({ err }, 'hyperframes render failed');
    throw err;
  }
}

async function postProcessCinematic(opts: {
  baseSilent: string;
  out: string;
  narrationPath: string;
  musicPath?: string;
  musicVolume: number;
  musicDucking: boolean;
  profile: CinematicProfile;
}): Promise<void> {
  const { baseSilent, out, narrationPath, musicPath, musicVolume, musicDucking, profile } = opts;
  const cfg = effectsConfig(profile);
  const cineFilters = cinematicLookFilters(cfg);
  const vf = cineFilters.length > 0 ? cineFilters.join(',') : 'null';

  // Encoder selection: prefer NVENC, fall back to libx264
  const encoder = await pickEncoder();
  const encodeArgs = encoder === 'h264_nvenc'
    ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-pix_fmt', 'yuv420p']
    : encoder === 'h264_qsv'
    ? ['-global_quality', '20', '-preset', 'medium', '-pix_fmt', 'nv12']
    : encoder === 'h264_amf'
    ? ['-quality', 'quality', '-rc', 'vbr_peak', '-qp_i', '20', '-qp_p', '22', '-pix_fmt', 'yuv420p']
    : ['-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
  const decodeArgs =
    encoder === 'h264_nvenc' ? ['-hwaccel', 'cuda']
    : encoder === 'h264_qsv' ? ['-hwaccel', 'qsv']
    : encoder === 'h264_amf' ? ['-hwaccel', 'd3d11va']
    : [];

  const inputs = ['-i', baseSilent, '-i', narrationPath];
  let filterComplex: string[] = [];
  let audioMap: string[];

  if (musicPath && musicDucking) {
    inputs.push('-i', musicPath);
    filterComplex = [
      '-filter_complex',
      musicDuckingFilterComplex({ narrationIdx: 1, musicIdx: 2, musicVolume }),
    ];
    audioMap = ['-map', '0:v:0', '-map', '[mixed]'];
  } else if (musicPath) {
    inputs.push('-i', musicPath);
    filterComplex = [
      '-filter_complex',
      `[2:a]volume=${musicVolume}[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=0[mixed]`,
    ];
    audioMap = ['-map', '0:v:0', '-map', '[mixed]'];
  } else {
    audioMap = ['-map', '0:v:0', '-map', '1:a:0'];
  }

  const cmd = [
    '-y',
    ...decodeArgs,
    ...inputs,
    ...filterComplex,
    '-vf', vf,
    '-c:v', encoder,
    ...encodeArgs,
    ...audioMap,
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    out,
  ];

  logger.info({ encoder, profile }, 'ffmpeg cinematic post-pass');
  await execa('ffmpeg', cmd, { stdio: 'inherit' });
}

async function pickEncoder(): Promise<'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'> {
  try {
    const { stdout } = await execa('ffmpeg', ['-hide_banner', '-encoders']);
    if (stdout.includes('h264_nvenc')) return 'h264_nvenc';
    if (stdout.includes('h264_qsv')) return 'h264_qsv';
    if (stdout.includes('h264_amf')) return 'h264_amf';
  } catch {
    /* fall through */
  }
  return 'libx264';
}

function toFileUrl(p: string): string {
  return `file://${p.replace(/\\/g, '/')}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
