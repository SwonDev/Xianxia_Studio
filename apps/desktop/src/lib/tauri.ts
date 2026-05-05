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
  voice?: string;
}

export interface PhaseUpdate {
  project_id: string;
  phase: number;
  status: string;
  progress: number;
  message: string;
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
};

export const events = {
  onInstallProgress: (cb: (p: InstallProgress) => void): Promise<UnlistenFn> =>
    listen<InstallProgress>('install:progress', (e) => cb(e.payload)),
  onInstallDone: (cb: (r: InstallReport) => void): Promise<UnlistenFn> =>
    listen<InstallReport>('install:done', (e) => cb(e.payload)),
  onPipelineProgress: (cb: (p: PhaseUpdate) => void): Promise<UnlistenFn> =>
    listen<PhaseUpdate>('pipeline:progress', (e) => cb(e.payload)),
  onPipelineError: (cb: (p: { project_id: string; error: string }) => void): Promise<UnlistenFn> =>
    listen<{ project_id: string; error: string }>('pipeline:error', (e) => cb(e.payload)),
  onYoutubeConnected: (cb: () => void): Promise<UnlistenFn> =>
    listen<unknown>('youtube:connected', () => cb()),
  onYoutubeError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
    listen<string>('youtube:error', (e) => cb(e.payload)),
};
