#!/usr/bin/env node
/**
 * tauri:build wrapper that injects the LOCAL signing key automatically.
 *
 * Why this exists:
 *   - tauri.conf.json sets `updater.pubkey`, which forces the Tauri
 *     bundler to sign every output. Without a private key the build
 *     fails with "A public key has been found, but no private key" at
 *     the very end, even though the .exe + .msi are already produced.
 *   - On GitHub Actions the production key is provided as a secret
 *     (`TAURI_SIGNING_PRIVATE_KEY`). On the maintainer's machine the
 *     production key lives at `~/.tauri/xianxia-updater.key` and its
 *     password in the sibling `.password` file.
 *
 * Key resolution order (v0.12.8 — fixes mismatch warning):
 *   1. env TAURI_SIGNING_PRIVATE_KEY already set → use as-is (CI flow).
 *   2. `~/.tauri/xianxia-updater.key` exists → PRODUCTION key whose
 *      pubkey MATCHES `tauri.conf.json` updater.pubkey. The updater
 *      .sig artifacts produced will verify at runtime; auto-update
 *      between releases works end-to-end. Password loaded from
 *      `~/.tauri/xianxia-updater.key.password` if present.
 *   3. `.tauri-keys/local-private.key` exists → LEGACY local-only key
 *      that does NOT match the production pubkey. Builds will surface
 *      the "secret key does not match public key" warning and the
 *      resulting .sig files won't validate at install time. Kept as a
 *      contributor fallback (no access to the maintainer's key) — but
 *      releases SHOULD never be cut with this key. Loud warning.
 *   4. No key at all → bundler will print its own error after the .exe
 *      is already on disk.
 *
 * Rationale for switching the default from step 3 (legacy) to step 2
 * (production): the build produced three updater warnings per release
 * for ~24 versions; releases technically worked but `latest.json` and
 * its `.sig` were unusable. The maintainer key was always there — the
 * script just wasn't reading it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PROD_KEY_PATH = join(homedir(), '.tauri', 'xianxia-updater.key');
const PROD_KEY_PASSWORD_PATH = `${PROD_KEY_PATH}.password`;
const LOCAL_KEY_PATH = join(ROOT, '.tauri-keys', 'local-private.key');

const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  // Step 2 — production key (matches updater.pubkey in tauri.conf.json).
  if (existsSync(PROD_KEY_PATH)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(PROD_KEY_PATH, 'utf8').trim();
    if (!('TAURI_SIGNING_PRIVATE_KEY_PASSWORD' in env)) {
      if (existsSync(PROD_KEY_PASSWORD_PATH)) {
        env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(
          PROD_KEY_PASSWORD_PATH,
          'utf8',
        ).trim();
      } else {
        env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
      }
    }
    console.log(
      '[tauri-build-local] Using PRODUCTION signing key from',
      PROD_KEY_PATH,
    );
    console.log(
      '[tauri-build-local]   matches updater.pubkey in tauri.conf.json — .sig artifacts will verify at runtime',
    );
  } else if (existsSync(LOCAL_KEY_PATH)) {
    // Step 3 — legacy local fallback (will mismatch pubkey).
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(LOCAL_KEY_PATH, 'utf8').trim();
    if (!('TAURI_SIGNING_PRIVATE_KEY_PASSWORD' in env)) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    }
    console.warn(
      '[tauri-build-local] Using LEGACY local key from',
      LOCAL_KEY_PATH,
    );
    console.warn(
      '[tauri-build-local]   ⚠  pubkey MISMATCH — the bundler will print 3 warnings and the produced .sig files will NOT verify on auto-update.',
    );
    console.warn(
      '[tauri-build-local]   For a clean release, place the production key at',
      PROD_KEY_PATH,
    );
  } else {
    // Step 4 — no key.
    console.warn(
      '[tauri-build-local] No signing key found. Looked at:',
    );
    console.warn('  1.', PROD_KEY_PATH, '(production, matches pubkey)');
    console.warn('  2.', LOCAL_KEY_PATH, '(legacy fallback, does NOT match pubkey)');
    console.warn(
      '  Generate the local fallback with: pnpm tauri signer generate -w .tauri-keys/local-private.key -p ""',
    );
    console.warn('  The bundler will still produce the .exe but will fail at signing.');
  }
}

// 1) prepare sidecars
const prep = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['sidecars:prepare'],
  { cwd: ROOT, stdio: 'inherit', env, shell: true },
);
if (prep.status !== 0) {
  process.exit(prep.status ?? 1);
}

// 2) tauri build
const args = process.argv.slice(2);
const build = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@xianxia/desktop', 'tauri', 'build', ...args],
  { cwd: ROOT, stdio: 'inherit', env, shell: true },
);
process.exit(build.status ?? 0);
