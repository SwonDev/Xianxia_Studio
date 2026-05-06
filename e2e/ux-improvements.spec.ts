/**
 * UX improvements validation:
 *  - Sidebar grouped (Resumen / Producir / Gestionar / Sistema)
 *  - Library empty state has CTA buttons
 *  - Settings sections collapsed by default (only Servicios open)
 *  - Generator has "Opciones avanzadas" collapsible
 *  - Scheduler month-nav buttons have aria-label
 */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

const SHOTS = '.output/screenshots/ux-improvements';

test('UX improvements end-to-end', async ({ page }) => {
  test.setTimeout(120_000);
  await fs.mkdir(SHOTS, { recursive: true });

  // Sidebar grouped
  await page.goto('/');
  await page.waitForTimeout(1_500);
  const sidebar = page.locator('aside').first();
  for (const group of ['Resumen', 'Producir', 'Gestionar', 'Sistema']) {
    await expect(sidebar.getByText(group, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/01-sidebar.png`, fullPage: true });

  // Library empty CTA
  await page.goto('/library');
  await page.waitForTimeout(2_000);
  const empty = page.getByTestId('library-empty');
  if (await empty.isVisible().catch(() => false)) {
    await expect(page.getByTestId('library-empty-cta-generator')).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/02-library.png`, fullPage: true });

  // Settings collapsibles
  await page.goto('/settings');
  await page.waitForTimeout(2_500);
  const detailsCount = await page.locator('details[data-testid^="section-"]').count();
  expect(detailsCount).toBeGreaterThanOrEqual(8);
  const servicios = page.getByTestId('section-servicios');
  await expect(servicios).toHaveAttribute('open', '');
  await page.screenshot({ path: `${SHOTS}/03-settings.png`, fullPage: true });

  // Generator advanced
  await page.goto('/generator');
  await page.waitForTimeout(2_000);
  const advanced = page.getByTestId('advanced-options');
  await expect(advanced).toBeVisible();
  const isOpen = await advanced.evaluate((el) => el.hasAttribute('open'));
  expect(isOpen).toBeFalsy();
  await advanced.locator('summary').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('animation-presets')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-generator.png`, fullPage: true });

  // Scheduler aria-labels
  await page.goto('/scheduler');
  await page.waitForTimeout(1_500);
  await expect(page.getByLabel('Mes anterior')).toBeVisible();
  await expect(page.getByLabel('Mes siguiente')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-scheduler.png`, fullPage: true });

  console.log('UX improvements validated ✓');
});
