/**
 * Render orchestration for HyperFrames-driven compositions.
 *
 * In production we shell out to the `hyperframes` CLI:
 *   `hyperframes render <composition.html> --output <out.mp4>`
 *
 * Compositions are HTML files with data-attributes (data-start, data-duration, etc.)
 * that HyperFrames interprets to build the timeline. We synthesize the HTML on-the-fly
 * from the templates in src/templates/ and inject the per-project asset paths.
 */

import { execa } from 'execa';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

export interface NarrativeRequest {
  project_id: string;
  title: string;
  images: { path: string; start: number; duration: number }[];
  narration_path: string;
  music_path?: string;
  out_path: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface RenderResult {
  out_path: string;
  duration_seconds: number;
}

export async function renderNarrative(req: NarrativeRequest): Promise<RenderResult> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'narrative.html'), 'utf8');
  const html = tmpl
    .replace('__TITLE__', escapeHtml(req.title))
    .replace('__WIDTH__', String(req.width ?? 1920))
    .replace('__HEIGHT__', String(req.height ?? 1080))
    .replace('__NARRATION__', toFileUrl(req.narration_path))
    .replace('__MUSIC__', req.music_path ? toFileUrl(req.music_path) : '')
    .replace(
      '__BEATS__',
      req.images
        .map(
          (b) => `
            <div class="beat" data-start="${b.start}" data-duration="${b.duration}">
              <img src="${toFileUrl(b.path)}" alt="" />
            </div>`,
        )
        .join('\n'),
    );

  const compPath = join(dirname(req.out_path), `${req.project_id}-narrative.html`);
  await mkdir(dirname(compPath), { recursive: true });
  await writeFile(compPath, html, 'utf8');

  logger.info({ comp: compPath, out: req.out_path }, 'rendering narrative');
  await runHyperFrames(compPath, req.out_path, req.fps ?? 24);

  const duration = req.images.reduce((s, b) => Math.max(s, b.start + b.duration), 0);
  return { out_path: req.out_path, duration_seconds: duration };
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
  // Single-frame render — HyperFrames supports --frame for stills, fallback to chrome screenshot
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
  return { out_path: req.out_path, duration_seconds: 0 };
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
    await execa('hyperframes', args, { stdio: 'inherit' });
  } catch (err) {
    logger.warn({ err }, 'hyperframes failed — falling back to ffmpeg-only path is M3 task');
    throw err;
  }
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
