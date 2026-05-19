#!/usr/bin/env node
/**
 * Tauri-less dev mode for Playwright-driven testing.
 *
 * Spawns the sidecars and Vite, leaves the Tauri webview out of the
 * equation. Then `localhost:1420` can be driven by Playwright / Chrome
 * directly. The `tauri-shim.ts` re-routes every `invoke()` to HTTP
 * calls against the sidecars, mirroring the Rust pipeline.
 *
 * Why this exists:
 *   - `pnpm tauri:dev` spawns a Tauri webview window we can't drive
 *     from Playwright (no DevTools by default, no remote debugging).
 *   - Compiling the installer takes 12 min; if we test in dev first
 *     we can iterate in seconds.
 *   - The shim's `start_generation` re-implementation makes browser
 *     mode behave like the Rust supervisor — same sidecar endpoints,
 *     same parameters (intro_offset, depthflow/batch, etc.), so a
 *     test passing here is a strong signal it'll pass in Tauri/prod.
 *
 * The four processes started:
 *   1. Python sidecar  on :8731 (FastAPI + uvicorn from bundled python)
 *   2. Node   sidecar  on :8732 (Fastify, compiled JS from dist/)
 *   3. ComfyUI         on :8188 (started lazily via `/comfyui` on demand)
 *   4. Vite dev server on :1420 (React UI with HMR)
 *
 * Ctrl-C cleans up all of them.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function dataDir() {
  const appdata = process.env.APPDATA;
  if (appdata) return join(appdata, 'xianxia', 'XianxiaStudio', 'data');
  if (process.platform === 'darwin') {
    return join(process.env.HOME, 'Library', 'Application Support', 'xianxia', 'XianxiaStudio', 'data');
  }
  return join(process.env.HOME, '.local', 'share', 'xianxia', 'XianxiaStudio', 'data');
}

const DATA = dataDir();
const RUNTIME = join(DATA, 'runtime');

// 1) Sync sidecars to runtime (recompile TS, copy source, validate invariants)
console.log('[1/4] Syncing sidecars + parity check…');
const sync = spawnSync('node', ['scripts/dev-sync.mjs'], {
  cwd: ROOT, stdio: 'inherit', shell: true,
});
if (sync.status !== 0) {
  console.error('✗ dev-sync failed');
  process.exit(sync.status ?? 1);
}

// 2) Resolve runtime paths
const PY_EXE = join(RUNTIME, 'python', 'python', 'python.exe');
const PY_SERVER = join(RUNTIME, 'sidecar-py', 'server.py');
const NODE_SERVER = join(RUNTIME, 'sidecar-node', 'dist', 'server.js');

const missing = [];
if (!existsSync(PY_EXE)) missing.push(`bundled python at ${PY_EXE}`);
if (!existsSync(PY_SERVER)) missing.push(`sidecar-py/server.py at ${PY_SERVER}`);
if (!existsSync(NODE_SERVER)) missing.push(`sidecar-node/dist/server.js at ${NODE_SERVER}`);
if (missing.length) {
  console.error('✗ runtime missing:\n  • ' + missing.join('\n  • '));
  console.error('\n  Install Xianxia Studio at least once (or run `pnpm tauri:dev` to bootstrap).');
  process.exit(1);
}

// 3) Kill orphan sidecars from any previously-running install (the Tauri
//    supervisor does the same in mod.rs:kill_orphan_sidecars — without
//    this, ports 8731/8732/8188 stay bound by a stale process and the
//    new ones we spawn die with EADDRINUSE).
console.log('[3/4] Killing orphan sidecars + freeing ports 8731/8732/8188…');
function killByPort(port) {
  if (process.platform !== 'win32') return;
  // netstat → PID list → taskkill /F
  const r = spawnSync('cmd', ['/c', `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do @taskkill /F /PID %a 2>NUL`], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  // Ignore exit code — no listener is fine.
}
for (const port of [8731, 8732, 8188]) killByPort(port);

// 4) Common env mirroring the Rust supervisor (sidecars/mod.rs:540-573)
//    Without these the bundled python can't find xianxia_ai, ffmpeg
//    won't be on PATH, HF cache resolves wrong, etc.
const augmentedPath = [
  join(RUNTIME, 'ffmpeg', 'bin'),
  join(RUNTIME, 'sidecar-node', 'node_modules', '.bin'),
  join(RUNTIME, 'python', 'python'),
  process.env.PATH || '',
].filter(Boolean).join(';');

const PY_CWD = join(RUNTIME, 'sidecar-py');
const NODE_CWD = join(RUNTIME, 'sidecar-node');
const COMFY_DIR = join(RUNTIME, 'comfyui');
const COMFY_MAIN = join(COMFY_DIR, 'main.py');
const PROJECTS_DIR = join(DATA, 'projects');
const MUSIC_DIR = join(DATA, 'assets', 'music');

const pyEnv = {
  ...process.env,
  PATH: augmentedPath,
  PYTHONPATH: join(PY_CWD, 'src'),
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  HF_HOME: join(DATA, 'hf-cache'),
  HF_HUB_ENABLE_HF_TRANSFER: '1',
  XIANXIA_DATA_DIR: DATA,
  XIANXIA_USE_COMFYUI: '1',
  XIANXIA_COMFY_DIR: COMFY_DIR,
  XIANXIA_MUSIC_DIR: MUSIC_DIR,
  XIANXIA_OUT_DIR: PROJECTS_DIR,
};

const nodeEnv = {
  ...process.env,
  PATH: augmentedPath,
  XIANXIA_NODE_PORT: '8732',
  XIANXIA_DATA_DIR: DATA,
};

// 5) Spawn the four processes with correct cwd + env
const procs = [];
function spawnLogged(name, cmd, args, opts = {}) {
  console.log(`[4/4] starting ${name}`);
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  p.on('exit', (code) => console.log(`  ${name} exited (${code})`));
  procs.push({ name, p });
}

spawnLogged('python sidecar (8731)', `"${PY_EXE}"`, [`"${PY_SERVER}"`], { cwd: PY_CWD, env: pyEnv });
spawnLogged('node sidecar (8732)', 'node', [`"${NODE_SERVER}"`], { cwd: NODE_CWD, env: nodeEnv });
spawnLogged('vite (1420)', 'pnpm', ['--filter', '@xianxia/desktop', 'dev'], { cwd: ROOT });
// ComfyUI eagerly — without this, the supervisor's lazy start would kick in
// only when the first /image hits, adding ~1 min to the first run.
// (Pre-warming also gives Z-Image-Turbo time to load weights while TTS runs,
// shaving more wall-clock off the e2e iteration loop.)
if (existsSync(COMFY_MAIN)) {
  spawnLogged(
    'ComfyUI (8188)',
    `"${PY_EXE}"`,
    [`"${COMFY_MAIN}"`, '--port', '8188', '--listen', '127.0.0.1', '--disable-auto-launch', '--enable-cors-header', '*'],
    { cwd: COMFY_DIR, env: pyEnv },
  );
} else {
  console.warn(`  - ComfyUI main.py missing at ${COMFY_MAIN}; image phase will fail`);
}

console.log('\n[4/4] All processes spawned. Open http://localhost:1420 in your browser');
console.log('     (or point Playwright at it). Ctrl-C to stop everything.');
console.log('     ComfyUI on :8188 starts lazily on first /image call.\n');

function cleanup() {
  console.log('\nShutting down…');
  for (const { name, p } of procs) {
    try { p.kill('SIGTERM'); } catch {}
    console.log(`  killed ${name}`);
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
