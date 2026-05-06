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

export interface GenerateRequest {
  topic: string;
  languages: string[];
  target_minutes: number;
  experimental_llm: boolean;
  /** When true, render at 1080x1920 (vertical/Shorts aspect). Defaults to false. */
  vertical?: boolean;
  /** Voice preset name for Qwen3-TTS. Defaults to 'Vivian'. */
  voice_speaker?: string;
  /** Use MusicGen / ACE-Step for soundtrack generation instead of library tracks. */
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
}

export interface PhaseUpdate {
  project_id: string;
  phase: number;
  status: string;
  progress: number;
  message: string;
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
  getInstallManifest: (options: InstallOptions) =>
    invoke<InstallComponent[]>('get_install_manifest', { options }),
  runInstall: (options: InstallOptions) =>
    invoke<InstallReport>('run_install', { options }),
  installLlm: (req: LlmInstallRequest) => invoke<LlmInstallResult>('install_llm', { req }),
  verifyStack: () => invoke<StackReport>('verify_stack'),
  detectInstalledTools: () => invoke<DetectionReport>('detect_installed_tools'),
  getSidecarState: () => invoke<SidecarState>('get_sidecar_state'),
  getSidecarLogs: () => invoke<SidecarLogs>('get_sidecar_logs'),
  getWorkspaceRoot: () => invoke<string | null>('get_workspace_root'),
  listProjects: () => invoke<Project[]>('list_projects'),
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
  // Library
  libraryListVideos: () => invoke<LibraryVideo[]>('library_list_videos'),
  libraryDeleteVideo: (videoPath: string) =>
    invoke<void>('library_delete_video', { videoPath }),
  libraryOpenFolder: () => invoke<string>('library_open_video_folder'),
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
  onYoutubeConnected: (cb: () => void): Promise<UnlistenFn> =>
    listen<unknown>('youtube:connected', () => cb()),
  onYoutubeError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
    listen<string>('youtube:error', (e) => cb(e.payload)),
};
