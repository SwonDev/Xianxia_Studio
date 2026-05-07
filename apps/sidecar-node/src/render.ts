/**
 * Render orchestration for HyperFrames-driven compositions.
 *
 * Production flow:
 *   1. Build composition.html from template + per-beat metadata (parallax
 *      layers, atmospheric FX kind, outgoing transition).
 *   2. Scaffold a temp project directory with index.html + hyperframes.json
 *      + meta.json (HyperFrames 0.4 expects a project DIR, not a single
 *      file — `hyperframes render <DIR>`).
 *   3. `hyperframes render <projectDir> --output base.mp4`.
 *   4. FFmpeg post-pass on base.mp4: cinematic colour grade + sharpen +
 *      vignette + grain + narration/music sidechain ducking → final.mp4.
 *   5. Cleanup the temp project directory.
 */

import { execa } from 'execa';
import { mkdir, writeFile, readFile, unlink, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
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
  const duration = req.images.reduce((s, b) => Math.max(s, b.start + b.duration), 0);

  const baseSilent = req.out_path.replace(/\.mp4$/i, '.base.mp4');
  const projectDir = join(dirname(req.out_path), `${req.project_id}-narrative-proj`);
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  // Stage every external asset INSIDE the project directory so Chromium's
  // file:// security policy (which blocks loading siblings of an
  // index.html via absolute paths) doesn't strip our audio/images.
  // We use `assets/<n>-<basename>` to guarantee uniqueness across beats.
  const stage = makeAssetStager(assetsDir);
  const stagedNarration = await stage.copy(req.narration_path, 'narration');
  const stagedMusic = req.music_path ? await stage.copy(req.music_path, 'music') : '';

  const stagedBeats: ImageBeat[] = [];
  for (let i = 0; i < req.images.length; i++) {
    const b = req.images[i];
    stagedBeats.push({
      ...b,
      path: await stage.copy(b.path, `bg-${i}`),
      foreground_path: b.foreground_path
        ? await stage.copy(b.foreground_path, `fg-${i}`)
        : undefined,
      mid_path: b.mid_path
        ? await stage.copy(b.mid_path, `mid-${i}`)
        : undefined,
    });
  }

  const beatNodes = stagedBeats
    .map((b, i) => buildBeatNode(b, i))
    .join('\n');
  const beatFx = stagedBeats.map((b) => ({ kind: b.fx ?? 'none' }));

  const musicBlock = stagedMusic
    ? `<audio
      id="music-track"
      class="clip"
      data-track-index="1"
      data-start="0"
      data-duration="${duration}"
      data-volume="0.32"
      src="${stagedMusic}"
    ></audio>`
    : '';
  const html = tmpl
    .replace(/__TITLE__/g, escapeHtml(req.title))
    .replace(/__WIDTH__/g, String(width))
    .replace(/__HEIGHT__/g, String(height))
    .replace(/__DURATION__/g, String(duration))
    .replace('__NARRATION__', stagedNarration)
    .replace('__MUSIC_BLOCK__', musicBlock)
    .replace('__BEATS__', beatNodes)
    .replace('__BEAT_FX_JSON__', JSON.stringify(beatFx));

  await scaffoldProject(projectDir, html, {
    id: `${req.project_id}-narrative`,
    name: 'Xianxia narrative',
  });

  logger.info({ projectDir, base: baseSilent }, 'rendering narrative (HyperFrames 0.4)');
  await runHyperFrames(projectDir, baseSilent, fps);

  // ── FFmpeg cinematic post-pass + audio mix ──────────────────────────
  await postProcessCinematic({
    baseSilent,
    out: req.out_path,
    narrationPath: req.narration_path,
    musicPath: req.music_path,
    musicVolume: req.music_volume ?? 0.32,
    musicDucking: req.music_ducking ?? true,
    profile,
  });

  try { await unlink(baseSilent); } catch { /* ignore */ }
  try { await rm(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return { out_path: req.out_path, duration_seconds: duration, cinematic_profile: profile };
}

function buildBeatNode(b: ImageBeat, idx: number): string {
  // HyperFrames 0.4 expects timed elements to have class="clip", a stable id,
  // a data-track-index, plus data-start / data-duration. We allocate the
  // beats to track-index 2+ (0=narration, 1=music, 2..=visual beats) so
  // each lives on its own studio-friendly track.
  const dataAttrs =
    `id="beat-${idx}" class="beat clip" data-track-index="${idx + 2}" ` +
    `data-start="${b.start}" data-duration="${b.duration}"` +
    (b.transition ? ` data-trans="${b.transition}"` : '');

  // Layered render when depth-segmented assets exist; otherwise single image.
  // Paths arrive here already staged into the project's assets/ directory
  // (renderNarrative stages everything before constructing the HTML), so
  // we use them as plain relative URLs — no file:// scheme, no absolute
  // paths, which is what Chromium's file:// sandbox accepts.
  const layers = b.foreground_path || b.mid_path
    ? `
      <div class="layer bg" style="background-image: url('${b.path}');"></div>
      ${b.mid_path ? `<div class="layer mid" style="background-image: url('${b.mid_path}');"></div>` : ''}
      ${b.foreground_path ? `<div class="layer fg" style="background-image: url('${b.foreground_path}');"></div>` : ''}
    `
    : `<img class="single" src="${b.path}" alt="" />`;

  const atmosCanvas = (b.fx && b.fx !== 'none')
    ? `<div class="atmos" id="atmos-${idx}"><canvas></canvas></div>`
    : '';
  const rays = b.light_rays ? `<div class="rays"></div>` : '';

  return `
    <div ${dataAttrs}>
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
  const projectDir = req.out_path.replace(/\.\w+$/, '-thumb-proj');
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const stage = makeAssetStager(assetsDir);
  const stagedBg = await stage.copy(req.background_path, 'bg');

  const html = tmpl
    .replace('__TITLE_EN__', escapeHtml(req.title_en))
    .replace('__TITLE_ZH__', escapeHtml(req.title_zh ?? ''))
    .replace('__BG__', stagedBg);
  await scaffoldProject(projectDir, html, {
    id: `${dirname(req.out_path).split(/[\\/]/).pop()}-thumb`,
    name: 'Xianxia thumbnail',
  });
  await runHyperFrames(projectDir, req.out_path, 24, /* still */ true);
  try { await rm(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { out_path: req.out_path };
}

export async function renderShort(req: {
  clip_path: string;
  hook: string;
  subtitles_srt?: string;
  out_path: string;
}): Promise<RenderResult> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'short.html'), 'utf8');
  const duration = 30;
  const projectDir = req.out_path.replace(/\.\w+$/, '-short-proj');
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const stage = makeAssetStager(assetsDir);
  const stagedClip = await stage.copy(req.clip_path, 'clip');

  const html = tmpl
    .replace('__CLIP__', stagedClip)
    .replace('__HOOK__', escapeHtml(req.hook))
    .replace(/__DURATION__/g, String(duration));
  await scaffoldProject(projectDir, html, {
    id: `${dirname(req.out_path).split(/[\\/]/).pop()}-short`,
    name: 'Xianxia short',
  });
  await runHyperFrames(projectDir, req.out_path, 30);
  try { await rm(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { out_path: req.out_path, duration_seconds: duration, cinematic_profile: 'full' };
}

/**
 * Returns a tiny helper that copies external assets into the project's
 * `assets/` directory and returns the *relative* URL ready to drop into
 * an HTML attribute (e.g. `assets/0-bg.png`). Required because Chromium's
 * file:// sandbox refuses to load resources outside the document's
 * directory; HyperFrames runs the composition with the project dir as
 * the document root, so anything inside is loadable.
 */
function makeAssetStager(assetsDir: string) {
  let counter = 0;
  return {
    async copy(srcPath: string, label: string): Promise<string> {
      if (!srcPath) return '';
      const cleaned = srcPath.replace(/^file:\/+/i, '').replace(/^\/+/, '');
      const local = process.platform === 'win32' && /^[a-zA-Z]:/.test(cleaned)
        ? cleaned
        : srcPath;
      if (!existsSync(local)) {
        logger.warn({ srcPath, local }, 'asset to stage does not exist; leaving empty');
        return '';
      }
      const ext = extname(local) || '';
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${counter++}-${safeLabel}${ext}`;
      const dest = join(assetsDir, fileName);
      await copyFile(local, dest);
      // Return RELATIVE URL (no `file://`, no leading slash) so it resolves
      // against the index.html sibling `assets/` directory.
      return `assets/${fileName}`;
    },
  };
}

/**
 * Scaffold a HyperFrames 0.4 project: write `index.html`, `hyperframes.json`
 * and `meta.json` into `projectDir`. The `hyperframes render <DIR>` CLI
 * looks for `index.html` inside; the JSON files satisfy the manifest
 * requirements without affecting the rendered output.
 */
async function scaffoldProject(
  projectDir: string,
  indexHtml: string,
  manifest: { id: string; name: string },
): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'index.html'), indexHtml, 'utf8');
  await writeFile(
    join(projectDir, 'hyperframes.json'),
    JSON.stringify({
      $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
      registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
      paths: {
        blocks: 'compositions',
        components: 'compositions/components',
        assets: 'assets',
      },
    }, null, 2),
    'utf8',
  );
  await writeFile(
    join(projectDir, 'meta.json'),
    JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      createdAt: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
}

async function runHyperFrames(
  projectDir: string,
  out: string,
  fps: number,
  still = false,
): Promise<void> {
  const args = ['render', projectDir, '--output', out, '--fps', String(fps)];
  if (still) args.push('--still');
  try {
    // preferLocal: true lets execa find `hyperframes` from node_modules/.bin,
    // so the package can be installed locally per-sidecar (autoinstallable).
    // We capture stdout/stderr (not inherit) so we can include the real
    // CLI error in the thrown ExecaError when something fails.
    await execa('hyperframes', args, { preferLocal: true, all: true });
  } catch (err: unknown) {
    const e = err as { all?: string; stderr?: string; stdout?: string; message?: string };
    logger.error({
      cmd: ['hyperframes', ...args].join(' '),
      stderr: e?.stderr ?? null,
      stdout: e?.stdout ?? null,
      all: e?.all ?? null,
      message: e?.message ?? String(err),
    }, 'hyperframes render failed');
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
  // Software decode for the post-pass — `-hwaccel cuda` was producing
  // truncated video streams (3 s of frames stretched over a 22 s container)
  // when chained with a `-filter_complex` graph + `-vf` on the same command.
  // FFmpeg's NVDEC↔libavfilter glue doesn't reliably honour the audio
  // filter graph timing in that combo; the symptom was a corrupted moov
  // atom on every render. Keeping decode on CPU is ~5–8 % slower for this
  // step but produces correct output. Only the ENCODE side benefits from
  // GPU acceleration here, which we keep via `encoder === 'h264_nvenc'`.

  // ── Build a single -filter_complex graph that covers BOTH video and
  //    audio. Mixing `-vf` with `-filter_complex` on the same command
  //    has been the silent-failure source since v0.1.7: FFmpeg routes
  //    the implicit -vf through a different pipeline that desynchronises
  //    with the explicit complex graph, producing a video stream that
  //    decodes to ~3 s of frames against a 22 s audio track. Putting the
  //    cinematic look filters into the same graph (as a labelled `[v]`
  //    output) keeps the muxer's timing aligned with the audio map.
  //
  //    Inputs: 0=baseSilent (video+silent_audio), 1=narration. If music
  //    is present it goes in as input 2.
  const inputs = ['-i', baseSilent, '-i', narrationPath];
  const videoChain = `[0:v]${vf}[v]`;
  let audioChain: string;
  let audioOut = '[a]';

  if (musicPath && musicDucking) {
    inputs.push('-i', musicPath);
    audioChain = musicDuckingFilterComplex({
      narrationIdx: 1,
      musicIdx: 2,
      musicVolume,
      outLabel: 'a',
    });
  } else if (musicPath) {
    inputs.push('-i', musicPath);
    audioChain = `[2:a]volume=${musicVolume}[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  } else {
    audioChain = `[1:a]anull[a]`;
  }

  const filterComplex = [`${videoChain};${audioChain}`].join('');

  const cmd = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', audioOut,
    '-c:v', encoder,
    ...encodeArgs,
    '-c:a', 'aac', '-b:a', '192k',
    // -shortest so the file ends with the shortest of (video, narration).
    // baseSilent encodes the full HyperFrames composition with a silent
    // padding audio track, so its duration is always the visual length.
    '-shortest',
    // Move the moov atom to the front so players can seek immediately
    // and we never produce a "duration stays at 0" file when ffmpeg is
    // killed mid-write.
    '-movflags', '+faststart',
    out,
  ];

  logger.info({ encoder, profile, filterComplex }, 'ffmpeg cinematic post-pass');
  // preferLocal: true lets execa find `ffmpeg` from sidecar-node/node_modules/
  // .bin/ when the system PATH inherited from Tauri does not include it
  // (Windows users running ffmpeg via WinGet hit this case). Without this
  // the cinematic post-pass fails silently and the Rust pipeline falls back
  // to the FFmpeg-direct Python render, losing parallax 2.5D + atmospherics.
  // We also capture stdout/stderr so a failure surfaces in the JSONL log
  // instead of disappearing into the supervisor stdout.
  try {
    await execa('ffmpeg', cmd, { preferLocal: true, all: true });
  } catch (err: unknown) {
    const e = err as { all?: string; stderr?: string; stdout?: string; message?: string };
    logger.error(
      {
        cmd: ['ffmpeg', ...cmd].join(' '),
        stderr: e?.stderr ?? null,
        stdout: e?.stdout ?? null,
        all: e?.all ?? null,
        message: e?.message ?? String(err),
      },
      'postProcessCinematic ffmpeg failed',
    );
    throw err;
  }

  // Self-validation: probe the output and refuse to ship a file whose
  // video stream duration diverges from the container by more than 5%.
  // This was the silent-failure mode in v0.1.7..v0.1.9 — ffmpeg returned
  // 0 even though the moov atom said the video lasted 3 s while the audio
  // and container were 22 s, leaving the user staring at a frozen frame
  // for most of the runtime. The Rust caller treats this throw as a
  // signal to fall back to the FFmpeg-direct render path.
  const probe = await ffprobeDurations(out);
  if (probe.video !== null && probe.container !== null) {
    const ratio = probe.video / probe.container;
    if (ratio < 0.95 || ratio > 1.05) {
      logger.error(
        { out, probe, ratio },
        'postProcessCinematic produced a desynchronised file (video ≠ container duration)',
      );
      throw new Error(
        `postProcessCinematic output desync: video=${probe.video.toFixed(2)}s ` +
        `container=${probe.container.toFixed(2)}s (ratio=${ratio.toFixed(3)})`,
      );
    }
  }
}

/**
 * Probe an MP4's video stream + container durations with ffprobe.
 * Used as the post-render self-validation. Returns nulls if either probe
 * fails, in which case the caller treats the result as inconclusive
 * rather than as a failure.
 */
async function ffprobeDurations(file: string): Promise<{ video: number | null; container: number | null }> {
  try {
    const { stdout: vs } = await execa('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], { preferLocal: true });
    const { stdout: cs } = await execa('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], { preferLocal: true });
    const video = parseFloat(vs.trim());
    const container = parseFloat(cs.trim());
    return {
      video: Number.isFinite(video) ? video : null,
      container: Number.isFinite(container) ? container : null,
    };
  } catch {
    return { video: null, container: null };
  }
}

async function pickEncoder(): Promise<'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'> {
  try {
    const { stdout } = await execa('ffmpeg', ['-hide_banner', '-encoders'], { preferLocal: true });
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
