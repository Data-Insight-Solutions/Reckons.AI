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
  // navigation-sweep is a 5-device × 5-destination matrix — heavy; it has its own
  // runner (npm run test:workflows via playwright.workflows.config.ts).
  testIgnore: [
    '**/vision-scoring.test.ts',
    '**/vision-vlm.test.ts',
    '**/navigation-sweep.test.ts',
  ],
  timeout: 60_000,
  // SERIAL, FOR THE SAME REASON playwright.config.ts IS — "to avoid origin conflicts". These
  // tests all drive one app on one localhost origin, so parallel workers share IndexedDB and
  // localStorage and stomp each other's fixtures. Symptom: a DIFFERENT pair of tests fails on
  // each run (sheet + preview-collage, then sheet + stories), which reads as product flakiness
  // and is really the harness. The user-stories project below already set fullyParallel:false
  // for its own files; this is that lesson applied to the whole config rather than one corner.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,

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
        ...(process.env.VISUAL_SKIP_STORYBOOK ? ['**/sheet.test.ts', '**/stories.test.ts'] : []),
        '**/mobile/**',
        '**/user-stories/**',
        // evidence/ has its own config (playwright.evidence.config.ts) which sets the baseURL
        // its helpers require; run it with `npm run visual:review`. Without this line the
        // recursive glob pulls those tests in here, where baseURL is undefined and they fail
        // with "Visual evidence requires a string baseURL" — a config miss that reads as a
        // product failure.
        '**/evidence/**',
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

  // STORYBOOK IS OPT-OUT, AND THE DIAGNOSIS IS INCOMPLETE — SAYING SO IS THE POINT. Two files
  // here (sheet.test.ts, stories.test.ts, 14 tests between them) drive Storybook on :6006 rather
  // than the app. Locally that server is usually already up and reuseExistingServer:true finds
  // it; on a clean CI runner one of these webServers exits 1 within four seconds and Playwright
  // does not surface its stderr, so WHICH one and WHY are both unverified from here. What is
  // measured: `storybook dev` had printed nothing past its banner after 90 seconds on this
  // machine, against a 120s start timeout — slow enough that a cold runner is plausibly the
  // problem, and not proof that it is.
  //
  // So VISUAL_SKIP_STORYBOOK=1 drops the server and those two files, and the remaining 23 tests
  // gate every push instead of none of them. Trading 14 tests for 23 running is the honest
  // trade; claiming the suite is covered would not be.
  webServer: [
    ...(process.env.VISUAL_SKIP_STORYBOOK ? [] : [{
      command: 'npm run storybook',
      url: 'http://localhost:6006',
      reuseExistingServer: true,
      timeout: 120_000,
    }]),
    {
      command: 'npm run dev:test',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60_000,
      env: sharedEnv,
    },
  ],
});
