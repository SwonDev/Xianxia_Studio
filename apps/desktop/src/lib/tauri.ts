// Routed through ./tauri-shim so the same UI works in both the Tauri webview
// (real invoke/listen) and a regular browser (HTTP-mapped sidecar calls). See
// tauri-shim.ts for the runtime detection and command-by-command mapping.
import { invoke, listen, type UnlistenFn } from './tauri-shim';

export interface AppVersion {
  version: string;
  tauri: string;
}

export interface GpuInfo {
  vendor: string;
  name: string;
  vram_gb: number | null;
  driver: string | null;
}

export interface ModelRecommendation {
  llm_hf_repo: string;
  llm_gguf_file: string;
  llm_label: string;
  llm_abliterated: boolean;
  image: string;
  tts: string;
  tier: 'ultra' | 'high' | 'medium' | 'low' | 'cpu-only';
  estimated_download_gb: number;
}

export interface LlmInstallRequest {
  hf_repo: string;
  gguf_file: string;
  model_name: string;
  abliterated: boolean;
}

export interface LlmInstallResult {
  model_name: string;
  gguf_path: string;
  bytes: number;
}

export interface YouTubeStatus {
  connected: boolean;
  expires_at: number | null;
}

export interface HardwareInfo {
  os: string;
  arch: string;
  cpu_brand: string;
  cpu_cores: number;
  cpu_logical_cores: number;
  total_ram_gb: number;
  available_ram_gb: number;
  free_disk_gb: number;
  gpu: GpuInfo | null;
  recommendation: ModelRecommendation;
}

export interface InstallComponent {
  id: string;
  label: string;
  category: 'runtime' | 'model' | 'tool' | 'sidecar' | 'postinstall';
  size_bytes: number;
  url: string;
  kind: unknown;
  required: boolean;
  depends_on: string[];
}

export interface InstallOptions {
  llm_hf_repo: string;
  llm_gguf_file: string;
  llm_label: string;
  llm_abliterated: boolean;
  llm_size_bytes: number;
  workspace_root?: string | null;
}

export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  group: string;
}

export interface StackSummary {
  gpu_available: boolean;
  video_hw_accelerated: boolean;
  ollama_running: boolean;
  xianxia_llm_registered: boolean;
  sidecar_python_running: boolean;
  sidecar_node_running: boolean;
  comfyui_running: boolean;
  hyperframes_installed: boolean;
  rembg_installed: boolean;
  mediapipe_installed: boolean;
  models_ready_count: number;
  models_total: number;
}

export interface StackReport {
  all_ok: boolean;
  checks: CheckItem[];
  summary: StackSummary;
}

export interface AppCredentialsStatus {
  configured: boolean;
  client_id_preview: string | null;
}

export interface DetectedTool {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  compatible: boolean;
  min_version: string;
  note: string | null;
}

export interface DetectionReport {
  python: DetectedTool;
  node: DetectedTool;
  ffmpeg: DetectedTool;
  ollama: DetectedTool;
  git: DetectedTool;
}

export interface SidecarLogs {
  python: string;
  node: string;
}

export type ProgressStatus =
  | 'pending'
  | 'downloading'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'failed';

export interface InstallProgress {
  component: string;
  status: ProgressStatus;
  bytes_done: number;
  bytes_total: number;
  percent: number;
  message: string;
}

export interface InstallReport {
  completed: string[];
  failed: string[];
}

export interface SidecarState {
  python: 'stopped' | 'starting' | 'running' | 'failed';
  node: 'stopped' | 'starting' | 'running' | 'failed';
  ollama: 'stopped' | 'starting' | 'running' | 'failed';
  comfyui: 'stopped' | 'starting' | 'running' | 'failed';
  /** v0.2.0 — llama.cpp llama-server on :8733. Optional during migration. */
  llamacpp?: 'stopped' | 'starting' | 'running' | 'failed';
}

/** v0.6.0 — LTX-2.3 video hardware capability gate. */
export type LtxCapability = 'none' | 'gguf' | 'full';

/** v0.2.2 — User preferences persisted in `<data_dir>/app-settings.json`. */
export interface AppSettings {
  /** When false (default) the supervisor never touches Ollama. Toggle from Settings. */
  ollama_enabled: boolean;
}

// ── v0.2.0 — llama.cpp installer + model browser ───────────────────

export type LlamaCppFlavor =
  | 'windows_cuda12'
  | 'windows_vulkan'
  | 'windows_cpu'
  | 'macos_arm64'
  | 'linux_vulkan'
  | 'linux_cpu';

export interface LlamaCppInstall {
  flavor: LlamaCppFlavor;
  tag: string;
  install_dir: string;
  server_binary: string;
  version: string | null;
}

export interface LlamaCppStatus {
  installed: boolean;
  flavor: LlamaCppFlavor;
  flavor_label: string;
  recommended_tag: string;
  current: LlamaCppInstall | null;
}

export interface LocalLlmModel {
  path: string;
  filename: string;
  size_bytes: number;
  repo_id: string | null;
  architecture: string | null;
  quantization: string | null;
  context_length: number | null;
}

export interface HfSearchResult {
  repo_id: string;
  downloads: number;
  likes: number;
  tags: string[];
  library_name: string | null;
  pipeline_tag: string | null;
  last_modified: string | null;
}

export interface HfRepoFile {
  filename: string;
  size_bytes: number | null;
  quantization: string | null;
}

export interface LlmModelConfig {
  gguf_path: string;
  context_size: number;
  gpu_layers: number;
  flash_attention: boolean;
  chat_template: string | null;
  threads: number | null;
  batch_size: number | null;
  ubatch_size: number | null;
  parallel: number | null;
  extra_args: string[];
  model_id: string;
  architecture: string | null;
  quantization: string | null;
}

export interface LlmRecommendation {
  gpu_layers: number;
  context_size: number;
  flash_attention: boolean;
  chat_template: string | null;
  threads: number | null;
  batch_size: number | null;
  ubatch_size: number | null;
  parallel: number;
  sampling: Record<string, number>;
  rationale: string[];
  hardware: {
    vram_gb: number;
    ram_gb: number;
    cpu_cores: number;
    gpu_vendor: string;
  };
  metadata: {
    architecture: string | null;
    context_length: number | null;
    block_count: number | null;
    embedded_chat_template: boolean;
  };
}

export interface VoiceClone {
  id: string;
  label: string;
  gender: string;
  primary: string;
  description: string;
  duration_seconds: number | null;
  has_ref_text: boolean;
}

export interface VoiceAcquisitionResponse {
  clone_id: string;
  clone_path: string;
  duration_seconds: number;
  pipeline_steps: { stage: string; method: string; out: string }[];
  quality: {
    duration_seconds: number;
    sample_rate: number;
    channels: number;
    ok_for_clone: boolean;
    warning: string | null;
  };
}

export interface TtsCloningInstallState {
  running: boolean;
  phase: string;
  downloaded_bytes: number;
  total_bytes: number;
  error: string | null;
  completed: boolean;
  pct?: number;
}

export interface LibraryVideo {
  project_id: string;
  title: string;
  video_path: string;
  poster_path: string | null;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  modified_at: number;
}

export interface Project {
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

export interface ScheduledUpload {
  id: string;
  project_id: string;
  title: string;
  youtube_video_id: string | null;
  scheduled_at: number;
  privacy_status: string;
  publish_at: number | null;
  is_short: number;
  status: string;
  last_attempt_at: number | null;
  error_message: string | null;
}

export interface GenerateRequest {
  topic: string;
  /**
   * Legacy combined languages array (audio in [0], subs in all). The
   * Rust pipeline still reads this when audio_language /
   * subtitle_languages are absent so older clients keep working.
   */
  languages: string[];
  /** Single IETF tag for the TTS narration (en, es, zh, ja…). */
  audio_language?: string;
  /** Multi IETF tags — every entry generates its own SRT + ASS. The
   *  audio_language entry is the one burned into the rendered MP4. */
  subtitle_languages?: string[];
  target_minutes: number;
  experimental_llm: boolean;
  /** When true, render at 1080x1920 (vertical/Shorts aspect). Defaults to false. */
  vertical?: boolean;
  /** Voice preset name for Qwen3-TTS. Defaults to 'Vivian'. */
  voice_speaker?: string;
  /** Use MusicGen-medium GPU for soundtrack generation instead of library tracks. */
  use_musicgen?: boolean;
  /** Optional override for the LLM model used in script phase. */
  llm_model?: string;
  /** Phase 10: extract N viral Shorts from the long-form output. */
  auto_shorts?: boolean;
  /** Number of shorts to extract (default 3). */
  shorts_count?: number;
  /** When true and YouTube connected, Phase 9 uploads automatically. */
  auto_upload?: boolean;
  /** YouTube privacy: "private" | "unlisted" | "public". */
  publish_privacy?: string;
  /** Unix timestamp for scheduled publish. */
  publish_at?: number;
  /** When false, skip the karaoke ASS burn-in pass (SRT files still generated). */
  burn_subtitles?: boolean;
  /** Animation preset: cinematic | dynamic | minimal | dramatic. */
  animation_preset?: string;
  /** Caption style preset: xianxia | hormozi | mrbeast | minimal | neon. */
  caption_style?: string;
  /** Phase 11: TRIBE v2 in-silico neuroscience engagement analysis. Default true. */
  analyze_engagement?: boolean;
  /** When true, auto-applies cuts + audio swells to fix detected boring spots. */
  auto_optimize_engagement?: boolean;
  /** v0.6.0 — Opt-in LTX-2.3 real-video engine. When true, the Rust pipeline
   *  uses LTX-2.3 instead of HyperFrames for the video phase. Requires
   *  hardware capability !== 'none' AND models installed; otherwise the
   *  pipeline falls back to HyperFrames silently. Default false (absent). */
  use_ltx_video?: boolean;
}

export interface PhaseUpdate {
  project_id: string;
  phase: number;
  status: string;
  progress: number;
  message: string;
}

/** Emitted by the long-form chapter loop for each chapter written or resumed. */
export interface ChapterUpdate {
  project_id: string;
  index: number;
  total: number;
  title: string;
  status: string;
  words: number;
  /** Wall-clock ETA in seconds for remaining chapters. Present only after
   *  ≥1 fresh chapter completes; undefined/null when writing pre-emit or
   *  resumed chapters. */
  eta_seconds?: number | null;
}

export interface ImageReadyEvent {
  project_id: string;
  index: number;
  total: number;
  image_path: string;
  prompt: string;
}

export const tauri = {
  greet: (name: string) => invoke<string>('greet', { name }),
  getAppVersion: () => invoke<AppVersion>('get_app_version'),
  detectHardware: () => invoke<HardwareInfo>('detect_hardware'),
  safeLlmAlternative: (tier: string) =>
    invoke<ModelRecommendation>('safe_llm_alternative', { tier }),
  ltxCapability: () => invoke<LtxCapability>('ltx_capability'),
  ltxModelsInstalled: () => invoke<boolean>('ltx_models_installed'),
  getInstallManifest: (options: InstallOptions) =>
    invoke<InstallComponent[]>('get_install_manifest', { options }),
  runInstall: (options: InstallOptions) =>
    invoke<InstallReport>('run_install', { options }),
  installLlm: (req: LlmInstallRequest) => invoke<LlmInstallResult>('install_llm', { req }),
  verifyStack: () => invoke<StackReport>('verify_stack'),
  detectInstalledTools: () => invoke<DetectionReport>('detect_installed_tools'),

  // ── v0.2.0 — llama.cpp runtime + LLM model browser ───────────────
  llamacppStatus: () => invoke<LlamaCppStatus>('llamacpp_status'),
  llamacppInstall: () => invoke<LlamaCppInstall>('llamacpp_install'),

  // ── v0.2.2 — App settings (Ollama opt-in lives here) ─────────────
  appSettingsGet: () => invoke<AppSettings>('app_settings_get'),
  appSettingsSetOllamaEnabled: (enabled: boolean) =>
    invoke<AppSettings>('app_settings_set_ollama_enabled', { enabled }),
  llmListLocal: async (): Promise<LocalLlmModel[]> => {
    const r = await fetch('http://127.0.0.1:8731/models/local');
    if (!r.ok) throw new Error(`models/local: ${r.status}`);
    const data = (await r.json()) as { models: LocalLlmModel[] };
    return data.models;
  },
  llmSearchHf: async (query: string, limit = 30): Promise<HfSearchResult[]> => {
    const url = new URL('http://127.0.0.1:8731/models/search');
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`models/search: ${r.status}`);
    return ((await r.json()) as { results: HfSearchResult[] }).results;
  },
  llmListRepoFiles: async (repoId: string): Promise<HfRepoFile[]> => {
    const url = new URL('http://127.0.0.1:8731/models/files');
    url.searchParams.set('repo_id', repoId);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`models/files: ${r.status}`);
    return ((await r.json()) as { files: HfRepoFile[] }).files;
  },
  llmDownload: async (repoId: string, filename: string) => {
    const r = await fetch('http://127.0.0.1:8731/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_id: repoId, filename }),
    });
    if (!r.ok) throw new Error(`models/download: ${r.status} ${await r.text()}`);
    return (await r.json()) as { ok: boolean; path: string; size_bytes: number };
  },
  llmRecommend: async (path: string): Promise<LlmRecommendation> => {
    const r = await fetch('http://127.0.0.1:8731/models/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(`models/recommend: ${r.status}`);
    return (await r.json()) as LlmRecommendation;
  },
  llmActivate: async (path: string, overrides: Partial<LlmModelConfig> = {}) => {
    const r = await fetch('http://127.0.0.1:8731/models/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...overrides }),
    });
    if (!r.ok) throw new Error(`models/activate: ${r.status} ${await r.text()}`);
    return (await r.json()) as { ok: boolean; config: LlmModelConfig };
  },
  llmGetActive: async (): Promise<LlmModelConfig | null> => {
    const r = await fetch('http://127.0.0.1:8731/models/active');
    if (!r.ok) return null;
    const data = (await r.json()) as { active: LlmModelConfig | null };
    return data.active;
  },
  llmDelete: async (path: string) => {
    const r = await fetch('http://127.0.0.1:8731/models/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(`models/delete: ${r.status} ${await r.text()}`);
    return (await r.json()) as { ok: boolean };
  },

  getSidecarState: () => invoke<SidecarState>('get_sidecar_state'),
  getSidecarLogs: () => invoke<SidecarLogs>('get_sidecar_logs'),
  getWorkspaceRoot: () => invoke<string | null>('get_workspace_root'),
  listProjects: () => invoke<Project[]>('list_projects'),
  listScheduled: () => invoke<ScheduledUpload[]>('list_scheduled'),
  cancelScheduled: (id: string) => invoke<void>('cancel_scheduled', { id }),
  resetProjectProgress: (projectId: string) =>
    invoke<void>('reset_project_progress', { projectId }),
  createProject: (args: { title: string; topic: string; languages: string[] }) =>
    invoke<Project>('create_project', { args }),
  startGeneration: (args: GenerateRequest) =>
    invoke<string>('start_generation', { args }),
  abortGeneration: (projectId: string) =>
    invoke<boolean>('abort_generation', { projectId }),
  // Voice clones
  listVoiceClones: () => invoke<VoiceClone[]>('list_voice_clones'),
  registerVoiceClone: (args: {
    audioPath: string;
    label: string;
    gender?: string;
    primary?: string;
    description?: string;
    refText?: string;
  }) =>
    invoke<VoiceClone>('register_voice_clone', {
      audioPath: args.audioPath,
      label: args.label,
      gender: args.gender,
      primary: args.primary,
      description: args.description,
      refText: args.refText,
    }),
  deleteVoiceClone: (id: string) => invoke<void>('delete_voice_clone', { id }),

  // Voice acquisition pipeline (v0.1.24) — extract a clean voice clip
  // from a URL/file/microphone and auto-register it as a clone in one
  // shot (yt-dlp → audio-separator → deepfilternet → silero-vad →
  // pyloudnorm → 16 kHz mono → /tts/clones manifest).
  voiceAcquireFromUrl: async (args: {
    url: string;
    label: string;
    primary?: string;
    description?: string;
    refText?: string;
    startSeconds?: number;
    durationSeconds?: number;
  }): Promise<VoiceAcquisitionResponse> => {
    const r = await fetch('http://127.0.0.1:8731/voices/from_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: args.url,
        label: args.label,
        primary: args.primary ?? 'es',
        description: args.description ?? '',
        ref_text: args.refText ?? '',
        start_seconds: args.startSeconds,
        duration_seconds: args.durationSeconds,
      }),
    });
    if (!r.ok) throw new Error(`voiceAcquireFromUrl: ${r.status} ${await r.text()}`);
    return r.json();
  },
  voiceAcquireFromFile: async (args: {
    file: Blob;
    fileName: string;
    label: string;
    primary?: string;
    description?: string;
    refText?: string;
    startSeconds?: number;
    durationSeconds?: number;
  }): Promise<VoiceAcquisitionResponse> => {
    const fd = new FormData();
    fd.append('audio', args.file, args.fileName);
    fd.append('label', args.label);
    fd.append('primary', args.primary ?? 'es');
    fd.append('description', args.description ?? '');
    fd.append('ref_text', args.refText ?? '');
    if (args.startSeconds !== undefined) fd.append('start_seconds', String(args.startSeconds));
    if (args.durationSeconds !== undefined) fd.append('duration_seconds', String(args.durationSeconds));
    const r = await fetch('http://127.0.0.1:8731/voices/from_file', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`voiceAcquireFromFile: ${r.status} ${await r.text()}`);
    return r.json();
  },
  ttsCloningInstall: async (): Promise<{ status: string; state: TtsCloningInstallState }> => {
    const r = await fetch('http://127.0.0.1:8731/tts/cloning/install', { method: 'POST' });
    if (!r.ok) throw new Error(`ttsCloningInstall: ${r.status}`);
    return r.json();
  },
  ttsCloningInstallProgress: async (): Promise<TtsCloningInstallState & { pct: number }> => {
    const r = await fetch('http://127.0.0.1:8731/tts/cloning/install/progress');
    if (!r.ok) throw new Error(`ttsCloningInstallProgress: ${r.status}`);
    return r.json();
  },
  // Library
  libraryListVideos: () => invoke<LibraryVideo[]>('library_list_videos'),
  libraryDeleteVideo: (videoPath: string) =>
    invoke<void>('library_delete_video', { videoPath }),
  libraryOpenFolder: () => invoke<string>('library_open_video_folder'),
  libraryRevealVideo: (videoPath: string) =>
    invoke<void>('library_reveal_video', { videoPath }),
  // Optional components — install ONE component by id (auto-restarts python sidecar)
  installOptionalComponent: (componentId: string) =>
    invoke<boolean>('install_optional_component', { componentId }),
  // YouTube
  youtubeStatus: () => invoke<YouTubeStatus>('youtube_status'),
  youtubeDisconnect: () => invoke<void>('youtube_disconnect'),
  youtubeOAuthStart: () => invoke<{ url: string }>('youtube_oauth_start'),
  youtubePublishNow: (videoId: string) =>
    invoke<void>('youtube_publish_now', { videoId }),
  youtubeAppStatus: () => invoke<AppCredentialsStatus>('youtube_app_status'),
  youtubeSetAppCredentials: (clientId: string, clientSecret: string) =>
    invoke<void>('youtube_set_app_credentials', { clientId, clientSecret }),
  youtubeClearAppCredentials: () => invoke<void>('youtube_clear_app_credentials'),
  // TikTok assisted-publish (sessionid stored in OS keyring)
  tiktokStatus: () => invoke<{ configured: boolean }>('tiktok_status'),
  tiktokSetSession: (sessionId: string) =>
    invoke<void>('tiktok_set_session', { sessionId }),
  tiktokClearSession: () => invoke<void>('tiktok_clear_session'),
  // Music library
  musicListTracks: () => invoke<MusicLibrary>('music_list_tracks'),
  musicAddTracks: (paths: string[]) => invoke<number>('music_add_tracks', { paths }),
  musicRemoveTrack: (name: string) => invoke<void>('music_remove_track', { name }),
  musicOpenFolder: () => invoke<void>('music_open_folder'),
  musicGetDir: () => invoke<string>('music_get_dir'),
};

export interface MusicTrack {
  name: string;
  path: string;
  size_bytes: number;
  duration_seconds: number | null;
}

export interface MusicLibrary {
  dir: string;
  tracks: MusicTrack[];
  total_bytes: number;
}

export const events = {
  onInstallProgress: (cb: (p: InstallProgress) => void): Promise<UnlistenFn> =>
    listen<InstallProgress>('install:progress', (e) => cb(e.payload)),
  onInstallDone: (cb: (r: InstallReport) => void): Promise<UnlistenFn> =>
    listen<InstallReport>('install:done', (e) => cb(e.payload)),
  onPipelineProgress: (cb: (p: PhaseUpdate) => void): Promise<UnlistenFn> =>
    listen<PhaseUpdate>('pipeline:progress', (e) => cb(e.payload)),
  onPipelineError: (cb: (p: { project_id: string; error: string }) => void): Promise<UnlistenFn> =>
    listen<{ project_id: string; error: string }>('pipeline:error', (e) => cb(e.payload)),
  onImageReady: (cb: (p: ImageReadyEvent) => void): Promise<UnlistenFn> =>
    listen<ImageReadyEvent>('pipeline:image_ready', (e) => cb(e.payload)),
  onChapterProgress: (cb: (p: ChapterUpdate) => void): Promise<UnlistenFn> =>
    listen<ChapterUpdate>('pipeline:chapter', (e) => cb(e.payload)),
  onYoutubeConnected: (cb: () => void): Promise<UnlistenFn> =>
    listen<unknown>('youtube:connected', () => cb()),
  onYoutubeError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
    listen<string>('youtube:error', (e) => cb(e.payload)),
};
