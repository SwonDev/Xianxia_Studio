/**
 * Structured logger for the Node sidecar.
 *
 * Two transports:
 *   - pino-pretty to stderr (human-readable, only when XIANXIA_LOG_PRETTY=1)
 *   - file destination at <cache_dir>/logs/sidecar-node.jsonl with NDJSON
 *     lines so /diag/snapshot can merge them with the Python and Rust
 *     streams chronologically.
 *
 * Each line is `{ "level": ..., "time": ..., "source": "node", ...fields }`,
 * matching the schema documented in docs/ROADMAP_v0.1.10.md.
 */
import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

function resolveLogDir(): string {
  if (process.env.XIANXIA_LOG_DIR) return process.env.XIANXIA_LOG_DIR;
  if (platform() === 'win32') {
    const localAppdata = process.env.LOCALAPPDATA;
    if (localAppdata) {
      return join(localAppdata, 'xianxia', 'XianxiaStudio', 'cache', 'logs');
    }
  } else if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'studio.xianxia.XianxiaStudio', 'logs');
  } else {
    return join(homedir(), '.cache', 'xianxia', 'XianxiaStudio', 'logs');
  }
  return './logs';
}

const LOG_DIR = resolveLogDir();
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* best effort */
}
const JSONL_PATH = join(LOG_DIR, 'sidecar-node.jsonl');

const baseFields = {
  source: 'node',
  pid: process.pid,
};

const targets: pino.TransportTargetOptions[] = [
  // JSONL file destination — primary observable signal
  {
    target: 'pino/file',
    options: { destination: JSONL_PATH, mkdir: true },
    level: process.env.XIANXIA_LOG_LEVEL ?? 'info',
  },
];

// Optional pretty stderr for dev. Set XIANXIA_LOG_PRETTY=1 to enable.
if (process.env.XIANXIA_LOG_PRETTY === '1') {
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', destination: 2 },
    level: 'debug',
  });
}

export const logger = pino(
  {
    base: baseFields,
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  pino.transport({ targets }),
);

export const LOG_FILE_PATH = JSONL_PATH;
