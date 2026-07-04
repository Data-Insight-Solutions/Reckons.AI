import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for Reckons.AI.
 *
 * Tests run against the Vite dev server with mock LLM backends enabled via
 * environment variables — no real API keys or model downloads needed.
 *
 * Commands:
 *   npm run test:e2e                 — desktop Chrome only (fast, default)
 *   npm run test:e2e:devices         — all device profiles (slower)
 *   npm run test:e2e:ui              — interactive UI mode
 *   npm run test:e2e:headed          — visible browser window
 *
 * Device projects:
 *   --project=desktop-chrome         Desktop 1280×720 (Chromium)
 *   --project=desktop-firefox        Desktop 1280×720 (Firefox/Gecko)
 *   --project=desktop-safari         Desktop 1280×800 (WebKit)
 *   --project=mobile-android         Pixel 7, 412×915, touch (Chromium)
 *   --project=mobile-ios             iPhone 15, 393×852, touch (WebKit)
 *   --project=tablet                 iPad Pro 11", 834×1194, touch (WebKit)
 *
 * Feature availability by engine:
 *   File System Access API  — Chromium only (Chrome/Edge 86+). Tests that
 *     require it are tagged @chromium-only and skipped on other projects.
 *   IndexedDB / WASM        — All engines.
 *   Web Audio               — All engines.
 *   Touch events            — Emulated on mobile/tablet projects automatically.
 */

const sharedEnv = {
  VITE_PREFERRED_BACKEND: 'mock',
  VITE_INGEST_BACKEND: 'mock',
  VITE_CHAT_BACKEND: 'mock',
};

export default defineConfig({
  testDir: './tests/e2e',
  // graph-render.test.ts is a deploy-gate smoke test that must run against a
  // MINIFIED PRODUCTION BUILD (vite build + vite preview) — the black-graph
  // bug it guards against never reproduced under `vite dev`. It has its own
  // config/runner: see playwright.smoke.config.ts and `npm run test:e2e:smoke`.
  testIgnore: '**/graph-render.test.ts',
  // Each project gets its own browser context — IndexedDB is isolated per-project.
  // Within a project tests still run serially (workers:1) to avoid origin conflicts.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    contextOptions: { ignoreHTTPSErrors: true },
  },
  projects: [
    // ── Desktop ────────────────────────────────────────────────────────────────
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    {
      name: 'desktop-firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'desktop-safari',
      use: { ...devices['Desktop Safari'] },
    },

    // ── Mobile ─────────────────────────────────────────────────────────────────
    {
      // Android Chrome — Pixel 7, 412×915, devicePixelRatio 2.6, touch
      name: 'mobile-android',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    {
      // iOS Safari — iPhone 15, 393×852, devicePixelRatio 3, touch
      name: 'mobile-ios',
      use: { ...devices['iPhone 15'] },
    },

    // ── Tablet ─────────────────────────────────────────────────────────────────
    {
      // iPad Pro 11-inch, 834×1194, devicePixelRatio 2, touch
      name: 'tablet',
      use: { ...devices['iPad Pro 11'] },
    },
  ],
  webServer: {
    command: 'npm run dev:test',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: sharedEnv,
  },
});
