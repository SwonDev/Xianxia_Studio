import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  renderNarrative,
  renderShort,
  renderThumbnail,
  type AtmosphericFx,
  type Transition,
} from './render.js';
import type { CinematicProfile } from './effects.js';
import { logger } from './logger.js';

// Fastify v5: use `loggerInstance` to pass a pre-built logger; `logger` only
// accepts a config object.
const app = Fastify({ loggerInstance: logger });

// CORS for the browser-mode shim (Vite dev :1420) AND the Tauri webview.
// Tauri 2 on Windows uses http(s)://tauri.localhost (WebView2 protocol);
// Tauri 1 / macOS / Linux uses tauri://localhost. Both are allowed.
await app.register(cors, {
  origin: [
    'http://localhost:1420',
    'http://127.0.0.1:1420',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://asset.localhost',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
});

app.get('/health', async () => ({
  ok: true,
  service: 'xianxia-sidecar-node',
  version: '0.1.0',
}));

app.post<{
  Body: {
    project_id: string;
    title: string;
    images: {
      path: string;
      foreground_path?: string;
      mid_path?: string;
      start: number;
      duration: number;
      fx?: AtmosphericFx;
      transition?: Transition;
      light_rays?: boolean;
    }[];
    narration_path: string;
    music_path?: string;
    out_path: string;
    width?: number;
    height?: number;
    fps?: number;
    cinematic?: CinematicProfile;
    music_volume?: number;
    music_ducking?: boolean;
  };
}>('/render/narrative', async (req) => {
  const result = await renderNarrative(req.body);
  return result;
});

app.post<{
  Body: {
    title_en: string;
    title_zh?: string;
    background_path: string;
    out_path: string;
  };
}>('/render/thumbnail', async (req) => {
  return renderThumbnail(req.body);
});

app.post<{
  Body: {
    clip_path: string;
    hook: string;
    subtitles_srt?: string;
    out_path: string;
  };
}>('/render/short', async (req) => {
  return renderShort(req.body);
});

const port = Number(process.env.XIANXIA_NODE_PORT ?? 8732);
app
  .listen({ host: '127.0.0.1', port })
  .then(() => logger.info({ port }, 'xianxia-sidecar-node up'))
  .catch((err) => {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  });
