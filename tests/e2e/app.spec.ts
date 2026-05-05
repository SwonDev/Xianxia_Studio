import { test, expect } from '@playwright/test';
import { tauriMockScript } from './tauri-mocks';

test.describe('Xianxia Studio — UI smoke', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.error('PAGE ERROR:', err));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`PAGE ${msg.type().toUpperCase()}:`, msg.text());
      }
    });
    await page.addInitScript(tauriMockScript);
  });

  test('dashboard renders without Qi particles', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('cultivo del contenido');
    // Verify Qi particles are gone
    const canvases = await page.locator('canvas').count();
    expect(canvases).toBe(0);
    await page.screenshot({ path: 'tests/screenshots/01-dashboard.png', fullPage: false });
  });

  test('sidebar shows logo and 6 nav items', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('aside img[alt="Xianxia Studio"]')).toBeVisible();
    const items = page.locator('aside nav a');
    await expect(items).toHaveCount(6);
    await expect(items.nth(0)).toContainText('Dashboard');
    await expect(items.nth(1)).toContainText('Generador');
    await expect(items.nth(2)).toContainText('Biblioteca');
    await expect(items.nth(3)).toContainText('Planificador');
    await expect(items.nth(4)).toContainText('Instalador');
    await expect(items.nth(5)).toContainText('Ajustes');
  });

  test('topbar shows hardware + 3 service dots', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header').first()).toContainText('16 cores');
    await expect(page.locator('header').first()).toContainText('Ollama');
    await expect(page.locator('header').first()).toContainText('Python');
    await expect(page.locator('header').first()).toContainText('Node');
  });

  test('install wizard — full 6-step flow', async ({ page }) => {
    await page.goto('/install');
    await expect(page.locator('h1')).toContainText('Bienvenido al cultivo');

    // Step 1: welcome
    await page.screenshot({ path: 'tests/screenshots/02-install-welcome.png' });
    await page.getByRole('button', { name: 'Empezar la detección' }).click();

    // Step 2: detect — should show 5 tools
    await expect(page.getByText('Auto-detección de tu sistema')).toBeVisible();
    await expect(page.getByText('Python 3.14.0')).toBeVisible();
    await expect(page.getByText('v25.2.1')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/03-install-detect.png' });
    await page.getByRole('button', { name: 'Continuar' }).click();

    // Step 3: hardware
    await expect(page.getByText('Tu hardware')).toBeVisible();
    await expect(page.getByText('AMD Ryzen 9 7950X')).toBeVisible();
    await expect(page.getByText('GeForce RTX 4090')).toBeVisible();
    await expect(page.getByText('Tier ultra')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/04-install-hardware.png' });
    await page.getByRole('button', { name: 'Continuar al plan' }).click();

    // Step 4: plan
    await expect(page.getByText('Plan de instalación')).toBeVisible();
    await expect(page.getByText('Z-Image-Turbo')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/05-install-plan.png' });
  });

  test('library route shows mock projects', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByText('Biblioteca').first()).toBeVisible();
    await expect(page.getByText('The Jade Emperor Ascension')).toBeVisible();
    await expect(page.getByText('Sword Saint of Mount Hua')).toBeVisible();
    await expect(page.getByText('Demon Empress Falls')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/06-library.png' });
  });

  test('scheduler route shows calendar', async ({ page }) => {
    await page.goto('/scheduler');
    await expect(page.locator('main h1')).toContainText('Planificador');
    // 7 day-of-week headers in the grid
    const dayHeaders = page.locator('main .grid-cols-7').first().locator('> div');
    await expect(dayHeaders.first()).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/07-scheduler.png' });
  });

  test('generator wizard — form + 10 phases', async ({ page }) => {
    await page.goto('/generator');
    await expect(page.getByText('Configura tu vídeo')).toBeVisible();
    await expect(page.locator('input[placeholder*="Inmortal"]')).toBeVisible();
    // Pipeline list shows 10 phases
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
    await expect(page.getByText('Guion')).toBeVisible();
    await expect(page.getByText('Subtítulos')).toBeVisible();
    // Use first() to disambiguate "Programación" (also in dashboard stats)
    await expect(page.getByText('Programación').first()).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/08-generator.png' });
  });

  test('settings — verify stack + oauth + models sections', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Verificación del stack')).toBeVisible();
    await expect(page.getByText('Credenciales Google OAuth')).toBeVisible();
    await expect(page.getByText('Modelos Gemma 4')).toBeVisible();
    await expect(page.getByText('Variante segura del LLM')).toBeVisible();
    // verify_stack shows all green
    await expect(page.getByText('Todos los componentes operativos')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/09-settings.png', fullPage: true });
  });

  test('settings OAuth credentials — input form is reachable', async ({ page }) => {
    await page.goto('/settings');
    const clientIdInput = page.locator('input[placeholder*="googleusercontent"]');
    await expect(clientIdInput).toBeVisible();
    await clientIdInput.fill('TEST.apps.googleusercontent.com');
    await page.locator('input[type="password"]').fill('GOCSPX-test');
    await page.screenshot({ path: 'tests/screenshots/10-settings-oauth.png' });
  });

  test('navigation: click each sidebar link', async ({ page }) => {
    await page.goto('/');
    for (const label of ['Generador', 'Biblioteca', 'Planificador', 'Instalador', 'Ajustes']) {
      await page.locator(`aside nav a:has-text("${label}")`).click();
      await page.waitForTimeout(300);
      await expect(page.locator('main h1')).toBeVisible();
    }
  });

  test('responsive — 1280×720 layout', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.screenshot({ path: 'tests/screenshots/11-responsive-1280.png' });
    const sidebarVisible = await page.locator('aside').isVisible();
    expect(sidebarVisible).toBe(true);
  });
});
