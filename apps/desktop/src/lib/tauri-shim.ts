/**
 * Browser-mode shim for `@tauri-apps/api/core` and `@tauri-apps/api/event`.
 *
 * When the app runs inside the Tauri webview, `window.__TAURI_INTERNALS__`
 * is present and we re-export the real `invoke` / `listen` from the official
 * Tauri SDK.
 *
 * When the app runs in a regular browser (e.g. `pnpm dev` opened in
 * Chromium / Playwright), this module supplies a working drop-in:
 *
 *   - `invoke(cmd, args)` is mapped to:
 *       · HTTP calls to the Python sidecar (:8731), Node sidecar (:8732),
 *         and Ollama (:11434)
 *       · `localStorage`-backed projects CRUD
 *       · in-process orchestration for `start_generation` (the same step
 *         sequence the Rust pipeline uses), emitting `pipeline:progress`
 *         events as it runs
 *       · sensible mocks for app-version / hardware where no remote
 *         endpoint exists
 *
 *   - `listen(event, cb)` returns an `UnlistenFn` and receives all events
 *     dispatched by the in-process emitter (so the UI sees the same
 *     wizard updates it would see in Tauri).
 *
 * The whole point: anything that breaks when driven by Playwright in
 * browser mode would also break inside the Tauri webview, since both go
 * through the same UI flow. Bugs surface here without needing to spin
 * up the full Tauri shell.
 */

const TAURI =
  typeof window !== 'undefined' &&
  // Tauri 2 sets this internal hook before the app loads
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined;

const PY = 'http://127.0.0.1:8731';
const NODE = 'http://127.0.0.1:8732';
const OLLAMA = 'http://127.0.0.1:11434';

// ─── Event emitter (used by listen() in browser mode) ──────────────
type EventCb = (payload: unknown) => void;
const emitter = new Map<string, Set<EventCb>>();

function emit(event: string, payload: unknown) {
  emitter.get(event)?.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error('listen handler', event, e);
    }
  });
}

export type UnlistenFn = () => void;

// ─── HTTP helpers ──────────────────────────────────────────────────
async function http<T>(
  base: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  timeoutMs = 600_000,
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    }
    if (r.status === 204) return undefined as unknown as T;
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

const reachable = async (url: string) =>
  fetch(url, { method: 'GET' }).then((r) => r.ok).catch(() => false);

// ─── localStorage projects store ───────────────────────────────────
interface ShimProject {
  id: string;
  title: string;
  topic: string;
  status: string;
  languages: string;
  duration_seconds: number | null;
  created_at: number;
  updated_at: number;
  error_message: string | null;
}

const PROJECTS_KEY = 'xianxia.shim.projects';

const projectsStore = {
  list(): ShimProject[] {
    try {
      return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
    } catch {
      return [];
    }
  },
  save(p: ShimProject[]) {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(p));
  },
  create(args: { title: string; topic: string; languages: string[] }): ShimProject {
    const list = this.list();
    const now = Math.floor(Date.now() / 1000);
    const proj: ShimProject = {
      id: crypto.randomUUID(),
      title: args.title,
      topic: args.topic,
      status: 'pending',
      languages: JSON.stringify(args.languages),
      duration_seconds: null,
      created_at: now,
      updated_at: now,
      error_message: null,
    };
    list.unshift(proj);
    this.save(list);
    return proj;
  },
  update(id: string, patch: Partial<ShimProject>) {
    const list = this.list();
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const cur = list[idx];
    if (!cur) return;
    list[idx] = { ...cur, ...patch, updated_at: Math.floor(Date.now() / 1000) };
    this.save(list);
  },
};

// ─── Pipeline orchestration (mirrors Rust src-tauri/pipeline) ─────
interface GenerateArgs {
  topic: string;
  languages: string[];
  target_minutes: number;
  experimental_llm: boolean;
  vertical?: boolean;
  voice_speaker?: string;
  use_musicgen?: boolean;
  llm_model?: string;
  /** legacy alias accepted for backward compat with older shim callers */
  voice?: string;
}

interface ScriptResp {
  narration: string;
  markers: { seq: number; kind: string; timestamp_seconds: number; prompt?: string; mood?: string; title?: string }[];
  word_count: number;
  estimated_seconds: number;
}

const phase = (
  project_id: string,
  phase: number,
  status: 'running' | 'done' | 'failed',
  progress: number,
  message: string,
) => emit('pipeline:progress', {
  project_id, phase, status,
  // v0.1.46 parity fix: the Rust supervisor (pipeline/mod.rs) emits
  // `progress` on the 0–100 scale (`emit(..., 100.0, ...)`), and the
  // generator UI does `Math.round(update.progress)` expecting that
  // scale. The shim used to send 0–1 fractions, so a "done" phase
  // showed "1%" in the sidebar instead of "100%". Normalise here so
  // the call sites can keep using either convention without bugs.
  progress: progress <= 1 ? progress * 100 : progress,
  message,
});

/** Sequential VRAM swap: free the previous phase's model before the next loads.
 * Best-effort — never fails the pipeline if the unload endpoint isn't reachable.
 */
async function unloadModels(targets: string[]): Promise<void> {
  for (const t of targets) {
    try {
      await http<unknown>(PY, `/unload?target=${encodeURIComponent(t)}`, 'POST', {}, 30_000);
    } catch {
      /* sidecar not ready or already freed — ignore */
    }
  }
}

async function runPipeline(project_id: string, args: GenerateArgs): Promise<void> {
  const vertical = args.vertical ?? false;
  const W = vertical ? 1080 : 1920;
  const H = vertical ? 1920 : 1080;
  const lang = args.languages[0] || 'en';

  try {
    // Phase 1: Script (xianxia-llm thinking can take ~1-3 min)
    phase(project_id, 1, 'running', 0.05, 'Generando guion con xianxia-llm…');
    const script = await http<ScriptResp>(PY, '/script', 'POST', {
      topic: args.topic,
      target_minutes: args.target_minutes,
      languages: args.languages,
      model: 'xianxia-llm',
    },
    // v0.1.46: was 10 min, raised to 30 min. The Python sidecar's
    // `/script` route itself uses `timeout=900.0` (15 min) per Ollama
    // call AND runs up to 6 passes for long-form scripts, so the
    // worst-case totalcan reach 20-25 min when Ollama is cold +
    // Wikipedia RAG is slow + multi-pass is engaged. Aborting at
    // 10 min cancelled the request just as the LLM was finishing,
    // surfaced as "pipeline failed AbortError" in the console.
    30 * 60_000);
    phase(project_id, 1, 'done', 1, `${script.word_count} palabras, ${Math.round(script.estimated_seconds)}s estimados`);

    // Unload Ollama xianxia-llm — frees ~3 GB VRAM for the TTS phase next.
    await unloadModels(['ollama']);

    // Phase 2: Metadata
    // v0.1.46: was fire-and-forget BEFORE TTS, which made Ollama (xianxia-llm)
    // re-occupy ~6 GB of VRAM in parallel with Qwen3-TTS loading. The two
    // models then thrashed each other and TTS fell back to CPU/RAM ⇒ 14×
    // slower (4 min per chunk instead of 15 s). On RTX 4060 8 GB the two
    // can't coexist. Solution: skip metadata in browser/shim mode (it's
    // best-effort anyway and not on the critical visible-video path).
    // The Rust supervisor in prod runs metadata sequentially AFTER tts
    // unload, so this only matters in dev/shim.
    phase(project_id, 2, 'done', 1, 'Metadatos saltado (sin bloquear VRAM de TTS)');

    // Phase 3: TTS narration. Qwen3-TTS first-load + chunked generation can take
    // 15-25 min for ~3 min audio on RTX 4060 (model load is ~5 min, then ~1 min
    // per 600-char chunk). Generous 30-min cap so we never abort mid-render.
    phase(project_id, 3, 'running', 0.1, 'Sintetizando voz Qwen3-TTS…');
    const tts = await http<{ audio_path: string; duration_seconds: number; chunks: number }>(
      PY,
      '/tts',
      'POST',
      {
        text: script.narration,
        language: langToQwen(lang),
        speaker: args.voice_speaker || args.voice || 'Vivian',
        instruction: 'Read with the gravitas of an epic mythology narrator. Slow, deep, cinematic.',
        chunk_chars: 600,
      },
      30 * 60_000,
    );
    phase(project_id, 3, 'done', 1, `${tts.duration_seconds.toFixed(1)}s en ${tts.chunks} fragmentos`);

    // Unload Qwen3-TTS — frees ~4-5 GB VRAM for Z-Image-Turbo next.
    await unloadModels(['tts']);

    // Phase 4: Images (one per IMAGE marker)
    const imgMarkers = script.markers.filter((m) => m.kind === 'image' && m.prompt);
    type Beat = {
      path: string;
      start: number;
      duration: number;
      fx?: string;
      transition?: string;
      foreground_path?: string;
      mid_path?: string;
    };
    const beats: Beat[] = [];
    let beatStart = 0;
    for (let i = 0; i < imgMarkers.length; i++) {
      const m = imgMarkers[i];
      if (!m || !m.prompt) continue;
      phase(project_id, 4, 'running', i / Math.max(1, imgMarkers.length),
            `Imagen ${i + 1}/${imgMarkers.length}…`);
      const img = await http<{ image_path: string; seed: number }>(PY, '/image', 'POST', {
        prompt: m.prompt,
        width: vertical ? 768 : 1344,
        height: vertical ? 1344 : 768,
        seed: 1000 + i,
        steps: 8,
        style_preset: true,
      }, 10 * 60_000);
      // Beat duration: from this marker timestamp to the next (or end of audio)
      const nextTs = imgMarkers[i + 1]?.timestamp_seconds ?? tts.duration_seconds;
      const dur = Math.max(2, nextTs - m.timestamp_seconds);
      beats.push({
        path: img.image_path,
        start: beatStart,
        duration: dur,
        fx: ['mist', 'embers', 'dust_motes', 'clouds', 'snow'][i % 5],
        transition: ['cross', 'flash', 'inkwash', 'whip', 'cross'][i % 5],
      });
      beatStart += dur;
    }
    phase(project_id, 4, 'done', 1, `${beats.length} imágenes`);

    // Unload ComfyUI (Z-Image + Qwen3-4B encoder) — frees ~11 GB VRAM for the
    // depth segmentation + render+subtitles phases.
    await unloadModels(['comfyui', 'image']);

    // Phase 4b: DepthFlow 2.5D parallax — produces an MP4 clip per beat.
    // v0.1.46: mirrors the Rust supervisor (pipeline/mod.rs). Was using
    // legacy rembg /depth/batch (deprecated since v0.1.23 because of the
    // "broken pyramid tops" artefact). Now calls /depthflow/batch which
    // generates GLSL-shaded clips via DepthFlow, and tolerates partial
    // results (mixed clip + KenBurns timeline).
    phase(project_id, 4, 'running', 0.7, 'Parallax 2.5D (DepthFlow)…');
    let layeredBeats = beats;
    try {
      // Health check first (matches Rust supervisor behaviour).
      const dfHealth = await http<{ venv_python_exists: boolean; runner_script_exists: boolean }>(
        PY, '/depthflow/health', 'GET', undefined, 5_000,
      ).catch(() => ({ venv_python_exists: false, runner_script_exists: false }));
      if (dfHealth.venv_python_exists && dfHealth.runner_script_exists) {
        const df = await http<{
          results: { output_path: string; bytes: number; seconds: number }[];
          seconds: number;
        }>(PY, '/depthflow/batch', 'POST', {
          images: beats.map((b) => b.path),
          // 12-s clips loop at the renderer; matches Rust constant.
          duration_seconds: 12.0,
          fps: 24,
          width: 1920,
          height: 1088,
        }, 30 * 60_000);
        // Partial-results-tolerant attach (matches Rust v0.1.46).
        let attached = 0;
        layeredBeats = beats.map((b, i) => {
          const r = df.results[i];
          if (r && r.output_path && r.bytes > 1024) {
            attached += 1;
            return { ...b, clip_path: r.output_path } as typeof b & { clip_path: string };
          }
          return b;
        });
        if (attached === beats.length) {
          phase(project_id, 4, 'done', 1, `Parallax 2.5D listo (${beats.length} clips)`);
        } else if (attached > 0) {
          phase(project_id, 4, 'done', 1, `Parallax parcial: ${attached}/${beats.length} clips`);
        } else {
          phase(project_id, 4, 'done', 1, `Parallax sin clips — usando KenBurns`);
        }
      } else {
        phase(project_id, 4, 'done', 1, `${beats.length} imágenes (DepthFlow no instalado)`);
      }
    } catch {
      phase(project_id, 4, 'done', 1, `${beats.length} imágenes (DepthFlow inalcanzable)`);
    }

    // Phase 5: Music (skipped in shim mode unless musicgen is available)
    phase(project_id, 5, 'done', 1, 'Sin pista musical');

    if (beats.length === 0) throw new Error('No image beats produced — script lacks IMAGE markers');

    // Phase 6: Render. Strategy:
    //   - HyperFrames (Node sidecar) is the primary auto-edit engine. Composes
    //     HTML/CSS/GSAP with parallax 2.5D (when depth layers exist), atmospherics,
    //     transitions and post-pass FFmpeg grade. Used whenever the Node sidecar
    //     is reachable — for both horizontal AND vertical (template responds to
    //     width/height passed in the request).
    //   - FFmpeg-direct fallback only when Node sidecar is down. When vertical,
    //     it still renders horizontal first and then /reframe to 1080×1920 to
    //     preserve composition.
    void layeredBeats; // depth layers feed the template, no longer gate the path
    const nodeUp = await reachable(`${NODE}/health`);
    const useHyperFrames = nodeUp;
    // For the FFmpeg-fallback path: always render horizontal first when
    // vertical=true; then /reframe. HyperFrames takes vertical natively.
    const renderW = useHyperFrames ? W : (vertical ? 1920 : W);
    const renderH = useHyperFrames ? H : (vertical ? 1080 : H);

    phase(project_id, 6, 'running', 0.2,
      useHyperFrames
        ? 'Renderizando con HyperFrames (parallax 2.5D + atmospherics)…'
        : 'Renderizando con FFmpeg (zoompan + xfade + cinematic + NVENC)…');

    const renderOut = `${stripFile(beats[0]!.path)}/video-${project_id.slice(0, 8)}.mp4`;
    let videoPath = '';
    let renderMs = 0;
    const renderT0 = Date.now();

    if (useHyperFrames) {
      const r = await http<{ out_path: string; duration_seconds: number }>(
        NODE,
        '/render/narrative',
        'POST',
        {
          project_id,
          title: args.topic,
          images: layeredBeats,
          narration_path: tts.audio_path,
          out_path: renderOut,
          width: renderW,
          height: renderH,
          fps: 24,
          cinematic: 'full',
          music_ducking: false,
        },
        45 * 60_000,
      );
      videoPath = r.out_path;
    } else {
      // Pass through foreground_path so FFmpeg parallax 2.5D activates.
      const r = await http<{ video_path: string; render_seconds: number }>(PY, '/render', 'POST', {
        images: layeredBeats.map((b) => ({
          image_path: b.path,
          start_seconds: b.start,
          duration_seconds: b.duration,
          foreground_path: 'foreground_path' in b ? (b as { foreground_path?: string }).foreground_path : undefined,
          transition: b.transition,
        })),
        narration_path: tts.audio_path,
        width: renderW,
        height: renderH,
        fps: 24,
        crossfade_seconds: 0.9,
        cinematic: 'full',
        music_ducking: false,
        kenburns_start: 1.00,
        kenburns_end: 1.10,
      }, 15 * 60_000);
      videoPath = r.video_path;
      renderMs = r.render_seconds * 1000;
    }
    if (!renderMs) renderMs = Date.now() - renderT0;

    // Vertical reframe step (only when vertical=true). Uses /reframe with
    // MediaPipe subject tracking + blur-extend fallback. Preserves composition.
    if (vertical) {
      phase(project_id, 6, 'running', 0.85, 'Reframe vertical 1080×1920 (subject tracking + blur-extend)…');
      try {
        const rf = await http<{ out_path: string; method: string; seconds: number }>(
          PY, '/reframe', 'POST',
          {
            video_path: videoPath,
            out_path: videoPath.replace(/\.mp4$/i, '.vertical.mp4'),
            target_width: 1080,
            target_height: 1920,
            fallback: 'blur-extend',
            smoothing: 0.10,
          },
          10 * 60_000,
        );
        videoPath = rf.out_path;
      } catch {
        // Reframe failed — fall through with horizontal video; subs phase still runs.
      }
    }
    phase(project_id, 6, 'done', 1,
      `${useHyperFrames ? 'HyperFrames' : 'FFmpeg'}: ${baseName(videoPath)} (${(renderMs/1000).toFixed(1)}s)`);

    // Phase 7: Thumbnail (best effort)
    phase(project_id, 7, 'done', 1, 'Saltado en modo shim');

    // Phase 8: Subtitles (Whisper transcription on a 3-min audio: ~1-3 min)
    phase(project_id, 8, 'running', 0.2, 'Transcribiendo con faster-whisper…');
    const subs = await http<{ subtitles: { language: string; ass_path: string }[] }>(
      PY,
      '/subtitles',
      'POST',
      {
        audio_path: tts.audio_path,
        source_language: lang,
        target_languages: [lang],
        // v0.1.46: must match the Rust supervisor (pipeline/mod.rs).
        // The Node renderer prepends INTRO_SEC=6.0 of intro card +
        // silence before the narration, so SRT/ASS timestamps must
        // be shifted by 6 s to align with the spoken word. Without
        // this, captions appear over the intro card — exactly the
        // desync the user reported on every long-form video.
        intro_offset_seconds: 6.0,
      },
      15 * 60_000,
    );
    const ass = subs.subtitles.find((s) => s.language === lang)?.ass_path;
    let finalPath = videoPath;
    if (ass) {
      phase(project_id, 8, 'running', 0.6, 'Quemando subtítulos karaoke…');
      const burn = await http<{ out_path: string }>(PY, '/subtitles/burn-in', 'POST', {
        video_path: videoPath,
        ass_path: ass,
        out_path: videoPath.replace(/\.mp4$/i, '.subs.mp4'),
        cinematic: 'full',
      }, 15 * 60_000);
      finalPath = burn.out_path;
    }
    phase(project_id, 8, 'done', 1, `Final: ${baseName(finalPath)}`);

    // Final cleanup — release Whisper before next pipeline run on the same machine.
    await unloadModels(['whisper']);

    projectsStore.update(project_id, {
      status: 'done',
      duration_seconds: tts.duration_seconds,
    });
    phase(project_id, 10, 'done', 1, finalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    projectsStore.update(project_id, { status: 'failed', error_message: msg });
    emit('pipeline:error', { project_id, error: msg });
    throw err;
  }
}

function langToQwen(lang: string): string {
  const m: Record<string, string> = {
    en: 'English', es: 'Spanish', zh: 'Chinese', fr: 'French', de: 'German',
    it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
  };
  return m[lang] || 'English';
}

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;
const stripFile = (p: string) => {
  const norm = p.replace(/\\/g, '/');
  return norm.substring(0, norm.lastIndexOf('/')) || '.';
};

// ─── invoke() router ────────────────────────────────────────────────
type Cmd = string;
type Args = Record<string, unknown> | undefined;

async function invokeShim<T>(cmd: Cmd, args?: Args): Promise<T> {
  switch (cmd) {
    case 'greet':
      return `欢迎, ${(args?.name as string) || 'visitor'}! Welcome to Xianxia Studio (browser shim).` as unknown as T;
    case 'get_app_version':
      // v0.1.46: use the workspace package.json version injected at
      // build time by Vite (see vite.config.ts:define). Matches the
      // version Tauri webview returns in prod, eliminating the
      // "v0.1.0-shim vs vX.Y.Z" visual divergence in the sidebar.
      return {
        version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-shim',
        tauri: 'browser-mode',
      } as unknown as T;

    case 'detect_hardware':
      return await http(PY, '/install/hardware', 'GET').catch(() => ({
        os: 'browser', arch: 'wasm', cpu_brand: 'unknown',
        cpu_cores: 0, cpu_logical_cores: 0, total_ram_gb: 0,
        available_ram_gb: 0, free_disk_gb: 0, gpu: null,
        recommendation: {
          llm_hf_repo: 'mradermacher/supergemma4-e4b-abliterated-i1-GGUF',
          llm_gguf_file: 'supergemma4-e4b-abliterated.i1-Q4_K_M.gguf',
          llm_label: 'Gemma4 abliterated Q4_K_M',
          llm_abliterated: true, image: 'Z-Image-Turbo', tts: 'Qwen3-TTS',
          tier: 'high', estimated_download_gb: 17,
        },
      })) as T;

    case 'safe_llm_alternative':
      return await http(PY, '/install/safe-llm', 'POST', args).catch(() => ({})) as T;

    case 'verify_stack': {
      const checks: { id: string; label: string; ok: boolean; detail: string; group: string }[] = [];
      const py = await reachable(`${PY}/health`);
      const nd = await reachable(`${NODE}/health`);
      const ol = await reachable(`${OLLAMA}/api/tags`);
      const cf = await reachable(`http://127.0.0.1:8188/system_stats`);
      checks.push(
        { id: 'sidecar-py', label: 'Sidecar Python', ok: py, detail: py ? 'http://127.0.0.1:8731' : 'no responde', group: 'Servicios' },
        { id: 'sidecar-node', label: 'Sidecar Node', ok: nd, detail: nd ? 'http://127.0.0.1:8732' : 'no responde', group: 'Servicios' },
        { id: 'ollama', label: 'Ollama', ok: ol, detail: ol ? 'http://127.0.0.1:11434' : 'no responde', group: 'Servicios' },
        { id: 'comfyui', label: 'ComfyUI', ok: cf, detail: cf ? 'http://127.0.0.1:8188' : 'no responde', group: 'Servicios' },
      );
      let xianxiaLlm = false;
      if (ol) {
        try {
          const tags = await http<{ models: { name: string }[] }>(OLLAMA, '/api/tags');
          xianxiaLlm = tags.models.some((m) => m.name.startsWith('xianxia-llm'));
        } catch { /* */ }
      }
      checks.push({
        id: 'xianxia-llm', label: 'xianxia-llm registrado', ok: xianxiaLlm,
        detail: xianxiaLlm ? 'Gemma 4 abliterated' : 'no registrado en Ollama',
        group: 'Modelos',
      });
      // Herramientas group — best-guess flags since the browser shim can't
      // probe the local FS. Tauri returns concrete results via verify_stack.
      checks.push(
        { id: 'hyperframes', label: 'HyperFrames CLI (render HTML/CSS)', ok: nd,
          detail: nd ? '(asumido OK porque sidecar Node responde)' : 'no detectable desde browser',
          group: 'Herramientas' },
        { id: 'rembg', label: 'rembg + onnxruntime-gpu (parallax 2.5D)', ok: py,
          detail: py ? '(asumido OK porque sidecar Python responde)' : 'no detectable desde browser',
          group: 'Herramientas' },
        { id: 'mediapipe', label: 'MediaPipe (subject tracking)', ok: py,
          detail: py ? '(asumido OK porque sidecar Python responde)' : 'no detectable desde browser',
          group: 'Herramientas' },
        { id: 'ultralytics', label: 'ultralytics YOLO11 (Shorts subject tracking)', ok: py,
          detail: py ? '(asumido OK porque sidecar Python responde)' : 'no detectable desde browser',
          group: 'Herramientas' },
      );
      // Música backends — v0.2.6: MusicGen-only (ACE-Step removed).
      let musicgenOk = false;
      if (py) {
        try {
          const m = await http<{ musicgen_available: boolean }>(
            PY, '/music/backends', 'GET', undefined, 3000,
          );
          musicgenOk = !!m.musicgen_available;
        } catch { /* sidecar may not be ready yet */ }
      }
      checks.push(
        { id: 'musicgen', label: 'MusicGen-medium (audiocraft · GPU-only)', ok: musicgenOk,
          detail: musicgenOk ? '✓ instalado' : 'no instalado — opcional. Sin él, /music usa la biblioteca local',
          group: 'Música' },
      );
      const summary = {
        gpu_available: py, video_hw_accelerated: py,
        ollama_running: ol, xianxia_llm_registered: xianxiaLlm,
        sidecar_python_running: py, sidecar_node_running: nd, comfyui_running: cf,
        hyperframes_installed: nd,
        rembg_installed: py,
        mediapipe_installed: py,
        ultralytics_installed: py,
        acestep_installed: false,
        musicgen_installed: musicgenOk,
        models_ready_count: checks.filter((c) => c.group === 'Modelos' && c.ok).length,
        models_total: checks.filter((c) => c.group === 'Modelos').length,
      };
      return { all_ok: checks.every((c) => c.ok), checks, summary } as unknown as T;
    }

    case 'detect_installed_tools':
      return {
        python: { id: 'python', label: 'Python 3.11', installed: true, version: '3.11.15', path: 'embedded', compatible: true, min_version: '3.11', note: null },
        node: { id: 'node', label: 'Node 22', installed: true, version: '22.x', path: 'embedded', compatible: true, min_version: '22', note: null },
        ffmpeg: { id: 'ffmpeg', label: 'FFmpeg', installed: true, version: 'system', path: 'system', compatible: true, min_version: '6.0', note: 'NVENC OK' },
        ollama: { id: 'ollama', label: 'Ollama', installed: true, version: 'system', path: 'system', compatible: true, min_version: '0.4', note: null },
        git: { id: 'git', label: 'Git', installed: true, version: 'system', path: 'system', compatible: true, min_version: '2.40', note: null },
      } as unknown as T;

    case 'get_sidecar_state': {
      const [p, n, o, c, ll] = await Promise.all([
        reachable(`${PY}/health`), reachable(`${NODE}/health`), reachable(`${OLLAMA}/api/tags`),
        reachable('http://127.0.0.1:8188/system_stats'),
        reachable('http://127.0.0.1:8733/health'),
      ]);
      return {
        python: p ? 'running' : 'stopped',
        node: n ? 'running' : 'stopped',
        ollama: o ? 'running' : 'stopped',
        comfyui: c ? 'running' : 'stopped',
        // v0.2.0 — show llama.cpp dot in dev/browser mode too so the
        // model browser UI reflects reality without needing Tauri APIs.
        llamacpp: ll ? 'running' : 'stopped',
      } as unknown as T;
    }

    // v0.2.0 — llama.cpp installer/status. In browser mode we can't
    // invoke the Rust installer (it writes files inside the data_dir
    // and bundles cudart DLLs); return a Tauri-only sentinel so the UI
    // shows a "abre la app de escritorio para instalar" affordance.
    case 'llamacpp_status': {
      const alive = await reachable('http://127.0.0.1:8733/health');
      return {
        installed: alive,
        flavor: 'windows_cuda12',
        flavor_label: 'browser-mode (status unknown)',
        recommended_tag: 'b9114',
        current: alive
          ? {
              flavor: 'windows_cuda12',
              tag: 'b9114',
              install_dir: '<browser-shim>',
              server_binary: '<browser-shim>',
              version: null,
            }
          : null,
      } as unknown as T;
    }
    case 'llamacpp_install':
      throw new Error('llamacpp_install requires the desktop Tauri app');

    case 'get_sidecar_logs':
      return { python: '(logs no disponibles en modo navegador)', node: '(idem)' } as unknown as T;

    case 'list_voice_clones': {
      try {
        return (await http<unknown>(PY, '/tts/clones', 'GET', undefined, 5000)) as T;
      } catch {
        return [] as unknown as T;
      }
    }

    case 'library_list_videos': {
      // v0.1.46 parity: Rust supervisor scans <data_dir>/projects/. In
      // browser mode we ask the Python sidecar to do the same via
      // /diag/library — same data shape (LibraryVideo[]).
      try {
        const resp = await http<{ videos: unknown[] }>(PY, '/diag/library', 'GET');
        return (resp.videos || []) as unknown as T;
      } catch {
        return [] as unknown as T;
      }
    }

    case 'library_delete_video':
      return undefined as unknown as T;

    case 'library_open_video_folder':
      return '' as unknown as T;

    case 'install_optional_component':
      // Browser shim: real install requires Tauri filesystem + supervisor.
      throw new Error('Component install requires the Tauri webview (no browser-mode equivalent).');

    case 'register_voice_clone':
      // Browser shim can't open OS file pickers; surface a clear error.
      throw new Error('Voice clone registration requires the Tauri webview (file picker not available in browser mode).');

    case 'delete_voice_clone': {
      const a = (args ?? {}) as { id?: string };
      if (!a.id) throw new Error('id required');
      await http<unknown>(PY, `/tts/clones/${encodeURIComponent(a.id)}`, 'POST', undefined, 5000)
        .catch(() => fetch(`${PY}/tts/clones/${encodeURIComponent(a.id!)}`, { method: 'DELETE' }));
      return undefined as unknown as T;
    }

    case 'get_workspace_root':
      return null as unknown as T;

    case 'list_projects':
      return projectsStore.list() as unknown as T;

    case 'create_project':
      return projectsStore.create(args!.args as { title: string; topic: string; languages: string[] }) as unknown as T;

    case 'start_generation': {
      const a = args!.args as GenerateArgs;
      const proj = projectsStore.create({ title: a.topic, topic: a.topic, languages: a.languages });
      // Run in background so the call returns immediately (matching Tauri behaviour)
      runPipeline(proj.id, a).catch((e) => console.error('pipeline failed', e));
      return proj.id as unknown as T;
    }

    case 'abort_generation': {
      // Browser-mode shim: pipelines aren't actually cancellable here, but
      // we return false so the UI can render the button without crashing.
      return false as unknown as T;
    }

    case 'list_voices':
      return [
        { id: 'preset-vivian-en', name: 'Vivian', language: 'en', kind: 'preset', description: 'Female narrator', is_default: 1 },
        { id: 'preset-aiden-en', name: 'Aiden', language: 'en', kind: 'preset', description: 'Male narrator', is_default: 0 },
        { id: 'preset-vivian-es', name: 'Vivian', language: 'es', kind: 'preset', description: 'Female narrator', is_default: 1 },
      ] as unknown as T;

    // YouTube — disabled in shim mode (no OAuth state)
    case 'youtube_status':
      return { connected: false, expires_at: null } as unknown as T;
    case 'youtube_app_status':
      return { configured: false, client_id_preview: null } as unknown as T;

    case 'music_list_tracks':
      return { dir: '(browser shim)', tracks: [], total_bytes: 0 } as unknown as T;
    case 'music_add_tracks':
    case 'music_remove_track':
    case 'music_open_folder':
    case 'music_get_dir':
      throw new Error(`'${cmd}' solo disponible en la app Tauri (acceso a filesystem).`);

    case 'get_install_manifest':
    case 'run_install':
    case 'install_llm':
      throw new Error(`'${cmd}' no disponible en modo navegador (usa la app Tauri para instalar).`);

    default:
      throw new Error(`invoke shim: comando no implementado '${cmd}'`);
  }
}

async function listenShim(event: string, cb: (e: { event: string; payload: unknown }) => void): Promise<UnlistenFn> {
  if (!emitter.has(event)) emitter.set(event, new Set());
  const wrapped: EventCb = (payload) => cb({ event, payload });
  emitter.get(event)!.add(wrapped);
  return () => emitter.get(event)?.delete(wrapped);
}

// ─── Public API ─────────────────────────────────────────────────────
export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  if (TAURI) {
    const real = await import('@tauri-apps/api/core');
    return real.invoke<T>(cmd, args);
  }
  return invokeShim<T>(cmd, args);
}

export async function listen<T>(
  event: string,
  cb: (e: { event: string; payload: T }) => void,
): Promise<UnlistenFn> {
  if (TAURI) {
    const real = await import('@tauri-apps/api/event');
    return real.listen<T>(event, cb);
  }
  return listenShim(event, cb as (e: { event: string; payload: unknown }) => void);
}

// Expose for Playwright debugging in browser mode
if (!TAURI && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__XIANXIA_SHIM__ = {
    invoke: invokeShim,
    emit,
    listenerCount: () => Array.from(emitter.entries()).map(([k, v]) => [k, v.size]),
  };
}
