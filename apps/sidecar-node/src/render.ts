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
// Assets are co-located with the compiled JS at runtime: tsc emits to dist/
// and the build script mirrors src/assets → dist/assets, so __dirname/assets
// works both in `npm run dev` (tsx → src/) and in production (`node dist/…`).
const ASSETS_DIR = join(__dirname, 'assets');
const SFX_DIR = join(ASSETS_DIR, 'sfx');

export type AtmosphericFx = 'none' | 'mist' | 'embers' | 'snow' | 'dust_motes' | 'clouds';
export type Transition = 'cross' | 'flash' | 'whip' | 'inkwash';
export type SfxKind = 'whoosh' | 'impact' | 'shimmer' | 'rumble';

export interface SfxOverlay {
  /** Which bundled SFX to play. */
  kind: SfxKind;
  /** Start time, in seconds, measured from the beginning of the final video. */
  start: number;
  /** Linear gain 0..1. Defaults to 0.7. */
  volume?: number;
}

export interface ImageBeat {
  /** Single base image (used as background and as fallback when no depth layers exist). */
  path: string;
  /** Optional pre-segmented foreground layer (transparent PNG). */
  foreground_path?: string;
  /** Optional mid-distance layer (transparent PNG). */
  mid_path?: string;
  /**
   * Optional pre-rendered DepthFlow parallax MP4 for this beat. When set,
   * the renderer plays this short video as the visual content of the
   * beat instead of doing Ken Burns on the still image. DepthFlow uses a
   * per-pixel depth map (Depth-Anything-V2) + a GLSL shader to produce
   * artefact-free 2.5D parallax — much cleaner than rembg fg/bg split.
   */
  clip_path?: string;
  start: number;
  duration: number;
  /** Atmospheric particle overlay played during this beat. */
  fx?: AtmosphericFx;
  /** Transition applied at this beat's outgoing edge. */
  transition?: Transition;
  /** Add subtle directional light rays. */
  light_rays?: boolean;
  /**
   * Optional chapter-divider title. When set, the beat is treated as a chapter
   * boundary: the visual layer (rendered in the HF template by another agent)
   * will draw a divider card, and the audio layer (here in render.ts) will
   * auto-inject whoosh+impact SFX at the beat's start time.
   */
  chapter_title?: string;
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
  /**
   * Optional explicit SFX cue list. If omitted (or empty), `renderNarrative`
   * auto-generates a sensible default schedule based on the beats:
   *  - whoosh @ ~5 s (intro logo sting)
   *  - impact @ ~8 s (title card appearance)
   *  - whoosh + impact at every beat with `chapter_title`
   *  - rumble bed during the last 30 s (outro)
   */
  sfx?: SfxOverlay[];
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
  // v0.1.38: tail of pure music + fade-to-black after narration ends.
  const MUSIC_TAIL_SEC = 5.0;
  // v0.7.4 — viral-style intro: 1.5 s OVER the first beat image (no more
  // dead black card). User feedback on 2026-05-20: "las intros no me
  // gustan porque hacen como un sonido estruendoso, ponen el título y
  // luego empieza el vídeo, tienen que ser mucho más virales". 6 s of
  // black + sudden music hit = instant viewer drop. New behaviour:
  //   • Beats start at t = 0 (first image visible immediately).
  //   • Title overlays on top of the first image for 1.5 s only.
  //   • Music fades in 0 → 100 % across those 1.5 s.
  //   • Narrator stays silent for 1.5 s (audio post-processor prepends
  //     1500 ms of silence) so first sentence lands cleanly after the
  //     title card fades out.
  const INTRO_SEC = 1.5;
  for (const b of req.images) {
    b.start = (b.start ?? 0) + INTRO_SEC;
  }
  const beatsLastIndex = req.images.length - 1;
  if (beatsLastIndex >= 0) {
    req.images[beatsLastIndex].duration = (req.images[beatsLastIndex].duration ?? 0) + MUSIC_TAIL_SEC;
  }
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

  // v0.1.38 (regression fix): parallax 2.5D was producing broken
  // geometry whenever the foreground subject occupied a large fraction
  // of the frame — rembg's inpaint had to "guess" what was behind a
  // big shape (e.g. a pharaoh statue covering a pyramid peak) and the
  // hallucinated fill was visible as torn / smeared backgrounds even
  // with heavy bg blur. Until we have a depth-gradient model (MiDaS /
  // Depth-Anything) we drop the layered render and serve every beat
  // as a single full-frame image with Ken Burns. KenBurns + cinematic
  // grade + transitions + tail-fade is enough on its own.
  const stagedBeats: ImageBeat[] = [];
  for (let i = 0; i < req.images.length; i++) {
    const b = req.images[i];
    stagedBeats.push({
      ...b,
      path: await stage.copy(b.path, `bg-${i}`),
      // Foreground / mid layers intentionally dropped — see comment above.
      foreground_path: undefined,
      mid_path: undefined,
      // v0.1.38: stage the DepthFlow parallax clip too. When present the
      // renderer prefers it over the still image (single layer + KenBurns)
      // because DepthFlow already bakes the camera move + 2.5D parallax.
      clip_path: b.clip_path
        ? await stage.copy(b.clip_path, `clip-${i}`)
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
  // v0.1.38: intro eyebrow — small tracked-caps line above the title.
  // Defaults to "DOCUMENTAL" so it's never a watermark of the app's
  // own brand; callers can pass `intro_eyebrow` on the request to use
  // the topic's setting tag (e.g. "ANTIGUO EGIPTO · HISTORIA REAL").
  const introEyebrow = ((req as { intro_eyebrow?: string }).intro_eyebrow || 'DOCUMENTAL').trim();
  const html = tmpl
    .replace(/__TITLE__/g, escapeHtml(req.title))
    .replace(/__INTRO_EYEBROW__/g, escapeHtml(introEyebrow))
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

  // ── Auto-map default SFX cues if the caller didn't pass any ─────────
  // The auto-schedule layers cinematic accents over the standard intro/
  // outro beats; chapter dividers are detected via `chapter_title`.
  // If the caller passed any sfx[] (even empty) we honour it verbatim so
  // tests can opt-out by sending `[]`.
  const sfxOverlays: SfxOverlay[] = Array.isArray(req.sfx)
    ? req.sfx.slice()
    : autoMapSfx(req.images, duration);

  // ── FFmpeg cinematic post-pass + audio mix ──────────────────────────
  await postProcessCinematic({
    baseSilent,
    out: req.out_path,
    narrationPath: req.narration_path,
    musicPath: req.music_path,
    musicVolume: req.music_volume ?? 0.32,
    musicDucking: req.music_ducking ?? true,
    profile,
    sfxOverlays,
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

  // Layered render priority:
  //   1. DepthFlow parallax clip (clip_path) — preferred. The MP4 already
  //      contains the camera move + 2.5D parallax baked in by DepthFlow,
  //      so the renderer just plays it. We mute it (audio comes from the
  //      narration / music tracks) and have it loop in case its duration
  //      doesn't match the beat (DepthFlow generates exact-length clips
  //      per beat by default, so loop is a safety net).
  //   2. Layered render bg+fg+mid (rembg) — legacy path; currently
  //      disabled upstream because of inpaint artefacts.
  //   3. Single still image — fallback for when no clip exists.
  let layers: string;
  if (b.clip_path) {
    layers = `<video class="single dfclip" data-track-index="${idx + 2}" data-start="${b.start}" data-duration="${b.duration}" src="${b.clip_path}" muted preload="auto" loop></video>`;
  } else if (b.foreground_path || b.mid_path) {
    layers = `
      <div class="layer bg" style="background-image: url('${b.path}');"></div>
      ${b.mid_path ? `<div class="layer mid" style="background-image: url('${b.mid_path}');"></div>` : ''}
      ${b.foreground_path ? `<div class="layer fg" style="background-image: url('${b.foreground_path}');"></div>` : ''}
    `;
  } else {
    layers = `<img class="single" src="${b.path}" alt="" />`;
  }

  const atmosCanvas = (b.fx && b.fx !== 'none')
    ? `<div class="atmos" id="atmos-${idx}"><canvas></canvas></div>`
    : '';
  const rays = b.light_rays ? `<div class="rays"></div>` : '';
  // v0.1.38 — chapter divider card (F3). When the beat carries a
  // chapter_title, we render a slate over the first ~1.0 s of the beat
  // (animated by GSAP in narrative.html) so the viewer gets a visible
  // section break — matches the documentary-essay storytelling rhythm.
  const chapterCard = b.chapter_title
    ? `<div class="chapter-card" id="chapter-${idx}">
         <div class="rule"></div>
         <div class="title">${escapeHtml(b.chapter_title)}</div>
         <div class="rule bottom"></div>
       </div>`
    : '';

  return `
    <div ${dataAttrs}>
      ${layers}
      ${atmosCanvas}
      ${rays}
      ${chapterCard}
    </div>`;
}

export async function renderThumbnail(req: {
  /** Primary headline (rendered uppercase, big, with gold accent on the
   *  first word). The caller usually passes the video's `title_en`. */
  title_en: string;
  /** Optional second-language title; passed through for backward compat
   *  but no longer rendered separately — the new template shows ONE
   *  punchy uppercase title for maximum click-through. */
  title_zh?: string;
  /** Optional small uppercased subtitle line at the bottom (channel name,
   *  episode tag, etc.). Falls back to topic if not provided. */
  subtitle?: string;
  /** Optional small red badge top-left ("EPIC", "REAL STORY", "1990s"). */
  badge?: string;
  background_path: string;
  out_path: string;
}): Promise<{ out_path: string }> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'thumbnail.html'), 'utf8');
  const projectDir = req.out_path.replace(/\.\w+$/, '-thumb-proj');
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const stage = makeAssetStager(assetsDir);
  const stagedBg = await stage.copy(req.background_path, 'bg');

  // v0.1.37: viral template uses a single punchy title + small subtitle +
  // optional badge. We map the legacy title_en / title_zh fields into the
  // new placeholders so old callers still work without changes.
  const headline = (req.title_en || req.title_zh || '').trim();
  const subtitle = (req.subtitle || '').trim();
  const badge = (req.badge || '').trim();
  // v0.1.42: global regex replace — each placeholder appears twice in
  // thumbnail.html (once in the documenting CSS comment, once in the
  // real HTML). The previous string-form `.replace()` only hit the
  // first occurrence (the comment) and left the rendered HTML with
  // literal `__TITLE__` / `__BADGE__` / `__SUBTITLE__` on screen.
  const html = tmpl
    .replace(/__TITLE__/g, escapeHtml(headline))
    .replace(/__SUBTITLE__/g, escapeHtml(subtitle))
    .replace(/__BADGE__/g, escapeHtml(badge))
    .replace(/__BG__/g, stagedBg);
  await scaffoldProject(projectDir, html, {
    id: `${dirname(req.out_path).split(/[\\/]/).pop()}-thumb`,
    name: 'thumbnail',
  });
  // HyperFrames CLI's --still flag is broken when out_path is a JPG: ffmpeg's
  // image2 muxer rejects "thumbnail.jpg" without -update 1 / -frames:v 1 and
  // the render fails at the Faststart stage. Render to a 1-frame MP4 first
  // (HF handles MP4 fine) and extract the JPG with a direct ffmpeg call.
  const tmpMp4 = req.out_path.replace(/\.\w+$/, '.tmp.mp4');
  await runHyperFrames(projectDir, tmpMp4, 24, /* still */ true);
  try {
    await execa('ffmpeg', [
      '-y',
      '-i', tmpMp4,
      '-frames:v', '1',
      '-q:v', '2',
      req.out_path,
    ], { preferLocal: true });
  } finally {
    try { await unlink(tmpMp4); } catch { /* ignore */ }
  }
  try { await rm(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { out_path: req.out_path };
}

export interface ShortWord {
  /** The visible token (Whisper word, with leading whitespace stripped). */
  w: string;
  /** Start time in seconds, zero-based on the Short's own timeline. */
  s: number;
  /** End time in seconds. Must be > s. */
  e: number;
}

export async function renderShort(req: {
  /** Vertical 1080×1920 clip from _smart_reframe_to_vertical (Pass 1). */
  clip_path: string;
  /** Total duration of the clip in seconds. */
  duration: number;
  /** Big attention-grabber rendered for the first 1.5–2 s. */
  hook: string;
  /** Word-level Whisper timings for animated captions. Empty array =
   *  no captions (the previous "hook only" v1 behaviour). */
  words?: ShortWord[];
  /** Optional CTA copy for the last 1.5 s. Falls back to canned defaults. */
  cta_title?: string;
  cta_sub?: string;
  out_path: string;
}): Promise<RenderResult> {
  const tmpl = await readFile(join(TEMPLATES_DIR, 'short.html'), 'utf8');
  // v0.1.22: composition duration = clip duration + 1.2 s tail.
  // The tail is intentional: the CTA card needs ~1.5 s on screen
  // for the viewer to read "GRACIAS / Suscríbete" without the video
  // ending mid-sentence. The video element runs to its natural end
  // (data-duration = clipDuration), then the last frame freezes for
  // the remaining tail while the CTA card is fully visible.
  const clipDuration = req.duration > 0 ? req.duration : 30;
  const duration = clipDuration + 1.2;
  const projectDir = req.out_path.replace(/\.\w+$/, '-short-proj');
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  // v0.1.22 A0: validate the input clip BEFORE staging. If the clip
  // path is missing or unreadable we used to silently emit `<video
  // src="">` and let HyperFrames fail 45 s later with the cryptic
  // "video first frame not decoded after 45000ms" error — wasting a
  // full render budget per short. Fail loud here instead so the
  // sidecar's HTTP 500 carries the actionable cause.
  if (!req.clip_path) {
    throw new Error('renderShort: clip_path is empty');
  }
  if (!existsSync(req.clip_path)) {
    throw new Error(`renderShort: clip_path does not exist: ${req.clip_path}`);
  }

  const stage = makeAssetStager(assetsDir);
  const stagedClip = await stage.copy(req.clip_path, 'clip');
  if (!stagedClip) {
    throw new Error(`renderShort: stage.copy returned empty for ${req.clip_path}`);
  }

  // ── Build OpusClip Mozi-style caption GROUPS ──────────────────────
  // OpusClip Mozi shows 2-3 words on screen at a time with the active
  // word highlighted in yellow and rolled through the group; when the
  // group ends, the next group replaces it with a quick crossfade.
  // This reads MUCH better than 1-word-at-a-time hard-kill (the
  // previous v0.1.22 attempt) because:
  //   - Words don't disappear during silence pauses between sentences
  //   - The reader's eye sees context (previous + next word in chunk)
  //   - Caption density matches the audio cadence naturally
  // Group rules: max 3 words OR 22 chars OR 0.6 s pause between words.
  const words = (req.words ?? []).filter(
    (w) => w && w.e > w.s && w.w.trim().length > 0,
  );
  type Group = { words: typeof words; start: number; end: number };
  const groups: Group[] = [];
  {
    let cur: typeof words = [];
    let curChars = 0;
    for (const w of words) {
      const wlen = w.w.trim().length;
      const tooManyWords = cur.length >= 3;
      const tooManyChars = cur.length > 0 && curChars + 1 + wlen > 22;
      const longGap =
        cur.length > 0 && w.s - cur[cur.length - 1].e > 0.6;
      if (tooManyWords || tooManyChars || longGap) {
        if (cur.length > 0) {
          groups.push({
            words: cur,
            start: cur[0].s,
            end: cur[cur.length - 1].e,
          });
          cur = [];
          curChars = 0;
        }
      }
      cur.push(w);
      curChars += (cur.length === 1 ? 0 : 1) + wlen;
    }
    if (cur.length > 0) {
      groups.push({
        words: cur,
        start: cur[0].s,
        end: cur[cur.length - 1].e,
      });
    }
  }
  const captionsHtml = groups
    .map((g, gi) => {
      const inner = g.words
        .map((w, wi) => {
          const safe = escapeHtml(w.w.trim().toUpperCase());
          return (
            `<span class="word" data-wi="${wi}">` +
            `<span class="w-base">${safe}</span>` +
            `<span class="w-active">${safe}</span>` +
            `</span>`
          );
        })
        .join(' ');
      return `<div class="cap-group" data-gi="${gi}">${inner}</div>`;
    })
    .join('\n');
  // Pass timing data per group + per word inside each group, so the
  // template JS can build a clean GSAP timeline without re-parsing
  // word boundaries.
  const wordsJson = JSON.stringify(
    groups.map((g) => ({
      s: round3(g.start),
      e: round3(g.end),
      words: g.words.map((w) => ({ s: round3(w.s), e: round3(w.e) })),
    })),
  );

  const ctaTitle = (req.cta_title ?? 'SUSCRÍBETE').slice(0, 40);
  const ctaSub = (req.cta_sub ?? '▶ Más historias en el canal').slice(0, 90);

  const html = tmpl
    .replace('__CLIP__', stagedClip)
    .replace('__HOOK__', escapeHtml((req.hook ?? '').slice(0, 80)))
    .replace('__CAPTIONS_HTML__', captionsHtml)
    .replace('__WORDS_JSON__', wordsJson)
    .replace('__CTA_TITLE__', escapeHtml(ctaTitle))
    .replace('__CTA_SUB__', escapeHtml(ctaSub))
    // __CLIP_DURATION__ FIRST so subsequent __DURATION__ replacement
    // doesn't accidentally match the substring.
    .replace(/__CLIP_DURATION__/g, String(clipDuration))
    .replace(/__DURATION__/g, String(duration));

  await scaffoldProject(projectDir, html, {
    id: `${dirname(req.out_path).split(/[\\/]/).pop()}-short`,
    name: 'Xianxia short',
  });

  // 30 fps is plenty for vertical Shorts on mobile and keeps the render
  // ~2× faster than 60 fps without any perceptible difference at the
  // resolution / typical viewing distance.
  logger.info(
    {
      clip: stagedClip,
      duration,
      words: words.length,
      hook: (req.hook ?? '').slice(0, 60),
    },
    'rendering short v2 (HyperFrames + animated captions)',
  );
  await runHyperFrames(projectDir, req.out_path, 30);
  // v0.1.22 A0 debug: preserve projectDir if env var XIANXIA_KEEP_SHORT_PROJ=1
  // so we can inspect the generated HTML and verify GSAP/HyperFrames behaviour.
  if (!process.env.XIANXIA_KEEP_SHORT_PROJ) {
    try {
      await rm(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    logger.info({ projectDir }, 'short projectDir KEPT for debug (XIANXIA_KEEP_SHORT_PROJ)');
  }
  return {
    out_path: req.out_path,
    duration_seconds: duration,
    cinematic_profile: 'full',
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
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
      if (!srcPath) {
        // v0.1.22 A0: empty string fallback was the silent bug that
        // produced `<video src="">` and made HyperFrames fail 45 s
        // later with a cryptic "first frame not decoded" error.
        // Throwing here forces the caller (renderShort / renderNarrative)
        // to handle a missing-asset case explicitly.
        throw new Error(`stage.copy: srcPath empty for label=${label}`);
      }
      const cleaned = srcPath.replace(/^file:\/+/i, '').replace(/^\/+/, '');
      const local = process.platform === 'win32' && /^[a-zA-Z]:/.test(cleaned)
        ? cleaned
        : srcPath;
      if (!existsSync(local)) {
        throw new Error(`stage.copy: asset does not exist (label=${label}, path=${local})`);
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

/**
 * Build the default cinematic SFX schedule for a narrative video.
 *
 * Heuristics:
 *  - whoosh @ 5 s   — logo sting / intro swell
 *  - impact @ 8 s   — title card appearance
 *  - whoosh @ chapterStart, impact @ chapterStart + 0.6 s — chapter dividers
 *  - rumble @ duration - 30 s (or earlier if the video is short) — outro bed
 *
 * The caller can always override the whole schedule by passing `sfx` on the
 * NarrativeRequest. If the video is shorter than the default cue points the
 * cue is dropped (we never schedule SFX past the video end).
 */
function autoMapSfx(beats: ImageBeat[], totalDuration: number): SfxOverlay[] {
  const out: SfxOverlay[] = [];

  // v0.1.38 (refactor 2): MUCH softer intro accents. The previous volumes
  // (whoosh 0.55 / impact 0.7) sounded harsh on top of the music swell —
  // the user described it as "un sonido raro y fuerte horrible". Drop
  // the intro impact entirely and keep only a SUBTLE whoosh that whispers
  // under the rule animation. The closing whoosh at 5.3 s is also quiet
  // so the transition into beat 0 feels natural, not punctuated.
  if (totalDuration > 6) {
    out.push({ kind: 'whoosh', start: 0.5, volume: 0.18 });
    out.push({ kind: 'whoosh', start: 5.3, volume: 0.18 });
  }

  // Chapter dividers — every beat marked with `chapter_title` gets a
  // whoosh+impact pair anchored at its start. Beat timestamps already
  // include the +6 s intro offset so we just skip anything that would
  // collide with the intro window or fall past the video end.
  for (const b of beats) {
    if (!b.chapter_title) continue;
    if (b.start < 8) continue;
    if (b.start + 0.6 >= totalDuration) continue;
    out.push({ kind: 'whoosh', start: b.start, volume: 0.6 });
    out.push({ kind: 'impact', start: b.start + 0.6, volume: 0.6 });
  }

  // Outro rumble bed — last ~30 s if the video is long enough, else last
  // 1/4 of the runtime. Volume is intentionally low (it's a bed, not a hit).
  if (totalDuration > 12) {
    const outroStart = totalDuration > 60
      ? Math.max(0, totalDuration - 30)
      : Math.max(0, totalDuration * 0.75);
    out.push({ kind: 'rumble', start: outroStart, volume: 0.35 });
  }

  return out;
}

/**
 * Resolve a SfxOverlay.kind to its absolute WAV path. Throws if the file
 * is missing — that's a packaging error (build step didn't copy assets/).
 */
function sfxPath(kind: SfxKind): string {
  const file = join(SFX_DIR, `${kind}.wav`);
  if (!existsSync(file)) {
    throw new Error(`sfxPath: bundled SFX not found at ${file}. Did the build step copy src/assets to dist/assets?`);
  }
  return file;
}

async function postProcessCinematic(opts: {
  baseSilent: string;
  out: string;
  narrationPath: string;
  musicPath?: string;
  musicVolume: number;
  musicDucking: boolean;
  profile: CinematicProfile;
  sfxOverlays?: SfxOverlay[];
}): Promise<void> {
  const { baseSilent, out, narrationPath, musicPath, musicVolume, musicDucking, profile } = opts;
  const sfxOverlays = opts.sfxOverlays ?? [];
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
  // v0.1.38: rounded ending with music tail.
  // The HF composition is now extended by MUSIC_TAIL_SEC (5 s) past the
  // narration end — see renderNarrative. During that tail the last image
  // holds and the music plays alone. We fade BOTH video and audio over
  // those final seconds so the clip closes with a credits-style fade-to-
  // black + slow audio tail-out, not an abrupt cut.
  const MUSIC_TAIL_SEC = 5.0;
  const INTRO_SEC = 1.5;  // v0.7.4 — viral 1.5 s intro over first beat
  const fadeDurationSec = 4.0;        // fade lasts most of the tail
  const fadeStartOffset = 1.0;        // …starting 1 s into the tail (gives the music a beat to breathe before fading)
  const probedNarration = await ffprobeDurations(narrationPath).catch(() => ({ video: null, container: null }));
  const narrationDuration = probedNarration.container ?? probedNarration.video ?? 0;
  // v0.1.38 (refactor): the timeline is now INTRO_SEC + narrationDuration
  // + MUSIC_TAIL_SEC. Fade-out starts 1 s into the tail (i.e. 1 s after
  // the narrator finishes) and lasts 4 s, finishing exactly at the end
  // of the composition.
  const fadeStart = INTRO_SEC + narrationDuration + fadeStartOffset;
  const videoChain = narrationDuration > 0
    ? `[0:v]${vf},fade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDurationSec}[v]`
    : `[0:v]${vf}[v]`;
  let audioChain: string;
  let audioOut = '[a]';
  void MUSIC_TAIL_SEC;

  // v0.1.38: pad narration with 5 s of silence so the audio mix lasts
  // through the music-only tail. Without this, `amix duration=first`
  // would cut all audio at narration end and the tail would play with
  // no music. We splice the apad in front of every audio chain so all
  // three branches (ducking / music-only / no-music) pick up the
  // padded stream as their narration source.
  // v0.1.38 (refactor): prepend INTRO_SEC of silence + append 5 s tail.
  // adelay=N adds N ms of silence at the START so the narrator's first
  // sentence aligns with the intro card's fade-out (renderNarrative
  // pushes beats by INTRO_SEC = 6 s; same offset goes here). apad=5s
  // appends silence at the END so the music tail keeps playing with
  // amix duration=longest.
  // v0.7.4 — 1500 ms (was 6000) so the narrator's first word arrives
  // right after the title card fades out — no more dead air.
  const INTRO_SILENCE_MS = 1500;
  // v0.7.4 — music fade-in over the intro duration so the soundtrack
  // ramps up from silence instead of slamming in at full volume against
  // a dead intro. afade type=in, start at 0, duration 1.5 s, curve qsin
  // gives a smooth perceptual ramp. Applied BEFORE the volume gain so
  // both the fade and the static music gain stay correct.
  const MUSIC_FADEIN_SEC = 1.5;
  const narrationPad =
    `[1:a]adelay=${INTRO_SILENCE_MS}|${INTRO_SILENCE_MS},apad=pad_dur=5[npad]`;
  if (musicPath && musicDucking) {
    inputs.push('-i', musicPath);
    // The ducking filter expects narrationIdx:a, but we want it to read
    // the padded version. We rebuild the ducking graph inline using
    // [npad] as the narration source.
    audioChain =
      `${narrationPad};` +
      `[2:a]afade=t=in:st=0:d=${MUSIC_FADEIN_SEC}:curve=qsin,volume=${musicVolume}[m1];` +
      `[npad]asplit=2[n1][n2];` +
      `[m1][n1]sidechaincompress=threshold=0.04:ratio=10:attack=20:release=350:makeup=1.0[duck];` +
      `[duck][n2]amix=inputs=2:duration=longest:dropout_transition=0[a]`;
  } else if (musicPath) {
    inputs.push('-i', musicPath);
    audioChain = `${narrationPad};[2:a]afade=t=in:st=0:d=${MUSIC_FADEIN_SEC}:curve=qsin,volume=${musicVolume}[m];[npad][m]amix=inputs=2:duration=longest:dropout_transition=0[a]`;
  } else {
    audioChain = `${narrationPad};[npad]anull[a]`;
  }
  // Silence the unused musicDuckingFilterComplex import to keep
  // compilers happy when the helper is no longer the live path.
  void musicDuckingFilterComplex;

  // ── SFX overlay layer ──────────────────────────────────────────────
  // Each SfxOverlay is loaded as an extra `-i sfx.wav` input AFTER the
  // narration/music inputs already in `inputs`. We then build a small
  // sub-graph that delays each SFX by `start*1000 ms` (adelay needs ms
  // per channel; our WAVs are stereo so we use `delay|delay`) and amixes
  // it onto the post-duck `[a]` stream into a new label `[apostsfx]`.
  // We DO NOT touch the narration ducking chain — SFX are a layer on
  // top, mixed at their own per-cue volume.
  //
  // The first SFX gets ffmpeg input index `firstSfxIdx`, where:
  //   firstSfxIdx = 2 (no music) | 3 (music or music+ducking)
  // matching the order in `inputs[]`.
  const firstSfxIdx = musicPath ? 3 : 2;
  const validSfx = sfxOverlays.filter(
    (s) => s && Number.isFinite(s.start) && s.start >= 0,
  );
  let sfxSubGraph = '';
  let postSfxLabel = audioOut;        // [a]
  if (validSfx.length > 0) {
    for (const s of validSfx) {
      inputs.push('-i', sfxPath(s.kind));
    }
    const sfxLabels: string[] = [];
    validSfx.forEach((s, i) => {
      const idx = firstSfxIdx + i;
      const delayMs = Math.max(0, Math.round(s.start * 1000));
      const vol = s.volume ?? 0.7;
      const lbl = `s${i}`;
      sfxLabels.push(`[${lbl}]`);
      // adelay needs one delay per channel (stereo → "ms|ms").
      sfxSubGraph +=
        `;[${idx}:a]volume=${vol.toFixed(3)},` +
        `adelay=${delayMs}|${delayMs}[${lbl}]`;
    });
    // amix together the existing mix + every delayed SFX. duration=longest
    // matches the existing narration+music chain semantics (the apad on the
    // narration already extends through the music tail).
    const totalInputs = 1 + sfxLabels.length;
    sfxSubGraph += `;${audioOut}${sfxLabels.join('')}` +
      `amix=inputs=${totalInputs}:duration=longest:dropout_transition=0:normalize=0[apostsfx]`;
    postSfxLabel = '[apostsfx]';
  }

  // ── Final fade-out (video + audio together, over the music tail) ───
  // Applied AFTER SFX so that any SFX cue near the end fades out with
  // the rest of the audio rather than sticking out over a black frame.
  const audioFadeSuffix = narrationDuration > 0
    ? `;${postSfxLabel}afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDurationSec}[afaded]`
    : `;${postSfxLabel}anull[afaded]`;
  audioOut = '[afaded]';

  const filterComplex = [`${videoChain};${audioChain}${sfxSubGraph}${audioFadeSuffix}`].join('');

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

  logger.info(
    { encoder, profile, sfxCount: validSfx.length, filterComplex },
    'ffmpeg cinematic post-pass',
  );
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
