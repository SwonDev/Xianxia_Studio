/**
 * UX audit: walks every route, captures console errors, layout issues,
 * accessibility hints, and full-page screenshots. Run before each
 * release to catch UX regressions across the app.
 */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

const SHOTS = 'tests/screenshots/ux-audit';

const ROUTES = [
  { path: '/', label: 'dashboard' },
  { path: '/generator', label: 'generator' },
  { path: '/library', label: 'library' },
  { path: '/shorts', label: 'shorts' },
  { path: '/scheduler', label: 'scheduler' },
  { path: '/install', label: 'install' },
  { path: '/settings', label: 'settings' },
];

test('UX deep audit', async ({ page }) => {
  test.setTimeout(180_000);
  await fs.mkdir(SHOTS, { recursive: true });

  const findings: { route: string; issues: string[]; warnings: string[]; metrics: Record<string, number | string> }[] = [];

  for (const r of ROUTES) {
    const issues: string[] = [];
    const warnings: string[] = [];
    const metrics: Record<string, number | string> = {};
    const consoleErrors: string[] = [];

    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    page.on('pageerror', (e) => consoleErrors.push(`PAGE: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (!t.includes('404') && !t.includes('Failed to load resource') && !t.includes('asset')) {
          consoleErrors.push(t);
        }
      }
    });

    const t0 = Date.now();
    await page.goto(r.path);
    await page.waitForTimeout(2_500);
    metrics.load_ms = Date.now() - t0;

    // Capture screenshot
    await page.screenshot({ path: `${SHOTS}/${r.label}.png`, fullPage: true });

    // ── Layout / structure checks ──
    const main = page.locator('main').first();
    const h1Count = await page.locator('h1').count();
    const h2Count = await page.locator('h2').count();
    metrics.h1 = h1Count;
    metrics.h2 = h2Count;
    if (h1Count === 0) issues.push('No <h1> on page (a11y)');
    if (h1Count > 1) warnings.push(`Multiple <h1> (${h1Count}) — should be 1 per page`);

    // Buttons without aria-label or text
    const ghostButtons = await page.locator('button:not([aria-label])').evaluateAll((els) =>
      els.filter((el) => !el.textContent?.trim()).length,
    );
    metrics.ghost_buttons = ghostButtons;
    if (ghostButtons > 0) warnings.push(`${ghostButtons} buttons sin texto + sin aria-label`);

    // Inputs without label
    const unlabeledInputs = await page.locator('input:not([aria-label]):not([type="hidden"]):not([type="checkbox"]):not([type="range"])').evaluateAll((els) =>
      els.filter((el) => {
        const id = el.getAttribute('id');
        if (!id) return !(el as HTMLInputElement).labels?.length;
        return !document.querySelector(`label[for="${id}"]`);
      }).length,
    );
    metrics.unlabeled_inputs = unlabeledInputs;
    if (unlabeledInputs > 2) warnings.push(`${unlabeledInputs} inputs without label`);

    // Empty state quality (when data is empty)
    const mainText = (await main.textContent()) ?? '';
    metrics.text_chars = mainText.length;

    // Loading state present?
    const hasLoadingHint = mainText.toLowerCase().includes('cargando') || mainText.toLowerCase().includes('loading');
    if (hasLoadingHint) warnings.push('Stuck on loading state (or no skeleton)');

    // ── Console errors ──
    metrics.console_errors = consoleErrors.length;
    if (consoleErrors.length > 0) {
      issues.push(...consoleErrors.slice(0, 3).map((e) => `console: ${e.slice(0, 100)}`));
    }

    findings.push({ route: r.path, issues, warnings, metrics });
  }

  console.log('\n=== UX AUDIT REPORT ===\n');
  for (const f of findings) {
    console.log(`▸ ${f.route}`);
    console.log(`  metrics: ${JSON.stringify(f.metrics)}`);
    if (f.issues.length) console.log(`  ❌ ISSUES: ${f.issues.join(' · ')}`);
    if (f.warnings.length) console.log(`  ⚠️  warnings: ${f.warnings.join(' · ')}`);
    if (!f.issues.length && !f.warnings.length) console.log('  ✓ clean');
    console.log('');
  }

  // Persist JSON for follow-up analysis
  await fs.writeFile(
    `${SHOTS}/audit.json`,
    JSON.stringify(findings, null, 2),
    'utf-8',
  );

  // Don't fail — this is informational. We'll address findings programmatically.
  expect(findings.length).toBe(ROUTES.length);
});
