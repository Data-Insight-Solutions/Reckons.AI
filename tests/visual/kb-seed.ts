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
  codebase: 'reckons-codebase.ttl',
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
    // Pre-dismiss oneTime notifications that overlay UI during tests
    try {
      localStorage.setItem('reckons:dismissed-tips', JSON.stringify([
        'setup-local-folder', 'tutorial-welcome', 'tutorial-ingest',
        'tutorial-review', 'tutorial-graph', 'tutorial-settings',
        'tutorial-kb', 'tutorial-compare',
      ]));
    } catch {}
  });
}

/**
 * Import a TTL file as a new KB using the ingest page's file input.
 *
 * @param switchTo — if true, accept the confirm dialog to switch to the new KB
 *   (makes it the active KB for subsequent navigation). Default: false (dismiss).
 * @returns the registered KB name for later reference.
 */
export async function importKbFromTtl(
  page: Page,
  kbKey: KbName,
  opts?: { switchTo?: boolean },
): Promise<string> {
  const filename = KB_FILES[kbKey];
  const ttlPath = path.join(TTL_DIR, filename);

  // Navigate to ingest page
  await page.goto(`${APP}/ingest`);
  await page.waitForTimeout(1500);

  // Click the graph-import tab — the button that sets mode='kb'. After the
  // KB→graph terminology rename this tab is now LABELLED "graph" (with an SVG
  // icon), though the internal mode value is still 'kb'. Accept either label so
  // the helper survives the rename in both directions.
  // Must be precise: the tab bar has "triples ✎" and "extract triples →" too.
  const tabLabels = ['graph', 'kb'];
  const tabs = page.locator('.tabs button');
  const tabCount = await tabs.count();
  let clicked = false;
  for (let i = 0; i < tabCount && !clicked; i++) {
    const text = (await tabs.nth(i).textContent())?.trim().toLowerCase();
    if (text && tabLabels.includes(text)) {
      await tabs.nth(i).click();
      clicked = true;
    }
  }
  if (!clicked) {
    // Fallback: match either label exactly.
    await page.locator('.tabs button', { hasText: /^\s*(graph|kb)\s*$/i }).first().click();
  }
  await page.waitForTimeout(500);

  // Upload the TTL file
  const fileInput = page.locator('input[type="file"][accept*=".ttl"]');
  await fileInput.setInputFiles(ttlPath);

  // Wait for parsing to complete
  await page.waitForTimeout(2000);

  // Click the "as new graph" button (formerly "as new KB") — triggers confirm()
  const asNewBtn = page.getByRole('button', { name: /as new (graph|kb)/i });
  await expect(asNewBtn).toBeEnabled({ timeout: 10_000 });

  if (opts?.switchTo) {
    // Accept: switch to the new KB (triggers page reload via switchToKb)
    page.once('dialog', dialog => dialog.accept());
    await asNewBtn.click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(2000);
  } else {
    // Dismiss: create the KB but stay on the current one
    page.once('dialog', dialog => dialog.dismiss());
    await asNewBtn.click();
    await page.waitForTimeout(3000);
  }

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
