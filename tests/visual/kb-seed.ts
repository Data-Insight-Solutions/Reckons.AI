/**
 * KB seeding helpers for visual user-story tests.
 *
 * Seeds three Reckons.AI KBs by importing static TTL files via the
 * ingest page's file input. Each KB uses the "as new KB" import flow
 * to create a separate IndexedDB instance registered in the KB registry.
 *
 * KBs:
 *   1. reckons-production  — Production status & test results
 *   2. reckons-roadmap     — Product design & roadmap
 *   3. starter-guide       — Documentation how-to hub
 */

import { type Page, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP = 'http://localhost:5174';
const TTL_DIR = path.resolve(__dirname, '../../static');

export const KB_FILES = {
  production: 'reckons-production.ttl',
  roadmap: 'reckons-roadmap.ttl',
  docs: 'starter-guide.ttl',
} as const;

export type KbName = keyof typeof KB_FILES;

/**
 * Clear all KB data and registry so tests start from a clean slate.
 */
export async function clearAllKbs(page: Page): Promise<void> {
  await page.goto(APP);
  await page.evaluate(async () => {
    // List and delete all IndexedDB databases
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(
        (dbs || []).map(db =>
          new Promise<void>(res => {
            if (!db.name) return res();
            const r = indexedDB.deleteDatabase(db.name);
            r.onsuccess = () => res();
            r.onerror = () => res();
          })
        )
      );
    } catch { /* some browsers don't support databases() */ }
    // Also try the default
    await new Promise<void>(res => {
      const r = indexedDB.deleteDatabase('kbase');
      r.onsuccess = () => res();
      r.onerror = () => res();
    });
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
}

/**
 * Import a TTL file as a new KB using the ingest page's file input.
 * Returns the registered KB name for later reference.
 */
export async function importKbFromTtl(page: Page, kbKey: KbName): Promise<string> {
  const filename = KB_FILES[kbKey];
  const ttlPath = path.join(TTL_DIR, filename);

  // Navigate to ingest page
  await page.goto(`${APP}/ingest`);
  await page.waitForTimeout(1500);

  // Click the "kb" tab — the button that sets mode='kb'.
  // Must be precise: the tab bar has "triples ✎" and "extract triples →" too.
  // The kb tab contains an SVG icon + literal text " kb".
  const tabs = page.locator('.tabs button');
  const tabCount = await tabs.count();
  let clicked = false;
  for (let i = 0; i < tabCount; i++) {
    const text = (await tabs.nth(i).textContent())?.trim().toLowerCase();
    if (text === 'kb') {
      await tabs.nth(i).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // Fallback: look for any button whose text is exactly "kb"
    await page.locator('button:text-is("kb")').first().click();
  }
  await page.waitForTimeout(500);

  // Upload the TTL file
  const fileInput = page.locator('input[type="file"][accept*=".ttl"]');
  await fileInput.setInputFiles(ttlPath);

  // Wait for parsing to complete
  await page.waitForTimeout(2000);

  // Click "as new KB" button
  const asNewBtn = page.getByRole('button', { name: /as new kb/i });
  await expect(asNewBtn).toBeEnabled({ timeout: 10_000 });
  await asNewBtn.click();

  // Wait for import to complete — a notification or redirect happens
  await page.waitForTimeout(3000);

  return filename.replace('.ttl', '');
}

/**
 * Seed all three KBs. Returns after all are imported.
 */
export async function seedAllKbs(page: Page): Promise<void> {
  // Import in sequence — each creates a separate KB
  for (const kbKey of ['production', 'roadmap', 'docs'] as KbName[]) {
    await importKbFromTtl(page, kbKey);
  }
  // Return to the home page on the default KB
  await page.goto(APP);
  await page.waitForTimeout(1500);
}

/**
 * Navigate to the KB page and verify a specific KB appears in the registry list.
 */
export async function verifyKbInRegistry(page: Page, nameFragment: string): Promise<void> {
  await page.goto(`${APP}/kb`);
  await page.waitForTimeout(1500);
  await expect(
    page.getByText(new RegExp(nameFragment, 'i')).first()
  ).toBeVisible({ timeout: 8_000 });
}

/**
 * Switch to a specific KB by clicking its name on the KB page.
 * Uses the "switch" or entry click behavior.
 */
export async function switchToKb(page: Page, nameFragment: string): Promise<void> {
  await page.goto(`${APP}/kb`);
  await page.waitForTimeout(1500);

  // Find the KB entry and click the switch button
  const entry = page.locator('.kb-entry').filter({ hasText: new RegExp(nameFragment, 'i') });
  const switchBtn = entry.getByRole('button', { name: /switch|open|use/i }).first();

  if (await switchBtn.count() > 0) {
    await switchBtn.click();
  } else {
    // Fallback: click the entry name
    await entry.locator('.kb-name, .kb-title').first().click();
  }

  await page.waitForTimeout(2000);
}

/**
 * Take a screenshot and save it to a user-story subdirectory.
 */
export async function screenshotTo(
  page: Page,
  storyDir: string,
  name: string,
): Promise<Buffer> {
  const dir = path.join(__dirname, 'screenshots', storyDir);
  fs.mkdirSync(dir, { recursive: true });
  const buf = await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: false,
  });
  return buf;
}
