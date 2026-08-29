/**
 * What the Indico panel TELLS THE USER when the browser refuses the request.
 *
 * This is the gap `kb:int-indico` recorded as open: "error surfacing in the ingest UI (the client
 * throws legibly; whether the UI shows it is untested)". It was untested, and it was broken — in
 * two separate ways found on 2026-07-31 against a live Indico 3.x server:
 *
 *   1. Every browser-side refusal reached the user as `TypeError: Failed to fetch`. CSP (request
 *      never sent) and CORS (response discarded) are different problems with fixes in different
 *      places — this app vs the Indico server — and both printed the same four words.
 *   2. The three calendar sub-tabs shared ONE `error` variable, so a Google OAuth failure
 *      ("Missing required parameter client_id") rendered inside the Indico panel and read as an
 *      Indico fault. That misdirection cost real debugging time.
 *
 * These tests drive the real UI, because the unit tests can only prove the client throws the right
 * string — not that anything puts it on screen.
 */
import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/** Configure an Indico server through the real settings UI and return to the ingest panel. */
async function configureIndico(page: import('@playwright/test').Page, serverUrl: string) {
  await page.goto('/settings/integrations');
  const section = page.locator('#s-indico');
  await section.locator('input[type="url"]').fill(serverUrl);
  await section.getByRole('button', { name: /^save$/ }).click();

  // Follow the app's client-side navigation after saving. `page.goto()` starts a full document
  // replacement and could tear down the page while the IndexedDB settings write was still in
  // flight, which made the next page intermittently read an empty Indico URL.
  const addLink = page.locator('nav').getByRole('link', { name: /^add$/i });
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/ingest'),
    addLink.click(),
  ]);
  await page.getByRole('button', { name: /^calendar$/i }).first().click();
  await page.getByRole('button', { name: /^indico$/i }).first().click();
  await expect(page.getByRole('button', { name: /fetch & import events/i })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await waitForApp(page);
  await clearStorage(page);
  await waitForApp(page);
});

test('a refused response is explained as CORS, naming the header and the origin', async ({ page }) => {
  // localhost is inside the app's connect-src, so CSP is NOT the blocker here; aborting the
  // request reproduces exactly what a browser does to a response with no
  // Access-Control-Allow-Origin — the app sees a bare TypeError and nothing else.
  await page.route('**/export/categ/**', (route) => route.abort('failed'));
  await configureIndico(page, 'http://localhost:9999');

  await page.getByRole('button', { name: /fetch & import events/i }).click();

  const err = page.locator('.indico-err');
  await expect(err).toBeVisible({ timeout: 30_000 });
  const text = await err.innerText();

  expect(text).toContain('Access-Control-Allow-Origin');
  expect(text).toContain('http://localhost:9999'); // the server that refused
  expect(text).toContain('indico-verify.ts'); // how to check the API itself is healthy
  // The failure this test exists to prevent: the opaque platform string reaching the user AS the
  // whole message. Quoting it while explaining what it means is the fix, not the bug.
  expect(text.trim()).not.toBe('Failed to fetch');
  expect(text).toMatch(/browser reports only "Failed to fetch"/);
});

test('a CSP block is explained as CSP, not blamed on the server', async ({ page }) => {
  // An origin deliberately absent from connect-src: the browser refuses before sending, so the
  // remedy is to rebuild this app with the origin configured — telling the user to edit their
  // Indico server here would send them to the wrong machine entirely.
  await configureIndico(page, 'https://indico-not-in-csp.example.com');

  await page.getByRole('button', { name: /fetch & import events/i }).click();

  const err = page.locator('.indico-err');
  await expect(err).toBeVisible({ timeout: 30_000 });
  const text = await err.innerText();

  expect(text).toContain('Content-Security-Policy');
  expect(text).toContain('VITE_INDICO_SERVER_URL');
  expect(text).not.toContain('Access-Control-Allow-Origin');
  expect(text).not.toContain('Failed to fetch');
});

test('a Google failure does not render as an Indico failure', async ({ page }) => {
  await configureIndico(page, 'http://localhost:9999');

  // The Indico panel starts clean: the shared-state leak showed a stale error from the Google tab
  // before the user had done anything with Indico at all.
  await expect(page.locator('.indico-err')).toHaveCount(0);
});
