// Prepares sidecars for Tauri bundling. Runs before `tauri build`.
//
// What it does:
//   1. Cleans apps/desktop/src-tauri/sidecars/
//   2. Copies apps/sidecar-py source (excluding caches and venv) →
//      apps/desktop/src-tauri/sidecars/sidecar-py/
//   3. Builds apps/sidecar-node (tsc + templates), then materializes a real
//      node_modules tree (no pnpm symlinks) via `npm install --omit=dev` in a
//      temp dir, and copies dist + package.json + node_modules →
//      apps/desktop/src-tauri/sidecars/sidecar-node/
//
// The Tauri config picks these up via `bundle.resources: ["sidecars/**"]`,
// the installer ships them, and the Rust supervisor extracts them to
// <data_dir>/runtime/sidecar-{py,node}/ on first launch.
//
// Idempotent. Safe to re-run.

import { rm, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_PY = join(ROOT, 'apps', 'sidecar-py');
const SRC_NODE = join(ROOT, 'apps', 'sidecar-node');
const OUT = join(ROOT, 'apps', 'desktop', 'src-tauri', 'sidecars');
const OUT_PY = join(OUT, 'sidecar-py');
const OUT_NODE = join(OUT, 'sidecar-node');

const PY_EXCLUDE = /(__pycache__|\.venv|^venv$|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.egg-info|\.pyc$|\.pyo$)/;

async function rimraf(p) {
  await rm(p, { recursive: true, force: true });
}

function run(cmd, cwd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

async function copyPySource() {
  console.log('\n[1/2] sidecar-py');
  await rimraf(OUT_PY);
  await mkdir(OUT_PY, { recursive: true });
  await cp(SRC_PY, OUT_PY, {
    recursive: true,
    filter: (src) => !PY_EXCLUDE.test(src),
  });
  console.log(`  copied → ${OUT_PY}`);
}

async function buildAndCopyNode() {
  console.log('\n[2/2] sidecar-node');
  // v0.1.45: ALWAYS rebuild. Previously this only ran `tsc` if
  // `dist/server.js` was missing — but that meant any edit to a .ts
  // file (e.g. render.ts thumbnail fix in v0.1.42) silently shipped
  // with the STALE `dist/*.js` from the previous build. Every install
  // since the thumbnail regression had the unfixed bundle even though
  // the source code was correct.
  console.log('  building TypeScript (always, to avoid stale dist)…');
  run('pnpm --filter @xianxia/sidecar-node build', ROOT);
  await rimraf(OUT_NODE);
  await mkdir(OUT_NODE, { recursive: true });

  // Copy dist + package.json + tsconfig (only what the runtime needs)
  await cp(join(SRC_NODE, 'dist'), join(OUT_NODE, 'dist'), { recursive: true });
  await cp(join(SRC_NODE, 'package.json'), join(OUT_NODE, 'package.json'));

  // Materialize a flat node_modules tree (npm, no pnpm symlinks) so it works
  // outside the workspace. Use a temp dir so the workspace's .npmrc / pnpm
  // doesn't interfere.
  const stage = join(tmpdir(), `xianxia-sidecar-node-stage-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  // Strip devDependencies — only ship runtime deps (fastify, hyperframes, etc.)
  const pkg = JSON.parse(await readFile(join(SRC_NODE, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  pkg.private = true;
  await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log('  installing production deps with npm (no pnpm symlinks)…');
  run('npm install --omit=dev --omit=optional --no-audit --no-fund --no-package-lock', stage);
  await cp(join(stage, 'node_modules'), join(OUT_NODE, 'node_modules'), { recursive: true });
  await rimraf(stage);
  console.log(`  copied → ${OUT_NODE}`);
}

async function main() {
  console.log(`Preparing sidecars at ${OUT}`);
  // Clean only the staging subdirs, not the OUT root (we keep README.md
  // committed so Tauri's bundle.resources glob always has a target).
  await rimraf(OUT_PY);
  await rimraf(OUT_NODE);
  await mkdir(OUT, { recursive: true });
  await copyPySource();
  await buildAndCopyNode();
  console.log('\n✓ Sidecars ready for Tauri bundle');
}

main().catch((e) => {
  console.error('Sidecar prep failed:', e);
  process.exit(1);
});
