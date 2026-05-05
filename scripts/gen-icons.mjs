// Rasterize the master SVG logo into PNG/ICO/ICNS for Tauri.
// Uses `sharp` (libvips-based, no system Cairo required).
//   pnpm dlx sharp-cli ...   -- or via this script after `npm i -g sharp`
//
// Usage:
//   node scripts/gen-icons.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'assets', 'logo', 'logo.svg');
const OUT = join(ROOT, 'apps', 'desktop', 'src-tauri', 'icons');

await mkdir(OUT, { recursive: true });

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp not installed. Run:  pnpm add -w sharp     (or npm i -g sharp)');
  process.exit(1);
}

const svgBuffer = await readFile(SRC);

// Sharp renders SVG via librsvg (bundled with the prebuilt binary on Win/Mac/Linux).
const sizes = [
  { name: '32x32.png',      size: 32 },
  { name: '128x128.png',    size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png',       size: 512 },
  { name: 'icon.icns',      size: 512 },
];

console.log(`Source: ${SRC}`);
// Render with transparent background so the SVG's own canvas color (whatever
// the user designed) is preserved. Tauri/OS adds its own backdrop on the icon.
for (const { name, size } of sizes) {
  const png = await sharp(svgBuffer, { density: Math.max(72, Math.round((size / 1002) * 96)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT, name), png);
  console.log(`  ${name}  (${png.length.toLocaleString()} bytes, ${size}×${size})`);
}

// ICO: pack multiple PNG sizes
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoEntries = await Promise.all(
  icoSizes.map(async (s) => ({
    size: s,
    png: await sharp(svgBuffer, { density: Math.max(72, Math.round((s / 1002) * 96)) })
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  })),
);
const icoBuf = buildIco(icoEntries);
await writeFile(join(OUT, 'icon.ico'), icoBuf);
console.log(`  icon.ico   (${icoBuf.length.toLocaleString()} bytes)`);

console.log('\nDone.');

function buildIco(entries) {
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
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(e.png.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    blobs.push(e.png);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}
