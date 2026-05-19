#!/usr/bin/env node
/**
 * Dev ↔ prod runtime parity sync.
 *
 * The Tauri supervisor (see apps/desktop/src-tauri/src/sidecars/mod.rs:
 * resolve_sidecar) looks for sidecars at:
 *
 *   1. `<data_dir>/runtime/sidecar-{py,node}/`  ← prod path, populated
 *      from the installer's bundled resources via extract.rs.
 *   2. `<workspace>/apps/sidecar-{py,node}/`    ← dev fallback when (1)
 *      is empty (no install ever ran).
 *
 * Falling back to the workspace path means that in dev:
 *   - Python sidecar runs from a different cwd than prod
 *     (`apps/sidecar-py` vs `<data_dir>/runtime/sidecar-py`).
 *   - Node sidecar runs against `apps/sidecar-node/dist/server.js`
 *     (which may be STALE if you edited a .ts file and forgot to rebuild).
 *
 * Either of those silently desyncs dev from prod and that's exactly how
 * we shipped 4 versions of the thumbnail bug.
 *
 * This script makes them identical:
 *   1. Calls `pnpm sidecars:prepare` so apps/desktop/src-tauri/sidecars/
 *      has the freshest copy (recompiles sidecar-node TS in the process).
 *   2. Copies that staged tree into `<data_dir>/runtime/sidecar-{py,node}/`
 *      with the version marker — mimicking exactly what extract.rs does
 *      on first install.
 *   3. Runs scripts/parity-check.mjs so any code-level invariant
 *      violations fail BEFORE Tauri tries to start.
 *
 * After this, `tauri dev` finds sidecars at the prod path and they
 * behave identically to a real install.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`✗ command failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function dataDir() {
  // Mirrors `directories::ProjectDirs::from("studio","xianxia","XianxiaStudio")`
  // and our paths::paths() Rust helper on Windows.
  const appdata = process.env.APPDATA;
  if (appdata) return join(appdata, 'xianxia', 'XianxiaStudio', 'data');
  // best-effort macOS / linux fallbacks (we don't ship on those today)
  if (process.platform === 'darwin') {
    return join(process.env.HOME, 'Library', 'Application Support', 'xianxia', 'XianxiaStudio', 'data');
  }
  return join(process.env.HOME, '.local', 'share', 'xianxia', 'XianxiaStudio', 'data');
}

function readPkgVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

console.log('Dev↔prod sync — staging sidecars into runtime dir\n');

// 1) Prepare (recompiles node TS + copies py source) into src-tauri/sidecars/
console.log('[1/3] pnpm sidecars:prepare');
run('pnpm', ['sidecars:prepare']);

// 2) Mirror src-tauri/sidecars/ → <data_dir>/runtime/sidecar-{py,node}/
const stagedRoot = join(ROOT, 'apps', 'desktop', 'src-tauri', 'sidecars');
const runtimeRoot = join(dataDir(), 'runtime');
const version = readPkgVersion();

if (!existsSync(stagedRoot)) {
  console.error(`✗ staged sidecars not found at ${stagedRoot}`);
  process.exit(1);
}
mkdirSync(runtimeRoot, { recursive: true });

for (const name of ['sidecar-py', 'sidecar-node']) {
  const src = join(stagedRoot, name);
  const dst = join(runtimeRoot, name);
  if (!existsSync(src)) {
    console.warn(`  - ${name} missing in staging — skipping`);
    continue;
  }
  // Wipe and recopy so deletions in source propagate (parity with
  // extract.rs which does the same on version bump).
  if (existsSync(dst)) {
    try { rmSync(dst, { recursive: true, force: true }); }
    catch (e) { console.warn(`  - could not clean ${dst}: ${e.message}`); }
  }
  cpSync(src, dst, { recursive: true });
  // Write the version marker so extract.rs treats this as "already
  // extracted, current" and doesn't re-blow it away on next Tauri start.
  writeFileSync(join(dst, '.bundle-version'), version);
  console.log(`[2/3] synced ${name} → ${dst}`);
}

// 3) Parity check — fails fast if any invariant is broken
console.log('[3/3] parity check');
run('node', ['scripts/parity-check.mjs']);

console.log('\n✓ Dev runtime now mirrors prod — safe to `pnpm tauri:dev`');
