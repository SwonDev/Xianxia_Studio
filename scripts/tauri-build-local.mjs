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
 *     (`TAURI_SIGNING_PRIVATE_KEY`). On a developer's machine the
 *     secret isn't available, so we use a SEPARATE local-only keypair
 *     that lives in `.tauri-keys/` (git-ignored). Generated once with
 *     `tauri signer generate -w .tauri-keys/local-private.key -p ""`.
 *
 * Behaviour:
 *   - If the env var TAURI_SIGNING_PRIVATE_KEY is already set, use it
 *     as-is (CI flow, never override).
 *   - Else, look for `.tauri-keys/local-private.key` and load it.
 *   - Else, run the build anyway (the user can ignore the trailing
 *     signing error — the .exe is still produced before signing).
 *
 * The local-signed builds will NOT verify against the production
 * pubkey on auto-update, which is the desired behaviour: dev builds
 * shouldn't replace user-installed releases.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOCAL_KEY_PATH = join(ROOT, '.tauri-keys', 'local-private.key');

const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (existsSync(LOCAL_KEY_PATH)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(LOCAL_KEY_PATH, 'utf8').trim();
    // The local key was generated with an empty password. The Tauri
    // bundler still wants the env var to be defined (empty is fine).
    if (!('TAURI_SIGNING_PRIVATE_KEY_PASSWORD' in env)) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    }
    console.log(
      '[tauri-build-local] Using local signing key from',
      LOCAL_KEY_PATH,
    );
  } else {
    console.warn(
      '[tauri-build-local] No local signing key found at',
      LOCAL_KEY_PATH,
    );
    console.warn(
      '  Generate one with: pnpm tauri signer generate -w .tauri-keys/local-private.key -p ""',
    );
    console.warn('  The bundler will still produce the .exe but will fail at signing.');
  }
}

// 1) prepare sidecars
const prep = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['sidecars:prepare'],
  { cwd: ROOT, stdio: 'inherit', env, shell: false },
);
if (prep.status !== 0) {
  process.exit(prep.status ?? 1);
}

// 2) tauri build
const args = process.argv.slice(2);
const build = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@xianxia/desktop', 'tauri', 'build', ...args],
  { cwd: ROOT, stdio: 'inherit', env, shell: false },
);
process.exit(build.status ?? 0);
