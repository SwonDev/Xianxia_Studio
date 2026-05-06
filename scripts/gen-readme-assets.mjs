// Generates README promotional images using the brand palette.
//
//   pnpm readme:assets
//
// Outputs to assets/promo/:
//   banner.png        1280×420   GitHub README hero image
//   feature-card.png  1280×640   social share preview / Open Graph

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_LOGO = join(ROOT, 'assets', 'logo', 'logo.svg');
const OUT = join(ROOT, 'assets', 'promo');
await mkdir(OUT, { recursive: true });

const C = {
  obsidian950: '#0a0a0f',
  obsidian900: '#15151d',
  obsidian800: '#22222e',
  gold500: '#c9a961',
  gold400: '#d4b876',
  gold300: '#e0c98c',
  paper50: '#f5f1e8',
  paper200: '#cfc9b8',
  paper400: '#86826f',
  jade400: '#52b788',
};

const logoSvg = await readFile(SRC_LOGO, 'utf8');

async function renderLogo(sizePx) {
  return sharp(Buffer.from(logoSvg), {
    density: Math.max(96, Math.round((sizePx / 1002) * 96)),
  })
    .resize(sizePx, sizePx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// ────────────────────────────────────────────────────────────────────
// 1. README banner (1280×420)
// ────────────────────────────────────────────────────────────────────
{
  const W = 1280, H = 420;

  const bg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stop-color="${C.obsidian950}"/>
          <stop offset="55%"  stop-color="${C.obsidian900}"/>
          <stop offset="100%" stop-color="${C.obsidian950}"/>
        </linearGradient>
        <radialGradient id="goldGlow" cx="22%" cy="50%" r="42%">
          <stop offset="0%"   stop-color="${C.gold500}" stop-opacity="0.32"/>
          <stop offset="55%"  stop-color="${C.gold500}" stop-opacity="0.10"/>
          <stop offset="100%" stop-color="${C.gold500}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="jadeGlow" cx="92%" cy="78%" r="35%">
          <stop offset="0%"   stop-color="${C.jade400}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${C.jade400}" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="rule" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stop-color="${C.gold500}" stop-opacity="0"/>
          <stop offset="50%"  stop-color="${C.gold500}" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="${C.gold500}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <rect width="${W}" height="${H}" fill="url(#goldGlow)"/>
      <rect width="${W}" height="${H}" fill="url(#jadeGlow)"/>
      <rect x="0" y="${H - 1}" width="${W}" height="1" fill="url(#rule)"/>
    </svg>`;

  const text = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <g font-family="'EB Garamond', 'Noto Serif SC', Georgia, 'Times New Roman', serif">
        <text x="320" y="180" font-size="84" font-weight="600" fill="${C.gold300}">Xianxia Studio</text>
        <text x="320" y="220" font-size="22" font-weight="500" fill="${C.paper200}" letter-spacing="6">CINEMATIC LOCAL AI · STUDIO</text>
      </g>
      <g font-family="'Plus Jakarta Sans', system-ui, sans-serif">
        <text x="320" y="278" font-size="22" font-weight="400" fill="${C.paper200}">Producción automatizada de vídeos de YouTube,</text>
        <text x="320" y="306" font-size="22" font-weight="400" fill="${C.paper200}">100 % en tu equipo · sin nube · sin cuotas.</text>
      </g>
      <g font-family="'Plus Jakarta Sans', system-ui, sans-serif">
        <rect x="320" y="335" width="170" height="32" rx="4" fill="${C.gold500}" opacity="0.12" stroke="${C.gold500}" stroke-opacity="0.35"/>
        <text x="335" y="357" font-size="14" font-weight="600" fill="${C.gold300}">Tauri 2 · React 19</text>
        <rect x="500" y="335" width="155" height="32" rx="4" fill="${C.jade400}" opacity="0.10" stroke="${C.jade400}" stroke-opacity="0.30"/>
        <text x="513" y="357" font-size="14" font-weight="600" fill="${C.jade400}">100 % offline AI</text>
        <rect x="665" y="335" width="155" height="32" rx="4" fill="${C.gold500}" opacity="0.08" stroke="${C.gold500}" stroke-opacity="0.30"/>
        <text x="678" y="357" font-size="14" font-weight="600" fill="${C.gold300}">Apache 2.0 OSS</text>
      </g>
    </svg>`;

  const logoSize = 220;
  const logoBuf = await renderLogo(logoSize);
  const out = await sharp(Buffer.from(bg))
    .composite([
      { input: logoBuf, top: Math.round((H - logoSize) / 2), left: 80 },
      { input: Buffer.from(text), top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT, 'banner.png'), out);
  console.log(`  banner.png  (${out.length.toLocaleString()} bytes, ${W}×${H})`);
}

console.log('\nREADME promo assets ready.');
