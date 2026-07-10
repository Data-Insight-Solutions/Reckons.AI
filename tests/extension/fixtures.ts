/**
 * Shared Playwright fixture for browser-extension tests: loads the built MV3
 * extension (dist/extension) into a headed persistent context and exposes the
 * extension ID. See playwright.extension.config.ts.
 *
 * Browser is Playwright's bundled Chromium by default; set EXT_CHANNEL=chrome|
 * msedge|chromium to use a locally-installed browser. Needs a display.
 */
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(__dirnameLocal, '../../dist/extension');
export const OUT_DIR = path.resolve(__dirnameLocal, '../visual/screenshots/extension');

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
      throw new Error(`Extension not built at ${EXT_PATH} — run: npm run build:extension`);
    }
    const context = await chromium.launchPersistentContext('', {
      headless: false, // extensions don't load in headless-shell
      channel: process.env.EXT_CHANNEL || undefined, // undefined = bundled Chromium
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    // MV3: the extension ID is the host of its service-worker URL.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
