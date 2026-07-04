import { defineConfig, devices } from '@playwright/test';

/**
 * Deploy-gate smoke config — runs tests/e2e/graph-render.test.ts against a
 * MINIFIED PRODUCTION BUILD (`vite build` + `vite preview`), never `vite dev`.
 *
 * Why a separate config: the "black graph" production bug (PR #21) only
 * reproduced once Vite/Rollup minified the bundle — Threlte's <T.BufferAttribute>
 * resolved its THREE class via a function-name heuristic that minification
 * mangles. `vite dev` serves unminified code and never exhibited the crash, so
 * the regular `playwright.config.ts` E2E suite (which runs against `vite dev`)
 * cannot catch this class of bug no matter how good its assertions are.
 *
 * Run via `npm run test:e2e:smoke` (builds with the same mock-backend env
 * vars as `dev:test`, then serves the build with `vite preview` and runs this
 * config). Wired into CI as its own job (`.github/workflows/ci.yml`, `smoke`).
 */

const PORT = 4174;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/graph-render.test.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report-smoke', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    contextOptions: { ignoreHTTPSErrors: true },
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
  ],
  webServer: {
    // The build itself happens in the `test:e2e:smoke` npm script (build must
    // complete before this config even loads test files against a stable
    // origin) — this just serves the already-built output.
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
