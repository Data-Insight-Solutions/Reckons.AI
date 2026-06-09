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
 */
export async function waitForApp(page: Page): Promise<void> {
  const url = page.url();
  if (!url.startsWith('http://localhost') || url.includes('about:blank')) {
    await page.goto('/');
  } else if (!url.endsWith('/') && !url.includes('/ingest') && !url.includes('/review') && !url.includes('/settings')) {
    await page.goto('/');
  }
  // Reload to ensure a clean post-clearStorage state
  if (url.startsWith('http://localhost')) {
    await page.goto('/');
  }
  await page.locator('nav').waitFor({ timeout: 15_000 });
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
