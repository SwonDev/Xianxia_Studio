import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000, // per-test default; long-running specs override via test.setTimeout()
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Long-running E2E tests stall when Chromium throttles background tabs.
        // Disable backgrounding/timer throttling so fetch() stays alive across
        // multi-minute pipeline phases (Z-Image generation, TTS, Whisper, etc.).
        launchOptions: {
          args: [
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--disable-features=CalculateNativeWinOcclusion',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @xianxia/desktop dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
