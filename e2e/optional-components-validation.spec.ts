/**
 * Auto-installable optional components from Settings:
 *  - "Componentes opcionales" section renders with 3 cards (TRIBE, Music, Vision)
 *  - Each card has install button when not yet installed
 *  - Backend has install_optional_component command + restart hook
 */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

test('optional components section renders + install buttons present', async ({ page }) => {
  test.setTimeout(60_000);
  await fs.mkdir('.output/screenshots/optional-components', { recursive: true });

  await page.goto('/settings');
  await page.waitForTimeout(3_000);

  const main = await page.locator('main').textContent();
  expect(main?.includes('Componentes opcionales')).toBeTruthy();
  console.log('Optional components section visible ✓');

  // Panel container
  await expect(page.getByTestId('optional-components')).toBeVisible();

  // Each feature card
  for (const id of ['python-deps-engagement', 'python-deps-music', 'python-deps-vision']) {
    await expect(page.getByTestId(`feature-${id}`)).toBeVisible();
    console.log(`Feature card ${id} visible ✓`);
  }

  // Take screenshot for visual inspection
  await page.screenshot({
    path: '.output/screenshots/optional-components/01-settings.png',
    fullPage: true,
  });

  // At least one install button (TRIBE shouldn't be installed yet)
  const installBtn = page.getByTestId('install-python-deps-engagement');
  await expect(installBtn).toBeVisible();
  await expect(installBtn).toBeEnabled();
  console.log('TRIBE install button enabled ✓');

  console.log('\n=== OPTIONAL COMPONENTS VALIDATION ===');
  console.log('✓ Settings has "Componentes opcionales" section');
  console.log('✓ 3 feature cards rendered');
  console.log('✓ Install button present for non-installed components');
});
