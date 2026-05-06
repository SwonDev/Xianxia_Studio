/**
 * Mocks for the @tauri-apps/api invoke() and event channels so the React app
 * can render in a plain browser (Playwright Chromium). Injected via
 * page.addInitScript before the app boots.
 */
export const tauriMockScript = `
(() => {
  const handlers = new Map();

  // Mock data — sensible defaults that exercise every UI branch
  const mocks = {
    greet: ({name}) => \`欢迎, \${name}! Welcome to Xianxia Studio.\`,
    get_app_version: () => ({ version: '0.1.0', tauri: '2.0.0-mock' }),
    detect_hardware: () => ({
      os: 'windows',
      arch: 'x86_64',
      cpu_brand: 'AMD Ryzen 9 7950X (mocked)',
      cpu_cores: 16,
      cpu_logical_cores: 32,
      total_ram_gb: 64,
      available_ram_gb: 41.2,
      free_disk_gb: 1200,
      gpu: { vendor: 'NVIDIA', name: 'GeForce RTX 4090', vram_gb: 24, driver: '566.36' },
      recommendation: {
        llm_hf_repo: 'unsloth/gemma-4-31B-it-GGUF',
        llm_gguf_file: 'gemma-4-31B-it-Q4_K_M.gguf',
        llm_label: 'Gemma 4 31B IT',
        llm_abliterated: false,
        image: 'z-image-turbo-fp16',
        tts: 'qwen3-tts-1.7b',
        tier: 'ultra',
        estimated_download_gb: 38,
      },
    }),
    safe_llm_alternative: () => ({}),
    detect_installed_tools: () => ({
      python: { id: 'python', label: 'Python 3.11–3.12', installed: true, version: 'Python 3.14.0', path: 'C:\\\\Python314\\\\python.exe', compatible: false, min_version: '3.11', note: 'Versión fuera del rango 3.11–3.12, se descargará 3.11 embebido' },
      node:   { id: 'node', label: 'Node.js 22+', installed: true, version: 'v25.2.1', path: 'C:\\\\Program Files\\\\nodejs\\\\node.exe', compatible: true, min_version: '22', note: 'Detectado, no se descargará portable' },
      ffmpeg: { id: 'ffmpeg', label: 'FFmpeg 6+', installed: true, version: '8.0.1', path: 'C:\\\\ffmpeg\\\\bin\\\\ffmpeg.exe', compatible: true, min_version: '6', note: 'Detectado, se reutiliza' },
      ollama: { id: 'ollama', label: 'Ollama', installed: true, version: '0.23.0', path: 'C:\\\\Users\\\\swon\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe', compatible: true, min_version: '0.1', note: 'Detectado, se reutiliza' },
      git:    { id: 'git', label: 'Git', installed: true, version: '2.47.0', path: 'C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe', compatible: true, min_version: '2.0', note: 'Detectado' },
    }),
    get_install_manifest: () => ([
      { id: 'python-3.11',     label: 'Python 3.11 embebido',         category: 'runtime',     size_bytes: 31457280, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'node-22',          label: 'Node.js 22 portable',          category: 'runtime',     size_bytes: 36700160, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'ffmpeg-8',         label: 'FFmpeg 8',                     category: 'tool',         size_bytes: 83886080, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'ollama',           label: 'Ollama',                       category: 'tool',         size_bytes: 629145600, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'sidecar-py-files', label: 'Sidecar Python (código)',      category: 'sidecar',      size_bytes: 204800, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'python-deps-ai',   label: 'Python AI (torch, diffusers)', category: 'postinstall',  size_bytes: 3670016000, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'model-z-image',    label: 'Z-Image-Turbo',                category: 'model',        size_bytes: 9663676416, kind: {}, required: true, depends_on: [], url: '' },
      { id: 'llm-gguf',         label: 'LLM: Gemma 4 31B IT',          category: 'model',        size_bytes: 20401094656, kind: {}, required: true, depends_on: [], url: '' },
    ]),
    list_projects: () => ([
      { id: '01HXXX', title: 'The Jade Emperor Ascension', topic: 'Origins of celestial bureaucracy', status: 'ready', languages: '["en","es"]', duration_seconds: 840, created_at: 1715000000, updated_at: 1715000000, error_message: null },
      { id: '01HYYY', title: 'Sword Saint of Mount Hua',   topic: 'Cultivation under Master Feng', status: 'generating', languages: '["en"]', duration_seconds: null, created_at: 1715100000, updated_at: 1715100000, error_message: null },
      { id: '01HZZZ', title: 'Demon Empress Falls',         topic: 'Heavenly punishment arc', status: 'published', languages: '["en","es","zh"]', duration_seconds: 1080, created_at: 1714900000, updated_at: 1714900000, error_message: null },
    ]),
    get_sidecar_state: () => ({ python: 'running', node: 'running', ollama: 'running' }),
    get_workspace_root: () => 'C:\\\\Users\\\\swon\\\\Xianxia_Studio',
    get_sidecar_logs: () => ({ python: '[mock] sidecar healthy', node: '[mock] sidecar healthy' }),
    youtube_status: () => ({ connected: false, expires_at: null }),
    youtube_app_status: () => ({ configured: false, client_id_preview: null }),
    youtube_set_app_credentials: () => null,
    youtube_clear_app_credentials: () => null,
    youtube_disconnect: () => null,
    verify_stack: () => ({
      all_ok: true,
      checks: [
        { id: 'python',       label: 'Python 3.11 embebido', ok: true, detail: 'C:\\\\runtime\\\\python\\\\python.exe' },
        { id: 'node',         label: 'Node.js portable',     ok: true, detail: 'instalado' },
        { id: 'ffmpeg',       label: 'FFmpeg',               ok: true, detail: 'presente' },
        { id: 'ollama',       label: 'Ollama daemon',        ok: true, detail: 'corriendo en :11434' },
        { id: 'sidecar-py',   label: 'Sidecar Python',       ok: true, detail: 'responde en :8731' },
        { id: 'sidecar-node', label: 'Sidecar Node',         ok: true, detail: 'responde en :8732' },
        { id: 'model-llm',    label: 'Gemma 4 GGUF',         ok: true, detail: 'C:\\\\models\\\\llm' },
        { id: 'model-image',  label: 'Z-Image-Turbo',        ok: true, detail: 'C:\\\\models\\\\image' },
        { id: 'model-tts',    label: 'Qwen3-TTS',            ok: true, detail: 'C:\\\\models\\\\tts' },
        { id: 'model-whisper',label: 'faster-whisper',       ok: true, detail: 'C:\\\\models\\\\whisper' },
      ],
    }),
    create_project: ({args}) => ({ id: '01HMOCK', ...args, status: 'draft', languages: JSON.stringify(args.languages), duration_seconds: null, created_at: Date.now()/1000, updated_at: Date.now()/1000, error_message: null }),
    start_generation: () => '01HMOCK',
    run_install: () => ({ completed: [], failed: [], skipped: [] }),
    install_llm: () => ({ model_name: 'xianxia-llm', gguf_path: 'mocked', bytes: 5400000000 }),
  };

  // Track event listeners so unregister calls don't crash
  let listenerCounter = 1;
  const listeners = new Map();

  // Inject the Tauri global API expected by @tauri-apps/api/core
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      // Event listen / unlisten come through invoke as plugin:event|listen / |unlisten
      if (cmd === 'plugin:event|listen') {
        const id = listenerCounter++;
        listeners.set(id, args);
        return Promise.resolve(id);
      }
      if (cmd === 'plugin:event|unlisten') {
        listeners.delete((args && args.eventId) || -1);
        return Promise.resolve();
      }
      const fn = mocks[cmd];
      if (!fn) {
        console.warn('[mock] unhandled invoke', cmd, args);
        return Promise.resolve(null);
      }
      try {
        return Promise.resolve(fn(args || {}));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    runCallback: (id, payload) => {
      const ent = listeners.get(id);
      if (ent && typeof ent.handler === 'function') ent.handler(payload);
    },
    unregisterListener: (id) => listeners.delete(id),
  };
  window.__TAURI__ = window.__TAURI_INTERNALS__;
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, eventId) => listeners.delete(eventId),
  };
  // Plugin-shell open() — for the OAuth button etc.
  window.__TAURI_PLUGIN_SHELL_INTERNALS__ = { open: () => Promise.resolve() };
})();
`;
