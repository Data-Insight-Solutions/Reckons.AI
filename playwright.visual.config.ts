import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression config — runs against the Storybook dev server.
 * Start Storybook first: npm run storybook
 *
 * Usage:
 *   npm run storybook &    # start Storybook on :6006
 *   npm run test:visual    # run visual + AI analysis tests
 */
export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.test.ts',
  timeout: 30_000,
  fullyParallel: true,

  use: {
    baseURL: 'http://localhost:6006',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run storybook',
    url: 'http://localhost:6006',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
