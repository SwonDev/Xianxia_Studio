// Generates Windows installer (NSIS + WiX MSI) graphical assets from
// the master logo, using the Xianxia Studio brand palette
// (obsidian + gold + jade) defined in apps/desktop/src/styles/globals.css.
//
//   pnpm installer:assets
//
// Outputs to assets/installer/:
//   header.bmp        — NSIS header (150×57, 24bpp, BI_RGB)
//   sidebar.bmp       — NSIS welcome/finish sidebar (164×314, 24bpp)
//   wix-banner.bmp    — WiX banner (493×58, 24bpp)
//   wix-dialog.bmp    — WiX welcome/exit dialog (493×312, 24bpp)
//   installer-icon.ico— optional installer icon (multi-size)
//
// All BMPs are 24-bit RGB without alpha (NSIS/WiX requirement).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_LOGO = join(ROOT, 'assets', 'logo', 'logo.svg');
const OUT = join(ROOT, 'assets', 'installer');
await mkdir(OUT, { recursive: true });

// ─── Brand palette (mirrors globals.css OKLCH → sRGB) ─────────────
const C = {
  obsidian950: '#0a0a0f',
  obsidian900: '#15151d',
  obsidian800: '#22222e',
  gold500: '#c9a961',
  gold400: '#d4b876',
  gold300: '#e0c98c',
  paper50: '#f5f1e8',
  paper200: '#cfc9b8',
  jade400: '#52b788',
};

const logoSvg = await readFile(SRC_LOGO, 'utf8');

// Pre-render the logo at the sizes we need so we don't re-rasterise it
// inside every composited image.
async function renderLogoPng(sizePx) {
  return sharp(Buffer.from(logoSvg), {
    density: Math.max(96, Math.round((sizePx / 1002) * 96)),
  })
    .resize(sizePx, sizePx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// ─── Background SVGs (gradient + sutil glow) ──────────────────────
function bgVertical(w, h) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stop-color="${C.obsidian950}"/>
          <stop offset="48%"  stop-color="${C.obsidian900}"/>
          <stop offset="100%" stop-color="${C.obsidian950}"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="22%" r="55%">
          <stop offset="0%"  stop-color="${C.gold500}" stop-opacity="0.20"/>
          <stop offset="55%" stop-color="${C.gold500}" stop-opacity="0.05"/>
          <stop offset="100%" stop-color="${C.gold500}" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="rule" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stop-color="${C.gold500}" stop-opacity="0"/>
          <stop offset="50%"  stop-color="${C.gold500}" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="${C.gold500}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#bg)"/>
      <rect width="${w}" height="${h}" fill="url(#glow)"/>
      <!-- bottom hairline rule -->
      <rect x="0" y="${h - 1}" width="${w}" height="1" fill="url(#rule)"/>
    </svg>`;
}

function bgHorizontal(w, h) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stop-color="${C.obsidian950}"/>
          <stop offset="100%" stop-color="${C.obsidian900}"/>
        </linearGradient>
        <radialGradient id="glow" cx="14%" cy="50%" r="40%">
          <stop offset="0%"  stop-color="${C.gold500}" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="${C.gold500}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#bg)"/>
      <rect width="${w}" height="${h}" fill="url(#glow)"/>
    </svg>`;
}

// ─── Text overlay SVG (uses system serif fallback) ────────────────
function textSvg(width, height, lines) {
  // lines: [{ text, y, size, color, weight?, anchor?, family? }]
  const tspans = lines.map((l) => `
    <text
      x="${l.x ?? width / 2}"
      y="${l.y}"
      text-anchor="${l.anchor ?? 'middle'}"
      font-family="${l.family ?? '\'EB Garamond\', \'Noto Serif SC\', Georgia, \'Times New Roman\', serif'}"
      font-weight="${l.weight ?? 500}"
      font-size="${l.size}"
      fill="${l.color}"
      letter-spacing="${l.tracking ?? 0}"
    >${l.text}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tspans}</svg>`;
}

// ─── PNG → BMP (24-bit BI_RGB, bottom-up, padded rows) ────────────
function pngRgbToBmp(rgb, width, height) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 14 + 40 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt32LE(54, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);
  // Pixel rows: BGR, bottom-up
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 3;
    const dstRow = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      buf[dstRow + x * 3]     = rgb[srcRow + x * 3 + 2]; // B
      buf[dstRow + x * 3 + 1] = rgb[srcRow + x * 3 + 1]; // G
      buf[dstRow + x * 3 + 2] = rgb[srcRow + x * 3];     // R
    }
  }
  return buf;
}

async function compositeAsBmp({ width, height, bg, layers, outFile }) {
  const composite = sharp(Buffer.from(bg))
    .resize(width, height)
    .composite(layers)
    .removeAlpha()
    .raw();
  const { data } = await composite.toBuffer({ resolveWithObject: true });
  const bmp = pngRgbToBmp(data, width, height);
  await writeFile(outFile, bmp);
  // Also dump a PNG preview alongside the BMP so we can review the
  // branding visually without needing a BMP viewer.
  await sharp(Buffer.from(bg))
    .resize(width, height)
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toFile(outFile.replace(/\.bmp$/, '.preview.png'));
  console.log(`  ${outFile.replace(ROOT + '\\', '').replace(ROOT + '/', '')}  (${bmp.length.toLocaleString()} bytes, ${width}×${height})`);
}

// ────────────────────────────────────────────────────────────────────
// 1. NSIS header (150×57)
//    Layout: small logo left + brand name right, horizontal gradient.
// ────────────────────────────────────────────────────────────────────
{
  const W = 150, H = 57;
  const logoSize = 40;
  const logoPng = await renderLogoPng(logoSize);
  const text = textSvg(W, H, [
    { text: 'Xianxia',  x: 56, y: 26, size: 15, color: C.gold300, weight: 600, anchor: 'start' },
    { text: 'STUDIO',   x: 56, y: 42, size:  9, color: C.paper200, weight: 500, anchor: 'start', tracking: 2 },
  ]);
  await compositeAsBmp({
    width: W, height: H,
    bg: bgHorizontal(W, H),
    layers: [
      { input: logoPng, top: Math.round((H - logoSize) / 2), left: 8 },
      { input: Buffer.from(text), top: 0, left: 0 },
    ],
    outFile: join(OUT, 'header.bmp'),
  });
}

// ────────────────────────────────────────────────────────────────────
// 2. NSIS welcome/finish sidebar (164×314)
//    Layout: logo top-centred + brand block + tagline bottom.
// ────────────────────────────────────────────────────────────────────
{
  const W = 164, H = 314;
  const logoSize = 110;
  const logoPng = await renderLogoPng(logoSize);
  const text = textSvg(W, H, [
    { text: 'Xianxia',          y: 200, size: 22, color: C.gold300, weight: 600 },
    { text: 'STUDIO',           y: 222, size: 11, color: C.paper200, weight: 500, tracking: 4 },
    { text: 'Producción',       y: 264, size: 9.5, color: C.paper200, weight: 500 },
    { text: 'cinematográfica',  y: 277, size: 9.5, color: C.paper200, weight: 500 },
    { text: '100 % local',      y: 290, size: 9.5, color: C.jade400, weight: 600, tracking: 0.5 },
  ]);
  await compositeAsBmp({
    width: W, height: H,
    bg: bgVertical(W, H),
    layers: [
      { input: logoPng, top: 50, left: Math.round((W - logoSize) / 2) },
      { input: Buffer.from(text), top: 0, left: 0 },
    ],
    outFile: join(OUT, 'sidebar.bmp'),
  });
}

// ────────────────────────────────────────────────────────────────────
// 3. WiX banner (493×58) — MSI top
// ────────────────────────────────────────────────────────────────────
{
  const W = 493, H = 58;
  const logoSize = 42;
  const logoPng = await renderLogoPng(logoSize);
  const text = textSvg(W, H, [
    { text: 'Xianxia Studio',                   x: 64, y: 28, size: 18, color: C.gold300, weight: 600, anchor: 'start' },
    { text: 'Studio cinematográfico local · 100 % offline', x: 64, y: 44, size: 10, color: C.paper200, weight: 500, anchor: 'start' },
  ]);
  await compositeAsBmp({
    width: W, height: H,
    bg: bgHorizontal(W, H),
    layers: [
      { input: logoPng, top: 8, left: 12 },
      { input: Buffer.from(text), top: 0, left: 0 },
    ],
    outFile: join(OUT, 'wix-banner.bmp'),
  });
}

// ────────────────────────────────────────────────────────────────────
// 4. WiX welcome/exit dialog (493×312)
// ────────────────────────────────────────────────────────────────────
{
  const W = 493, H = 312;
  const sideW = 164;
  const logoSize = 130;
  const logoPng = await renderLogoPng(logoSize);
  // The right ⅔ of the dialog is reserved by Windows Installer for the
  // standard text widgets. The image lives in the left side, centred.
  const text = textSvg(sideW, H, [
    { text: 'Xianxia',         x: sideW / 2, y: 220, size: 22, color: C.gold300, weight: 600 },
    { text: 'STUDIO',          x: sideW / 2, y: 242, size: 12, color: C.paper200, weight: 500, tracking: 4 },
    { text: 'IA local',        x: sideW / 2, y: 282, size: 10, color: C.jade400,  weight: 600, tracking: 0.5 },
  ]);
  // Render the side panel separately, then composite onto a 493×312 canvas
  // whose right portion stays the obsidian gradient (matches the dialog
  // background WiX paints over).
  const sidePanel = await sharp(Buffer.from(bgVertical(sideW, H)))
    .resize(sideW, H)
    .composite([
      { input: logoPng, top: 60, left: Math.round((sideW - logoSize) / 2) },
      { input: Buffer.from(text), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
  const fullBg = bgHorizontal(W, H);
  await compositeAsBmp({
    width: W, height: H,
    bg: fullBg,
    layers: [
      { input: sidePanel, top: 0, left: 0 },
    ],
    outFile: join(OUT, 'wix-dialog.bmp'),
  });
}

// ────────────────────────────────────────────────────────────────────
// 5. Installer icon (.ico, multi-size). Reuse same packing as the main
//    icon script but with extra padding on small sizes for clarity at
//    the NSIS uninstaller list view.
// ────────────────────────────────────────────────────────────────────
{
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = await Promise.all(sizes.map(async (s) => ({
    size: s,
    png: await sharp(Buffer.from(logoSvg), { density: Math.max(96, Math.round((s / 1002) * 96)) })
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  })));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const blobs = [];
  entries.forEach((e, i) => {
    const sz = e.size >= 256 ? 0 : e.size;
    dir.writeUInt8(sz, i * 16);
    dir.writeUInt8(sz, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(e.png.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    blobs.push(e.png);
    offset += e.png.length;
  });
  const ico = Buffer.concat([header, dir, ...blobs]);
  await writeFile(join(OUT, 'installer-icon.ico'), ico);
  console.log(`  installer-icon.ico  (${ico.length.toLocaleString()} bytes, ${sizes.length} sizes)`);
}

console.log('\nInstaller branding assets ready.');
