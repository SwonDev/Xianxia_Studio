/** Full-app audit: walk every route and capture screenshots + look for errors. */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

const SHOTS = 'tests/screenshots/audit';

test('full app walkthrough', async ({ page }) => {
  test.setTimeout(120_000);
  await fs.mkdir(SHOTS, { recursive: true });

  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') errors.push(`[error] ${msg.text()}`);
    if (t === 'warning') warnings.push(`[warn] ${msg.text()}`);
  });

  // Reset shim state
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
  });

  // ── Dashboard ──
  await page.goto('/');
  await page.waitForTimeout(1500); // let queries settle
  await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });
  const dashboardH1 = await page.locator('main h1').first().textContent();
  console.log('Dashboard H1:', dashboardH1);

  // Check topbar dots
  const topbarText = await page.locator('header').first().textContent();
  console.log('Topbar text:', topbarText?.trim());
  const dots = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return [];
    return ['Ollama', 'Python', 'Node'].map((label) => {
      const span = Array.from(header.querySelectorAll('span'))
        .find((el) => el.textContent?.trim() === label);
      const dot = span?.parentElement?.querySelector('span:first-child');
      return { label, jade: dot?.className.includes('jade-400') ?? false };
    });
  });
  console.log('Topbar dots:', JSON.stringify(dots));

  // ── Generador ──
  await page.locator('aside nav a:has-text("Generador")').click();
  await expect(page.getByText('Configura tu vídeo')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/02-generator.png`, fullPage: true });
  const verticalBtn = page.getByTestId('aspect-vertical');
  await expect(verticalBtn).toBeVisible();
  console.log('Vertical toggle present:', await verticalBtn.isVisible());

  // ── Biblioteca ──
  await page.locator('aside nav a:has-text("Biblioteca")').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/03-library.png`, fullPage: true });

  // ── Planificador ──
  await page.locator('aside nav a:has-text("Planificador")').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/04-scheduler.png`, fullPage: true });

  // ── Instalador ──
  await page.locator('aside nav a:has-text("Instalador")').click();
  await expect(page.getByText('¿Qué se va a instalar?')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/05-install-welcome.png`, fullPage: true });

  // Check the welcome bullets — Gemma 4 should NOT say Gemma 3
  const installText = await page.locator('main').textContent();
  const hasGemma3 = installText?.includes('Gemma 3');
  const hasGemma4 = installText?.includes('Gemma 4');
  const hasComfyUI = installText?.includes('ComfyUI');
  const hasHyperFrames = installText?.includes('HyperFrames');
  const hasRembg = installText?.includes('rembg');
  const hasMediaPipe = installText?.includes('MediaPipe');
  console.log('Install welcome — Gemma 3:', hasGemma3, '| Gemma 4:', hasGemma4,
              '| ComfyUI:', hasComfyUI, '| HyperFrames:', hasHyperFrames,
              '| rembg:', hasRembg, '| MediaPipe:', hasMediaPipe);

  // ── Ajustes ──
  await page.locator('aside nav a:has-text("Ajustes")').click();
  await page.waitForTimeout(2_000); // let queries settle (verify_stack is heavy)
  await expect(page.getByText('Verificación del stack')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/06-settings.png`, fullPage: true });

  // Check Settings stack panel for the new component groups
  const settingsText = await page.locator('main').textContent();
  console.log('Settings has groups:',
    'Servicios:', settingsText?.includes('Servicios'),
    '| Modelos:', settingsText?.includes('Modelos'),
    '| Herramientas:', settingsText?.includes('Herramientas'));
  console.log('Settings has tools:',
    'HyperFrames:', settingsText?.includes('HyperFrames'),
    '| rembg:', settingsText?.includes('rembg'),
    '| MediaPipe:', settingsText?.includes('MediaPipe'),
    '| ComfyUI:', settingsText?.includes('ComfyUI'));

  // ── Final report ──
  console.log('\n=== AUDIT REPORT ===');
  console.log(`Errors: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log('  ' + e));
  console.log(`Warnings: ${warnings.length}`);
  warnings.slice(0, 5).forEach((w) => console.log('  ' + w));

  expect(errors.filter((e) => !e.includes('404') && !e.includes('Failed to load resource')).length).toBe(0);
});
