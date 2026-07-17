import { type Page, type BrowserContext, expect } from '@playwright/test';

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

/**
 * Delete all Reckons.AI IndexedDB databases.
 * MUST be called after the page has navigated to the app's origin
 * (IndexedDB is origin-scoped and unavailable on about:blank).
 *
 * Navigates to "/" first if needed, then wipes storage and reloads.
 */
export async function clearStorage(page: Page): Promise<void> {
  // Navigate to the app origin so we have IndexedDB access
  if (!page.url().startsWith('http://localhost')) {
    await page.goto('/');
  }
  await page.evaluate(async () => {
    // Delete by known name (plus any versioned variants)
    const toDelete = ['kbase'];
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name && (db.name.startsWith('kbase') || db.name.startsWith('reckons'))) {
          toDelete.push(db.name);
        }
      }
    } catch { /* indexedDB.databases() may not exist on all browsers */ }

    await Promise.all([...new Set(toDelete)].map(name =>
      new Promise<void>((res) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = () => res();
        r.onerror = () => res();
      })
    ));
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
}

// ── App readiness ─────────────────────────────────────────────────────────────

/**
 * Navigate to the app and wait until the NavBar is visible.
 * Re-navigates to "/" if not already on the app — avoids a redundant
 * navigation when clearStorage() was already called.
 *
 * Also installs a handler to auto-dismiss the download consent dialog
 * (embedding model / WASM model) that would otherwise block ingest flow.
 */
export async function waitForApp(page: Page): Promise<void> {
  // A single fresh load of the app root. In dev, HMR or the service worker can abort an in-flight
  // navigation (net::ERR_ABORTED) — and the old code fired goto('/') up to three times in a row,
  // which made that abort likely. One navigation, retried on abort, is both simpler and reliable.
  for (let i = 0; ; i++) {
    try { await page.goto('/', { waitUntil: 'domcontentloaded' }); break; }
    catch (e) {
      if (i >= 2) throw e;
      await page.waitForTimeout(400);
    }
  }
  await page.locator('nav').waitFor({ timeout: 15_000 });

  // Auto-dismiss download consent dialogs (embedding / WASM models).
  // These block the ingest pipeline in E2E since no model cache exists.
  // Clicking "Not now" lets semanticEnrichDiff fall back to structural diff.
  startConsentDismisser(page);
}

/**
 * Poll for the download consent dialog and dismiss it automatically.
 * The dialog blocks the ingest JS pipeline (an awaited Promise), so
 * Playwright's `addLocatorHandler` doesn't fire (it only triggers during
 * actionability checks on elements, not during `waitForURL`).
 * We use a recursive setTimeout approach that won't stack up.
 */
function startConsentDismisser(page: Page): void {
  let stopped = false;
  page.on('close', () => { stopped = true; });
  setTimeout(() => { stopped = true; }, 120_000);

  const tick = async () => {
    if (stopped) return;
    try {
      const btn = page.getByRole('button', { name: /not now/i });
      const visible = await btn.isVisible().catch(() => false);
      if (visible) await btn.click().catch(() => {});
    } catch { /* page navigated or closed */ }
    if (!stopped) setTimeout(tick, 400);
  };
  setTimeout(tick, 300);
}

// ── Navigation helpers ────────────────────────────────────────────────────────

export async function goToIngest(page: Page): Promise<void> {
  await page.goto('/ingest');
  await page.locator('h1, h2, .kicker').first().waitFor({ timeout: 10_000 });
}

export async function goToReview(page: Page): Promise<void> {
  await page.goto('/review');
  await page.locator('h1, h2, .kicker').first().waitFor({ timeout: 10_000 });
}

export async function goToSettings(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.locator('h1').first().waitFor({ timeout: 10_000 });
}

// ── Ingest helpers ────────────────────────────────────────────────────────────

/**
 * Submit a note through the ingest form using the mock backend.
 * Returns after the "done" phase is detected (review link or statement count visible).
 */
export async function ingestNote(
  page: Page,
  title: string,
  body: string
): Promise<void> {
  await goToIngest(page);

  // Click the "note" tab
  await page.getByRole('button', { name: /note/i }).click();

  // Fill title and body fields
  await page.getByPlaceholder(/title/i).fill(title);
  await page.getByPlaceholder(/note/i).fill(body);

  // Submit
  await page.getByRole('button', { name: /extract|submit|ingest/i }).click();

  // Wait for extraction to complete (phase transitions: extracting → diffing → done)
  await page.locator('[data-phase="done"], .ingest-done, text=statements extracted, text=review').waitFor({
    timeout: 30_000,
  });
}

// ── Wait utilities ────────────────────────────────────────────────────────────

/** Wait for a notification with the given text to appear. */
export async function waitForNotification(
  page: Page,
  text: string | RegExp,
  timeout = 8_000
): Promise<void> {
  await page.getByText(text).waitFor({ timeout });
}

/** Assert no JS errors were logged (use in afterEach). */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}
