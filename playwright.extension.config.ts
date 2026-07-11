import { defineConfig } from '@playwright/test';

/**
 * Browser-extension visual tests. MV3 extensions can't load in Playwright's
 * default headless mode, so these run headed against a persistent context (see
 * tests/extension/extension-visual.spec.ts). Requires a display (DISPLAY set)
 * and a built extension in dist/extension (`npm run build:extension`).
 *
 * Browser: defaults to Playwright's bundled Chromium. Set EXT_CHANNEL to use a
 * locally-installed browser instead — e.g. EXT_CHANNEL=chrome or msedge.
 */
export default defineConfig({
  testDir: './tests/extension',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
