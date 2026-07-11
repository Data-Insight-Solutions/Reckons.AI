import { defineConfig, devices } from '@playwright/test';

/**
 * App-workflow visual tests (F34/F40) — runs the user-story workflows against the
 * mock dev server ONLY. Deliberately no Storybook webServer (unlike
 * playwright.visual.config.ts): workflow tests drive the real app, and coupling
 * them to Storybook meant a slow/broken Storybook blocked the whole run.
 *
 * Device sizing is handled inside the workflows via the harness (useDevice), so
 * a single chromium project is enough here.
 *
 * Run:  npx playwright test --config=playwright.workflows.config.ts
 */
export default defineConfig({
  testDir: './tests/visual/user-stories',
  testMatch: '**/*.test.ts',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev:test',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
