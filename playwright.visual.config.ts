import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression config — runs against both Storybook and the Vite dev server.
 *
 * Tests use layered analysis:
 *  1. Local (pixel + DOM + text) — always runs, free, fast
 *  2. Mistral OCR               — if MISTRAL_API_KEY is set
 *  3. Claude Vision              — if ANTHROPIC_API_KEY is set
 *
 * Usage:
 *   npm run dev:test &           # start Vite on :5174 with mock backends
 *   npm run storybook &          # start Storybook on :6006
 *   npm run test:visual          # run visual + AI analysis tests
 *
 * Bench (separate from tests):
 *   npm run dev:test &
 *   npm run bench:visual         # run visual analysis benchmark
 *   npm run bench:visual:api     # include API tiers in benchmark
 */

const sharedEnv = {
  VITE_PREFERRED_BACKEND: 'mock',
  VITE_INGEST_BACKEND: 'mock',
  VITE_CHAT_BACKEND: 'mock',
};

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.test.ts',
  // vision-scoring / vision-vlm live in tests/visual/ but are vitest unit tests
  // (they use `describe` from vitest, run as part of `npx vitest run`). Playwright
  // must not collect them, or its whole run aborts at collection.
  testIgnore: ['**/vision-scoring.test.ts', '**/vision-vlm.test.ts'],
  timeout: 60_000,
  fullyParallel: true,

  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      testMatch: '*.test.ts', // top-level visual tests only
      // The glob above matches recursively, so explicitly exclude the subdir
      // projects — otherwise mobile/ tests run under a desktop viewport (false
      // failures) and user-stories/ run twice. A project-level testIgnore
      // overrides the top-level one, so re-list the vitest files here too.
      testIgnore: [
        '**/mobile/**',
        '**/user-stories/**',
        '**/vision-scoring.test.ts',
        '**/vision-vlm.test.ts',
      ],
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    {
      name: 'mobile',
      testDir: './tests/visual/mobile',
      testMatch: '*.test.ts',
      timeout: 90_000,
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    {
      name: 'user-stories',
      testDir: './tests/visual/user-stories',
      testMatch: '*.test.ts',
      timeout: 120_000,
      fullyParallel: false, // stories are sequential within each file
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
  ],

  webServer: [
    {
      command: 'npm run storybook',
      url: 'http://localhost:6006',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:test',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60_000,
      env: sharedEnv,
    },
  ],
});
