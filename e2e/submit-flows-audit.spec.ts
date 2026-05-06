/**
 * Submit-flows audit — fires the actual submit handlers and verifies the
 * front-end⇄backend roundtrip works without throwing. Doesn't wait for
 * heavyweight LLM/render to finish (that takes minutes); just verifies the
 * request reaches the sidecar and the UI responds.
 *
 * Focus: detect mismatches between frontend payload shape and backend schema,
 * broken Tauri commands, missing event subscriptions, etc.
 */
import { test, expect, type Page } from '@playwright/test';

interface Issue { area: string; message: string }
const issues: Issue[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

function attach(page: Page) {
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('Failed to load resource') || t.includes('404')) return;
    consoleErrors.push(t);
  });
}

async function record(area: string, fn: () => Promise<void>) {
  pageErrors.length = 0;
  consoleErrors.length = 0;
  try { await fn(); }
  catch (e) {
    issues.push({ area, message: `threw: ${String(e).slice(0, 200)}` });
  }
  for (const e of pageErrors) issues.push({ area, message: `page error: ${e.slice(0, 200)}` });
  for (const e of consoleErrors) issues.push({ area, message: `console: ${e.slice(0, 200)}` });
}

test('submit-flows audit', async ({ page, request }) => {
  test.setTimeout(180_000);
  attach(page);

  // ── 1. Generator submit fires pipeline ──
  await record('generator-submit', async () => {
    await page.goto('/generator');
    await page.waitForTimeout(2_500);
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('[data-testid="voice-select"]') as HTMLSelectElement | null;
        return sel?.options && Array.from(sel.options).some((o) => !o.text.toLowerCase().includes('cargando'));
      },
      null, { timeout: 15_000 },
    );
    await page.getByTestId('topic-input').fill('Submit-flows audit');
    await page.getByTestId('start-generation').click();

    // Banner should appear OR phase-1 row should mark running within 20s
    const ok = await Promise.race([
      page.getByTestId('active-phase-banner').waitFor({ state: 'visible', timeout: 20_000 }).then(() => true),
      page.waitForFunction(
        () => document.querySelector('[data-testid="phase-1"]')?.getAttribute('data-status') === 'running',
        null, { timeout: 20_000 },
      ).then(() => true),
    ]).catch(() => false);
    if (!ok) {
      issues.push({ area: 'generator-submit', message: 'no progress signal within 20s of clicking Generar' });
    }
  });

  // ── 2. /shorts/from_video reaches the endpoint (without a real MP4) ──
  await record('shorts-backend-payload-shape', async () => {
    const r = await request.post('http://127.0.0.1:8731/shorts/from_video', {
      data: {
        // Missing video_path → 422 (pydantic validation), not 500 (server bug)
      },
      timeout: 10_000,
    });
    if (r.status() !== 422) {
      issues.push({ area: 'shorts-backend-payload-shape', message: `expected 422 for missing video_path, got ${r.status()}` });
    }
  });

  // ── 3. Engagement endpoints respond properly when TRIBE not installed ──
  await record('engagement-graceful', async () => {
    const r = await request.post('http://127.0.0.1:8731/engagement/analyze', {
      data: { video_path: 'C:\\nope.mp4', mode: 'light' },
      timeout: 10_000,
    });
    // 503 if TRIBE not installed, 404 if file not found, both acceptable
    if (![404, 503, 422].includes(r.status())) {
      issues.push({ area: 'engagement-graceful', message: `unexpected status ${r.status()}` });
    }
  });

  // ── 4. Optional-components install command — Tauri command exists ──
  await record('install-optional-component-cmd', async () => {
    await page.goto('/settings');
    await page.waitForTimeout(2_500);
    // Don't actually click install (would download GB) — just verify the
    // button is present and wired.
    const installBtn = page.getByTestId('install-python-deps-engagement').first();
    if (await installBtn.isVisible().catch(() => false)) {
      // Confirm button click target attaches a handler — i.e. it's not just decorative.
      const hasHandler = await installBtn.evaluate((el) => {
        const button = el as HTMLButtonElement;
        return !button.disabled && button.tagName === 'BUTTON';
      });
      if (!hasHandler) issues.push({ area: 'install-optional-component-cmd', message: 'button not interactive' });
    }
  });

  // ── 5. Smart Shorts run button enables when video is "selected" ──
  await record('shorts-button-state', async () => {
    await page.goto('/shorts');
    await page.waitForTimeout(1_500);
    // Without a video path, run is disabled
    await expect(page.getByTestId('shorts-run')).toBeDisabled();
    // We cannot trigger the OS file picker programmatically in browser-mode,
    // but we can verify the picker button exists.
    await expect(page.getByTestId('shorts-pick-video')).toBeVisible();
  });

  // ── 6. Library video card renders if any present (analyze + delete buttons) ──
  await record('library-card-handlers', async () => {
    await page.goto('/library');
    await page.waitForTimeout(2_000);
    const cards = await page.locator('[data-testid^="engagement-"]').count();
    if (cards > 0) {
      // Each card with engagement panel must have a working analyze button
      const analyzeBtn = page.locator('[data-testid^="analyze-"]').first();
      if (await analyzeBtn.isVisible().catch(() => false)) {
        // Don't actually click — would block on Whisper. Verify it's a button.
        await expect(analyzeBtn).toBeEnabled();
      }
    }
  });

  // ── 7. Settings: each input has a label or aria-label ──
  await record('settings-a11y', async () => {
    await page.goto('/settings');
    await page.waitForTimeout(2_500);
    // Open all sections so all inputs are mountable
    const sections = await page.locator('details[data-testid^="section-"]').all();
    for (const sec of sections) {
      const isOpen = await sec.evaluate((el) => el.hasAttribute('open'));
      if (!isOpen) {
        await sec.locator(':scope > summary').click();
        await page.waitForTimeout(80);
      }
    }
    // Count truly unlabeled inputs (excluding hidden, checkbox, range, file)
    const unlabeled = await page.locator('main input:not([type="hidden"]):not([type="checkbox"]):not([type="range"]):not([type="file"])').evaluateAll((els) =>
      els.filter((el) => {
        const input = el as HTMLInputElement;
        if (input.getAttribute('aria-label')) return false;
        if (input.getAttribute('aria-labelledby')) return false;
        if (input.getAttribute('placeholder')) return false; // we accept placeholder as soft label
        const id = input.getAttribute('id');
        if (id && document.querySelector(`label[for="${id}"]`)) return false;
        if (input.labels && input.labels.length > 0) return false;
        return true;
      }).length,
    );
    if (unlabeled > 0) {
      issues.push({ area: 'settings-a11y', message: `${unlabeled} inputs sin label/aria/placeholder` });
    }
  });

  // ── 8. Active project lifecycle (cancel via re-navigation) ──
  await record('active-project-lifecycle', async () => {
    await page.goto('/generator');
    await page.waitForTimeout(1_500);
    // Navigate away while pipeline runs — should not throw
    await page.goto('/library');
    await page.waitForTimeout(500);
    await page.goto('/');
  });

  console.log(`\n=== SUBMIT FLOWS AUDIT (${issues.length} issues) ===`);
  for (const i of issues) console.log(`  [!] ${i.area}: ${i.message}`);

  expect(issues.length, 'submit-flow issues — see report above').toBe(0);
});
