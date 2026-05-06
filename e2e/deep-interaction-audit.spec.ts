/**
 * Deep interaction audit — exercises every page with REAL user actions
 * (clicks, form fills, navigation, expand/collapse) instead of just visiting
 * and capturing. Detects:
 *  - Broken handlers (handler errors emit to console as PAGE ERROR)
 *  - Routes that fail to mount their view
 *  - Backend endpoints that return 404/5xx for documented contracts
 *  - Tauri commands that throw "missing handler" or InputValidationError
 *  - Console errors specific to interactive flows (not just initial render)
 *
 * Output: a structured JSON of issues per route. Test fails on any error
 * in real user paths so we know the regression surface.
 */
import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';

const REPORT = '.output/screenshots/deep-audit';

interface Finding {
  area: string;
  severity: 'error' | 'warning';
  message: string;
}

const findings: Finding[] = [];
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function attachLogging(page: Page) {
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => pageErrors.push(`${e.message}`));
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() !== 'error') return;
    if (
      t.includes('404 (Not Found)') ||
      t.includes('Failed to load resource')
    ) return;
    consoleErrors.push(t);
  });
}

async function record(area: string, fn: () => Promise<void>) {
  pageErrors.length = 0;
  consoleErrors.length = 0;
  try { await fn(); } catch (e) {
    findings.push({ area, severity: 'error', message: `interaction threw: ${String(e).slice(0, 200)}` });
  }
  for (const e of pageErrors) findings.push({ area, severity: 'error', message: `page error: ${e.slice(0, 200)}` });
  for (const e of consoleErrors) findings.push({ area, severity: 'warning', message: `console: ${e.slice(0, 200)}` });
}

test('deep interaction audit', async ({ page, request }) => {
  test.setTimeout(240_000);
  await fs.mkdir(REPORT, { recursive: true });
  attachLogging(page);

  // ── 0. OpenAPI inventory: every route the sidecar exposes must be reachable ──
  await record('openapi', async () => {
    const r = await request.get('http://127.0.0.1:8731/openapi.json');
    expect(r.status()).toBe(200);
    const oa = await r.json();
    const paths = Object.keys(oa.paths ?? {});
    if (paths.length < 25) {
      findings.push({ area: 'openapi', severity: 'warning', message: `only ${paths.length} routes registered (expected 25+)` });
    }
    // All required-by-pipeline endpoints
    const required = [
      '/script', '/script/metadata', '/script/suggest', '/script/hooks',
      '/tts', '/tts/voices', '/tts/clones',
      '/image', '/music', '/music/backends',
      '/render', '/subtitles', '/subtitles/burn-in',
      '/shorts/auto', '/shorts/from_video',
      '/depth', '/reframe',
      '/transcribe',
      '/unload',
      '/export', '/export/presets',
      '/engagement/analyze', '/engagement/optimize', '/engagement/backend',
    ];
    for (const r of required) {
      if (!paths.includes(r)) {
        findings.push({ area: 'openapi', severity: 'error', message: `missing route: ${r}` });
      }
    }
  });

  // ── 1. Dashboard — links should navigate ──
  await record('dashboard', async () => {
    await page.goto('/');
    await page.waitForTimeout(2_000);
    // The "¿Listo para crear?" CTA card is the main action
    const ctaText = await page.locator('main').textContent();
    if (!ctaText?.includes('Generador') && !ctaText?.includes('crear')) {
      findings.push({ area: 'dashboard', severity: 'warning', message: 'no clear CTA visible' });
    }
  });

  // ── 2. Generator — fill the entire form, expand advanced, all toggles ──
  await record('generator', async () => {
    await page.goto('/generator');
    await page.waitForTimeout(2_500);
    // Voice select must populate
    const voiceSelect = page.getByTestId('voice-select');
    await expect(voiceSelect).toBeVisible();
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('[data-testid="voice-select"]') as HTMLSelectElement | null;
        return sel?.options && Array.from(sel.options).some((o) => !o.text.toLowerCase().includes('cargando'));
      },
      null, { timeout: 15_000 },
    );
    // Fill topic
    await page.getByTestId('topic-input').fill('Testing the deep audit');
    // Toggle vertical
    await page.getByTestId('aspect-vertical').click();
    await page.waitForTimeout(200);
    await page.getByTestId('aspect-horizontal').click();
    // Toggle each language
    for (const lang of ['en', 'es', 'zh']) {
      const btn = page.getByTestId(`lang-${lang}`);
      await btn.click(); await page.waitForTimeout(100);
      await btn.click(); await page.waitForTimeout(100);
    }
    // Open advanced section
    const advanced = page.getByTestId('advanced-options');
    await advanced.locator('summary').click();
    await page.waitForTimeout(300);
    // Click each animation preset
    for (const id of ['cinematic', 'dynamic', 'minimal', 'dramatic']) {
      await page.getByTestId(`anim-${id}`).click();
      await page.waitForTimeout(80);
    }
    // Click each caption style
    for (const id of ['xianxia', 'hormozi', 'mrbeast', 'minimal', 'neon']) {
      await page.getByTestId(`cap-${id}`).click();
      await page.waitForTimeout(80);
    }
    // Topic suggest should not throw
    const suggest = page.getByTestId('suggest-topics');
    if (await suggest.isVisible().catch(() => false)) {
      // Don't actually trigger — LLM call is slow
    }
    // Start button should be enabled
    const start = page.getByTestId('start-generation');
    await expect(start).toBeEnabled();
    await page.screenshot({ path: `${REPORT}/generator-filled.png`, fullPage: true });
  });

  // ── 3. Library — empty CTA + folder open command ──
  await record('library', async () => {
    await page.goto('/library');
    await page.waitForTimeout(2_500);
    // If empty, both CTA buttons present
    const empty = page.getByTestId('library-empty');
    if (await empty.isVisible().catch(() => false)) {
      await expect(page.getByTestId('library-empty-cta-generator')).toBeVisible();
    }
    // Open folder button always present in header
    const openFolder = page.getByTestId('library-open-folder');
    await expect(openFolder).toBeVisible();
    // Don't actually click — it would launch explorer.exe and break test isolation
  });

  // ── 4. Smart Shorts — all caption styles + sliders + button gating ──
  await record('shorts', async () => {
    await page.goto('/shorts');
    await page.waitForTimeout(2_000);
    for (const id of ['hormozi', 'mrbeast', 'xianxia', 'minimal', 'neon']) {
      await page.getByTestId(`caption-style-${id}`).click();
      await page.waitForTimeout(50);
    }
    // Sliders work
    const count = page.getByTestId('shorts-count');
    await count.fill('5');
    const dur = page.getByTestId('shorts-duration');
    await dur.fill('30');
    // Run button gated until video picked
    await expect(page.getByTestId('shorts-run')).toBeDisabled();
  });

  // ── 5. Scheduler — arrows + today button ──
  await record('scheduler', async () => {
    await page.goto('/scheduler');
    await page.waitForTimeout(1_500);
    const prev = page.getByLabel('Mes anterior');
    const next = page.getByLabel('Mes siguiente');
    await prev.click(); await page.waitForTimeout(150);
    await next.click(); await page.waitForTimeout(150);
    await next.click(); await page.waitForTimeout(150);
    // Hoy button
    await page.getByText('Hoy', { exact: true }).click();
    await page.waitForTimeout(150);
  });

  // ── 6. Settings — open every collapsed section, verify content renders ──
  await record('settings', async () => {
    await page.goto('/settings');
    await page.waitForTimeout(2_500);
    const sections = await page.locator('details[data-testid^="section-"]').all();
    for (const sec of sections) {
      const isOpen = await sec.evaluate((el) => el.hasAttribute('open'));
      if (!isOpen) {
        // Click the direct child summary only — some panels embed nested
        // <details> (e.g. OAuth FAQ) and a generic .locator('summary') would
        // match multiple, breaking strict-mode.
        await sec.locator(':scope > summary').click();
        await page.waitForTimeout(80);
        const opened = await sec.evaluate((el) => el.hasAttribute('open'));
        if (!opened) {
          const id = await sec.getAttribute('data-testid');
          findings.push({ area: 'settings', severity: 'warning', message: `section ${id} did not open after click` });
        }
      }
    }
    await page.screenshot({ path: `${REPORT}/settings-all-open.png`, fullPage: true });
    // Optional components feature cards
    for (const id of ['python-deps-engagement', 'python-deps-music', 'python-deps-vision']) {
      await expect(page.getByTestId(`feature-${id}`)).toBeVisible();
    }
    // Voice clones panel — pick + submit gated
    const cloneSubmit = page.getByTestId('clone-submit');
    if (await cloneSubmit.isVisible().catch(() => false)) {
      await expect(cloneSubmit).toBeDisabled();
    }
  });

  // ── 7. Install — wizard renders ──
  await record('install', async () => {
    await page.goto('/install');
    await page.waitForTimeout(2_500);
    const txt = await page.locator('main').textContent();
    if (!txt?.includes('instala') && !txt?.includes('Instala') && !txt?.includes('Bienvenido')) {
      findings.push({ area: 'install', severity: 'warning', message: 'install wizard text missing' });
    }
  });

  // ── 8. Cross-route: navigate via sidebar links ──
  await record('navigation', async () => {
    await page.goto('/');
    const sidebarRoutes = [
      ['Dashboard', '/'],
      ['Generador', '/generator'],
      ['Smart Shorts', '/shorts'],
      ['Biblioteca', '/library'],
      ['Planificador', '/scheduler'],
      ['Instalador', '/install'],
      ['Ajustes', '/settings'],
    ];
    for (const [label, expected] of sidebarRoutes) {
      const link = page.locator(`aside a:has-text("${label}")`).first();
      await link.click();
      await page.waitForTimeout(400);
      const url = page.url();
      if (!url.endsWith(expected)) {
        findings.push({ area: 'navigation', severity: 'error', message: `clicking "${label}" went to ${url}, expected ${expected}` });
      }
    }
  });

  // ── 9. Backend smoke: every documented endpoint responds (not 5xx) ──
  await record('backend-smoke', async () => {
    const probes = [
      { url: 'http://127.0.0.1:8731/health', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/tts/voices', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/tts/voices?language=es', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/tts/voices?language=en', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/tts/voices?language=zh', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/tts/clones', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/music/backends', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/export/presets', expectStatus: [200] },
      { url: 'http://127.0.0.1:8731/engagement/backend', expectStatus: [200] },
      { url: 'http://127.0.0.1:8732/health', expectStatus: [200] },
    ];
    for (const p of probes) {
      const r = await request.get(p.url, { timeout: 10_000 });
      if (!p.expectStatus.includes(r.status())) {
        findings.push({ area: 'backend-smoke', severity: 'error', message: `${p.url} → ${r.status()} (expected ${p.expectStatus.join('|')})` });
      }
    }
  });

  // ── Final report ──
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  console.log(`\n=== DEEP AUDIT REPORT (${errors.length} errors, ${warnings.length} warnings) ===\n`);
  for (const f of findings) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.area}: ${f.message}`);
  }
  await fs.writeFile(`${REPORT}/findings.json`, JSON.stringify(findings, null, 2), 'utf-8');

  // Hard-fail on any error severity. Warnings are informational.
  expect(errors.length, `${errors.length} interaction errors found — see report`).toBe(0);
});
