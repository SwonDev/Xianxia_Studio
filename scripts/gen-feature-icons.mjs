// Generates branded feature icons for the README using the project's
// gold/jade palette + a consistent line-art style.
//
//   pnpm icons:features
//
// Output: assets/promo/icons/<name>.svg
//
// All icons share: 32×32 viewBox, 1.6 stroke-width gold (#c9a961), no fill,
// rounded line caps, optional jade accent (#52b788) for highlights.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'assets', 'promo', 'icons');
await mkdir(OUT, { recursive: true });

const GOLD = '#c9a961';
const GOLD_LIGHT = '#e0c98c';
const JADE = '#52b788';

function svg(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
}

const ICONS = {
  // Long-form & Shorts — film with star burst
  'film': svg(`
    <rect x="4" y="6" width="24" height="20" rx="2"/>
    <path d="M9 6v20M23 6v20"/>
    <path d="M9 11h-5M9 16h-5M9 21h-5M28 11h-5M28 16h-5M28 21h-5"/>
    <path stroke="${JADE}" d="M16 12l1.2 2.8 3 .3-2.3 2 .8 3-2.7-1.5-2.7 1.5.8-3-2.3-2 3-.3z"/>
  `),

  // Smart Shorts — scissors crossing a clip
  'scissors': svg(`
    <circle cx="9" cy="10" r="3"/>
    <circle cx="9" cy="22" r="3"/>
    <path d="M11 12l16 12M11 22L27 8"/>
    <path stroke="${JADE}" d="M22 14l5 4-5 4"/>
  `),

  // Voice cloning — microphone with waves
  'voice': svg(`
    <rect x="13" y="4" width="6" height="14" rx="3"/>
    <path d="M9 14a7 7 0 0 0 14 0M16 21v5"/>
    <path stroke="${JADE}" d="M5 11l-2 1 2 1M27 11l2 1-2 1"/>
  `),

  // Engagement / brain — neural waves
  'brain': svg(`
    <path d="M11 6a4 4 0 0 0-4 4 4 4 0 0 0-2 6 4 4 0 0 0 2 6 4 4 0 0 0 4 4h0a4 4 0 0 0 5-2 4 4 0 0 0 5 2 4 4 0 0 0 4-4 4 4 0 0 0 2-6 4 4 0 0 0-2-6 4 4 0 0 0-4-4 4 4 0 0 0-5 2 4 4 0 0 0-5-2z"/>
    <path stroke="${JADE}" d="M16 8v16M11 13h10M11 19h10"/>
  `),

  // Captions — text underline
  'captions': svg(`
    <rect x="4" y="7" width="24" height="18" rx="2"/>
    <path d="M9 14h14M9 18h10"/>
    <path stroke="${JADE}" d="M9 22h6"/>
  `),

  // Auto-edit / sparkles — composition stars
  'sparkles': svg(`
    <path d="M12 5l1.6 4.2L18 11l-4.4 1.8L12 17l-1.6-4.2L6 11l4.4-1.8z"/>
    <path stroke="${JADE}" d="M22 18l1 2.5 2.5 1-2.5 1L22 25l-1-2.5L18.5 21.5 21 20.5z"/>
    <path d="M5 22l.6 1.5L7 24l-1.4.5L5 26l-.6-1.5L3 24l1.4-.5z"/>
  `),

  // Export / share — outgoing arrow on screen
  'export': svg(`
    <rect x="4" y="8" width="20" height="14" rx="2"/>
    <path d="M9 26h14"/>
    <path stroke="${JADE}" d="M22 13l5-5M22 8h5v5"/>
  `),

  // Cloud upload
  'upload': svg(`
    <path d="M9 22a5 5 0 0 1-1-9.9 7 7 0 0 1 13.6-1A5 5 0 0 1 23 22"/>
    <path stroke="${JADE}" d="M16 14v10M12 18l4-4 4 4"/>
  `),

  // Refresh / auto-update
  'refresh': svg(`
    <path d="M27 14a11 11 0 0 0-19-5l-3 3"/>
    <path d="M5 6v6h6"/>
    <path stroke="${JADE}" d="M5 18a11 11 0 0 0 19 5l3-3"/>
    <path stroke="${JADE}" d="M27 26v-6h-6"/>
  `),

  // Download
  'download': svg(`
    <path d="M16 4v18M9 15l7 7 7-7"/>
    <path stroke="${JADE}" d="M5 26h22"/>
  `),

  // Coffee (Ko-Fi)
  'coffee': svg(`
    <path d="M5 11h18v8a6 6 0 0 1-6 6h-6a6 6 0 0 1-6-6z"/>
    <path d="M23 13h2a3 3 0 0 1 0 6h-2"/>
    <path stroke="${JADE}" d="M10 6c-1 1.5 0 3 1 4M16 6c-1 1.5 0 3 1 4"/>
  `),

  // Bug report
  'bug': svg(`
    <path d="M11 14a5 5 0 0 1 10 0v5a5 5 0 0 1-10 0z"/>
    <path d="M11 14h-3M21 14h3M11 19h-3M21 19h3M11 24h-3M21 24h3"/>
    <path stroke="${JADE}" d="M13 9V6M19 9V6M16 9V4"/>
  `),
};

for (const [name, content] of Object.entries(ICONS)) {
  await writeFile(join(OUT, `${name}.svg`), content.replace(/\n\s+/g, '\n  '));
  console.log(`  ${name}.svg`);
}

console.log('\nFeature icons ready.');
