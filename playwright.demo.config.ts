import { defineConfig, devices } from '@playwright/test';

/**
 * F275.3 — records ONE test workflow as a demo video at 1920x1080, desktop Chrome, mock backends.
 * Run by `npm run demo:render -- --workflow=<id>` (scripts/demo/render.ts), which sets:
 *
 *   DEMO_OUT       where Playwright writes the recording (outside the repository)
 *   DEMO_TIMINGS   per-step holds from the measured narration (read by tests/e2e/demo-recorder.ts)
 *   DEMO_MARKS     where the step marks are written for the mux
 *
 * Optional, as in playwright.workflow-shots.config.ts:
 *   WORKFLOW_BASE_URL   reuse an already-running dev server instead of starting one
 *   CHROME_PATH         use this Chrome binary instead of Playwright's own download
 */
const base = process.env.WORKFLOW_BASE_URL ?? 'http://localhost:5174';
const size = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.DEMO_OUT ?? 'test-results/demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: base,
    contextOptions: { ignoreHTTPSErrors: true },
    video: { mode: 'on', size },
  },
  projects: [{
    name: 'desktop-chrome',
    use: {
      ...devices['Desktop Chrome'],
      viewport: size,
      deviceScaleFactor: 1,
      launchOptions: {
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      },
    },
  }],
  webServer: process.env.WORKFLOW_BASE_URL ? undefined : {
    command: 'npm run dev:test',
    url: base,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
