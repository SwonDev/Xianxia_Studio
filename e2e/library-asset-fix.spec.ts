/**
 * Regression: 403 Forbidden on asset.localhost when Library tries to render
 * MP4 posters/videos from data_dir. Cause was Tauri's static `$APPDATA/**`
 * scope expanding to the bundle identifier path, not our ProjectDirs path
 * (`xianxia/XianxiaStudio/data/`). Fix: extended assetProtocol scope in
 * tauri.conf.json to also match `$HOME/AppData/Roaming/xianxia/**`.
 *
 * Also: shell:open regex validation rejected raw Windows paths. Fixed by
 * making `library_open_video_folder` open the OS explorer from Rust directly.
 */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';

test('library renders without 403 asset.localhost errors', async ({ page }) => {
  test.setTimeout(60_000);
  await fs.mkdir('.output/screenshots/library-asset-fix', { recursive: true });

  const consoleErrors: string[] = [];
  const networkFailures: { url: string; status: number }[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('response', (resp) => {
    if (resp.status() === 403 && resp.url().includes('asset')) {
      networkFailures.push({ url: resp.url(), status: 403 });
    }
  });

  await page.goto('/library');
  await page.waitForTimeout(4_000);
  await page.screenshot({
    path: '.output/screenshots/library-asset-fix/01-library.png',
    fullPage: true,
  });

  // No 403 on asset.localhost
  if (networkFailures.length > 0) {
    console.log('Asset 403s found:', networkFailures.slice(0, 3));
  }
  expect(networkFailures.length, '403 Forbidden en asset.localhost').toBe(0);

  // No "scoped command argument" regex errors
  const scopedErrors = consoleErrors.filter((e) =>
    e.toLowerCase().includes('scoped command argument'),
  );
  if (scopedErrors.length > 0) console.log('Scoped errors:', scopedErrors.slice(0, 2));
  expect(scopedErrors.length, 'shell:open regex rejected paths').toBe(0);

  console.log('=== LIBRARY ASSET REGRESSION ===');
  console.log('✓ Zero 403 on asset.localhost');
  console.log('✓ Zero shell:open scoped command errors');
});
