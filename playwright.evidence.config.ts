import { defineConfig, devices } from '@playwright/test';

const PORT = 4175;
const pixel7 = devices['Pixel 7'];

export default defineConfig({
  testDir: './tests/visual/evidence',
  testMatch: '**/*.test.ts',
  globalSetup: './tests/visual/evidence/global-setup.ts',
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report-evidence', open: 'never' }],
    ['list'],
  ],
  snapshotPathTemplate: 'tests/visual/evidence/__screenshots__/{arg}-{projectName}{ext}',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    contextOptions: { ignoreHTTPSErrors: true },
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  projects: [
    {
      name: 'desktop-chrome',
      metadata: { deviceProfile: 'Desktop Chrome' },
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'pixel-7-portrait',
      metadata: { deviceProfile: 'Pixel 7' },
      use: { ...pixel7 },
    },
    {
      name: 'pixel-7-landscape',
      metadata: { deviceProfile: 'Pixel 7' },
      use: {
        ...pixel7,
        viewport: {
          width: pixel7.viewport.height,
          height: pixel7.viewport.width,
        },
        screen: {
          width: pixel7.screen.height,
          height: pixel7.screen.width,
        },
      },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
