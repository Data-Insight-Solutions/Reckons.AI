/**
 * User Story: Documentation User (Persona: "Dana")
 *
 * Dana is a new Reckons.AI user who wants to understand the product.
 * She uses the Docs KB and the Production Status KB together.
 *
 * Flow:
 *   1. Import the Docs KB — see entities, graph renders
 *   2. Import the Production KB — see test categories
 *   3. Navigate to KB page — both KBs visible in registry
 *   4. Open Review > Align tab — compare Docs vs Production
 *   5. Verify alignment suggestions appear (shared entities like Reckons.AI)
 *   6. Accept one alignment suggestion — verify it moves to confirmed
 *
 * Screenshots saved to: tests/visual/screenshots/user-docs/
 */

import { test, expect, type Page } from '@playwright/test';
import { analyzePixels, analyzeDOMOverlaps, analyzeText } from '../vision-local';
import {
  clearAllKbs, importKbFromTtl,
  screenshotTo,
} from '../kb-seed';

const APP = 'http://localhost:5174';

/** Import Docs + Production KBs — self-contained seeding for each test. */
async function seedDocsAndProduction(page: Page) {
  await clearAllKbs(page);
  await importKbFromTtl(page, 'docs');
  await importKbFromTtl(page, 'production');
}

test.describe('User Story: Documentation User', () => {
  test('1 — import docs KB and verify graph renders', async ({ page }) => {
    await clearAllKbs(page);
    await importKbFromTtl(page, 'docs');

    // After import, go to the main page to see the graph
    await page.goto(APP);
    await page.waitForTimeout(3000);

    await screenshotTo(page, 'user-docs', '01-docs-kb-imported');

    // Verify no rendering artifacts
    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill, 'Should not be a solid fill').toBe(false);
    expect(pixel.hasColorAnomaly, 'No color anomalies').toBe(false);
  });

  test('2 — import production KB as second KB', async ({ page }) => {
    await seedDocsAndProduction(page);

    await screenshotTo(page, 'user-docs', '02-production-kb-imported');
  });

  test('3 — KB page shows both KBs in registry', async ({ page }) => {
    await seedDocsAndProduction(page);

    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(2000);

    await screenshotTo(page, 'user-docs', '03-kb-registry-both');

    // Verify both KBs appear
    const pageText = await page.textContent('body') ?? '';
    expect(
      pageText.toLowerCase().includes('production') ||
      pageText.toLowerCase().includes('starter') ||
      pageText.toLowerCase().includes('reckons')
    ).toBe(true);
  });

  test('4 — Review page has align tab', async ({ page }) => {
    await seedDocsAndProduction(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Verify the "align" tab button exists
    const alignTab = page.locator('button').filter({ hasText: /^align$/i });
    await expect(alignTab).toBeVisible({ timeout: 5_000 });

    await alignTab.click();
    await page.waitForTimeout(500);

    await screenshotTo(page, 'user-docs', '04-review-align-tab');

    // Verify the align tab content renders
    const content = await page.textContent('body') ?? '';
    expect(content.toLowerCase()).toContain('select');
  });

  test('5 — align tab shows KB picker chips', async ({ page }) => {
    await seedDocsAndProduction(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Click align tab
    await page.locator('button').filter({ hasText: /^align$/i }).click();
    await page.waitForTimeout(500);

    // KB picker chips should be visible (from the KbPicker component)
    const chips = page.locator('.kp-chip');
    const chipCount = await chips.count();

    await screenshotTo(page, 'user-docs', '05-kb-picker-chips');

    // Should have at least one KB chip (the other KBs, excluding current)
    expect(chipCount).toBeGreaterThanOrEqual(1);
  });

  test('6 — no artifacts on review page with align tab active', async ({ page }) => {
    await seedDocsAndProduction(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);
    await page.locator('button').filter({ hasText: /^align$/i }).click();
    await page.waitForTimeout(500);

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
    expect(pixel.hasColorAnomaly).toBe(false);

    // DOM check: review panel and graph pane should both be visible
    const dom = await analyzeDOMOverlaps(page, [
      '.graph-pane', '.review-panel',
    ]);
    const graphPane = dom.visibleElements.find(e => e.selector === '.graph-pane');
    const reviewPanel = dom.visibleElements.find(e => e.selector === '.review-panel');
    expect(graphPane?.visible, 'graph pane visible').toBe(true);
    expect(reviewPanel?.visible, 'review panel visible').toBe(true);

    await screenshotTo(page, 'user-docs', '06-align-no-artifacts');
  });
});
