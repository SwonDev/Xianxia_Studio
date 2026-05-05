import Fastify from 'fastify';
import { renderNarrative, renderShort, renderThumbnail } from './render.js';
import { logger } from './logger.js';

// Fastify v5: use `loggerInstance` to pass a pre-built logger; `logger` only
// accepts a config object.
const app = Fastify({ loggerInstance: logger });

app.get('/health', async () => ({
  ok: true,
  service: 'xianxia-sidecar-node',
  version: '0.1.0',
}));

app.post<{
  Body: {
    project_id: string;
    title: string;
    images: { path: string; start: number; duration: number }[];
    narration_path: string;
    music_path?: string;
    out_path: string;
    width?: number;
    height?: number;
    fps?: number;
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
