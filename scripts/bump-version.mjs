// Bumps the application version everywhere it lives.
// Versioning policy: PATCH bumps only (0.1.0 → 0.1.1 → 0.1.2 …) per
// project convention. Pass `--minor` or `--major` only for breaking
// jumps (rare; ask the user first).
//
// Usage:
//   node scripts/bump-version.mjs            # auto-bump patch
//   node scripts/bump-version.mjs 0.2.0      # explicit version
//   node scripts/bump-version.mjs --minor    # bump minor
//   node scripts/bump-version.mjs --major    # bump major
//
// Updates:
//   package.json
//   apps/desktop/package.json
//   apps/desktop/src-tauri/tauri.conf.json   (version)
//   apps/desktop/src-tauri/Cargo.toml         (package.version)
//
// After bumping:
//   git add ... && git commit -m "release: vX.Y.Z" && git tag vX.Y.Z

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const explicit = args.find((a) => /^\d+\.\d+\.\d+/.test(a));
const flag = args.find((a) => a.startsWith('--'));

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function writeJson(p, obj) {
  await writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const rootPkgPath = join(ROOT, 'package.json');
const rootPkg = await readJson(rootPkgPath);

let next;
if (explicit) {
  next = explicit;
} else {
  const [maj, min, pat] = rootPkg.version.split('.').map(Number);
  if (flag === '--major') next = `${maj + 1}.0.0`;
  else if (flag === '--minor') next = `${maj}.${min + 1}.0`;
  else next = `${maj}.${min}.${pat + 1}`;
}

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(next)) {
  console.error(`Invalid version: ${next}`);
  process.exit(1);
}

console.log(`Bumping ${rootPkg.version} → ${next}\n`);

// 1. root package.json
rootPkg.version = next;
await writeJson(rootPkgPath, rootPkg);
console.log('  ✓ package.json');

// 2. apps/desktop/package.json
const desktopPkgPath = join(ROOT, 'apps', 'desktop', 'package.json');
const desktopPkg = await readJson(desktopPkgPath);
desktopPkg.version = next;
await writeJson(desktopPkgPath, desktopPkg);
console.log('  ✓ apps/desktop/package.json');

// 3. apps/desktop/src-tauri/tauri.conf.json
const tauriConfPath = join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
const tauriConf = await readJson(tauriConfPath);
tauriConf.version = next;
await writeJson(tauriConfPath, tauriConf);
console.log('  ✓ apps/desktop/src-tauri/tauri.conf.json');

// 4. apps/desktop/src-tauri/Cargo.toml — surgical text replace so we
//    don't disturb formatting / comments.
const cargoPath = join(ROOT, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
let cargo = await readFile(cargoPath, 'utf8');
const before = cargo;
cargo = cargo.replace(
  /^(version\s*=\s*")\d+\.\d+\.\d+(?:-[\w.]+)?(")/m,
  `$1${next}$2`,
);
if (cargo === before) {
  console.error('  ✗ Cargo.toml — could not find version line');
  process.exit(1);
}
await writeFile(cargoPath, cargo, 'utf8');
console.log('  ✓ apps/desktop/src-tauri/Cargo.toml');

console.log(`\nNext steps:`);
console.log(`  git add -u`);
console.log(`  git commit -m "release: v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin main --follow-tags`);
