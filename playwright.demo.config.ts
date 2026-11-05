import { defineConfig, devices } from '@playwright/test';

/**
 * F275.3 — records ONE test workflow as a demo video (1280x720 layout at 1.5x = 1920x1080 frames), desktop Chrome, mock backends.
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
// The page is laid out at 1280x720 CSS pixels and drawn at 1.5x, so the recording is a sharp 1920x1080
// with text at a readable size. Laying it out at 1920x1080 made text small in the video AND hit a bug:
// clicking a search result at that width re-navigated to /? and never finished (2026-11-05).
const viewport = { width: 1280, height: 720 };
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
      viewport,
      deviceScaleFactor: 1.5,
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
