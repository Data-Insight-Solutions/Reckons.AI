import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Shelly's consent ("Shelly answers by sending the relevant parts of your graph to a language
 * model" with Allow / Not now) must wait until the person reaches for something that needs a model.
 * MATT, 2026-10-13, same principle as the model download: the Getting started tour opens Shelly
 * for the person, and that must not itself put a question on screen.
 */

const CONSENT = '.ai-consent';

async function loadStarter(page: Page) {
  await page.goto('/');
  const gs = page.getByRole('button', { name: /getting started/i }).first();
  await expect(gs).toBeVisible({ timeout: 15_000 });
  await gs.click();
  await expect(page.locator('[data-graph-renderer][data-graph-ready="true"]')).toBeVisible({ timeout: 20_000 });
}

/** Point chat at a real (non-mock) provider so a consent is actually required. The e2e server runs with the mock backend. */
async function useRealChatProvider(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kbase');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('settings', 'readwrite');
          const store = tx.objectStore('settings');
          const get = store.get('main');
          get.onsuccess = () => {
            store.put({ ...(get.result ?? { key: 'main' }), key: 'main', chatBackend: 'openai', openaiApiKey: 'sk-test-not-real' });
          };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('first run: the tour opens Shelly with no consent question, on / and on /review', async ({ page }) => {
  await useRealChatProvider(page);
  await page.reload();
  await loadStarter(page);
  await expect(page.getByRole('button', { name: /next stop/i })).toBeVisible({ timeout: 10_000 }); // Shelly is open
  await page.waitForTimeout(1500);
  await expect(page.locator(CONSENT)).toHaveCount(0);
  await expect(page.getByText(/sending the relevant parts of your graph/i)).toHaveCount(0);

  await page.locator('nav').getByRole('link', { name: /review/i }).click();
  await page.waitForURL((u) => u.pathname === '/review');
  await page.waitForTimeout(1500);
  await expect(page.locator(CONSENT)).toHaveCount(0);
});

test('asking Shelly for a model answer raises the consent, and nothing is sent before it', async ({ page }) => {
  await useRealChatProvider(page);
  await page.reload();
  const sent: string[] = [];
  page.on('request', (r) => { if (/api\.openai\.com/.test(r.url())) sent.push(r.url()); });
  await loadStarter(page);
  await page.waitForTimeout(1500);
  await expect(page.locator(CONSENT)).toHaveCount(0);

  // The person reaches for the model: the tour's "next stop" needs one.
  await page.getByRole('button', { name: /next stop/i }).click();
  await expect(page.locator(CONSENT)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(CONSENT).getByRole('button', { name: /^allow$/i })).toBeVisible();
  expect(sent, 'no model request may leave before the person allows it').toEqual([]);
});
