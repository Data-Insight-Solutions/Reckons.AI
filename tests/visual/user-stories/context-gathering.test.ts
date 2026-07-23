/**
 * User Story: Context Gathering — pulling knowledge INTO the graph
 *
 * The core Reckons.AI loop is gathering context: turn notes, documents, and
 * structured facts into triples the graph can reason over. These workflows
 * exercise two in-app gathering paths, fully offline (mock ingest backend on
 * :5174, no network, no API keys) with realistic fixtures:
 *
 *   1. Note → extracted facts — write a note in plain language; the (mock)
 *      extractor decomposes it into triples; land on the compare view; see the
 *      facts in the graph.
 *   2. Structured facts → graph — enter subject/predicate/object rows directly
 *      (no AI); land on compare; see them in the graph.
 *
 * Screenshots: tests/visual/screenshots/context-gathering/
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

/** Count statements in the active (default) graph's IndexedDB — backend-agnostic. */
async function countStatements(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('kbase');
        req.onsuccess = () => {
          try {
            const db = req.result;
            const tx = db.transaction('statements', 'readonly');
            const c = tx.objectStore('statements').count();
            c.onsuccess = () => resolve(c.result);
            c.onerror = () => resolve(-1);
          } catch {
            resolve(-1);
          }
        };
        req.onerror = () => resolve(-1);
      })
  );
}

test.describe('Context Gathering', () => {
  test('gather context from a note — mock extraction into the graph', async ({ page }) => {
    await clearAllKbs(page);
    await page.goto(`${APP}/ingest`);
    await page.waitForTimeout(1500);

    await test.step('write a note in plain language', async () => {
      // Default mode is "note".
      await page.locator('input[placeholder="what is this about"]').fill('Backyard solar setup');
      await page
        .locator('textarea[placeholder*="write a note"]')
        .fill(
          'Planning a 2 kW rooftop solar array for the garage. South-facing roof gets ' +
            'about six hours of direct sun. Budget is around $4,000 before rebates. ' +
            'Need an inverter and a permit from the city before install.'
        );
      await screenshotTo(page, 'context-gathering', '01-note-filled');
    });

    await test.step('extract facts (mock) and land on compare', async () => {
      await page.getByRole('button', { name: /extract facts/i }).click();
      // Semantic dedup wants to download an embedding model on first use. Decline
      // it — the pipeline falls back to the structural path, so the workflow stays
      // offline and deterministic. (No dialog if the model is already cached.)
      await page
        .getByRole('button', { name: /not now/i })
        .click({ timeout: 15_000 })
        .catch(() => {});
      await page.waitForURL(/\/compare/, { timeout: 20_000 });
      await page.waitForTimeout(2000);
      await screenshotTo(page, 'context-gathering', '02-compare-extracted');
      expect(await countStatements(page)).toBeGreaterThan(0);
    });

    await test.step('the gathered facts appear in the graph', async () => {
      await page.goto(`${APP}/`);
      await page.waitForTimeout(2500);
      // The gathered facts are actually IN the graph — assert rendered nodes, which is what
      // this step claims to prove. It used to look for the "graph package" panel label, which
      // (a) proved the graph rendered only by proxy and (b) broke the moment that panel moved
      // to the GRAPHS tab (+page.svelte:1942). A test should fail when the BEHAVIOR changes,
      // not when an unrelated panel is rehoused.
      await expect(page.locator('.node-label').first()).toBeVisible({ timeout: 10_000 });
      await screenshotTo(page, 'context-gathering', '03-note-graph');
    });
  });

  test('gather structured facts manually — no AI', async ({ page }) => {
    await clearAllKbs(page);
    await page.goto(`${APP}/ingest`);
    await page.waitForTimeout(1500);

    await test.step('switch to the facts tab and enter triples', async () => {
      await page.locator('.tabs button', { hasText: 'facts' }).click();
      await page.locator('input[placeholder="name for this set of notes"]').fill('Trip logistics');
      const facts: [string, string, string][] = [
        ['weekend-trip', 'check-in', '2026-07-10'],
        ['alex', 'drives-from', 'San Francisco'],
        ['jordan', 'drives-from', 'Los Angeles'],
      ];
      for (let i = 0; i < facts.length; i++) {
        if (i > 0) await page.locator('.add-triple-btn').click();
        await page.locator('.te-sub').nth(i).fill(facts[i][0]);
        await page.locator('.te-pre').nth(i).fill(facts[i][1]);
        await page.locator('.te-obj').nth(i).fill(facts[i][2]);
      }
      await screenshotTo(page, 'context-gathering', '04-facts-filled');
    });

    await test.step('add to graph and land on compare', async () => {
      await page.getByRole('button', { name: /add to graph/i }).click();
      await page.waitForURL(/\/compare/, { timeout: 20_000 });
      await page.waitForTimeout(1500);
      await screenshotTo(page, 'context-gathering', '05-facts-compare');
      expect(await countStatements(page)).toBeGreaterThanOrEqual(3);
    });

    await test.step('the facts appear in the graph', async () => {
      await page.goto(`${APP}/`);
      await page.waitForTimeout(2500);
      // See above: assert rendered nodes, not the relocated panel label.
      await expect(page.locator('.node-label').first()).toBeVisible({ timeout: 10_000 });
      await screenshotTo(page, 'context-gathering', '06-facts-graph');
    });
  });
});
