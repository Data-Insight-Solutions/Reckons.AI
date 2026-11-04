import { defineConfig, devices } from '@playwright/test';

/**
 * Runs ONE e2e test file against the mock-backend dev server, desktop Chrome only. Used by
 * `npm run workflow:shots` (scripts/workflow-shots.ts), which sets WORKFLOW_CAPTURE_DIR so the test
 * draws its highlight boxes and saves PNGs.
 *
 *   WORKFLOW_BASE_URL   reuse an already-running dev server instead of starting one
 *   CHROME_PATH         use this Chrome binary instead of Playwright's own download (the bundled
 *                       one can be an older build than the installed Playwright expects)
 */
const base = process.env.WORKFLOW_BASE_URL ?? 'http://localhost:5174';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: base, contextOptions: { ignoreHTTPSErrors: true } },
  projects: [{
    name: 'desktop-chrome',
    use: {
      ...devices['Desktop Chrome'],
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
