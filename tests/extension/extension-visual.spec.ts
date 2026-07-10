/**
 * Browser-extension visual smoke test.
 *
 * Loads the built MV3 extension (dist/extension) into a headed persistent
 * context, then screenshots the three user-facing surfaces:
 *   - the toolbar popup (popup.html)
 *   - the side panel (sidepanel.html)
 *   - the content-script overlay injected into a normal web page
 *
 * MV3 extensions require a persistent context + a real (non-headless-shell)
 * Chromium and a display. Browser is Playwright's bundled Chromium by default;
 * set EXT_CHANNEL=chrome|msedge|chromium to use a locally-installed browser.
 *
 * Run:  npx playwright test --config=playwright.extension.config.ts
 * Build the extension first: npm run build:extension
 */
import { test as base, chromium, expect, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirnameLocal, '../../dist/extension');
const OUT_DIR = path.resolve(__dirnameLocal, '../visual/screenshots/extension');

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
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

test.beforeAll(() => fs.mkdirSync(OUT_DIR, { recursive: true }));

test('popup renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 'popup.png') });
  // Popup should render non-trivial content, not a blank/error page.
  expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);
});

test('side panel renders', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, 'sidepanel.png') });
  expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);
});

test('content script injects into a page without errors', async ({ context }) => {
  const errors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  // A self-contained data page — no network needed; the <all_urls> content
  // script still runs against it.
  await page.goto('https://example.com/');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT_DIR, 'content-script-page.png') });
  expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
});
