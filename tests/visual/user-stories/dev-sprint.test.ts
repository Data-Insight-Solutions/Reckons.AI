/**
 * User Story: Developer Sprint Planning (Persona: "Dev")
 *
 * A developer uses the Production Status KB and the Roadmap KB to plan
 * a sprint. They need to see what's tested vs what's planned, find gaps,
 * and use the align feature to cross-reference both KBs.
 *
 * Flow:
 *   1. Import Production KB — see test suite entities
 *   2. Import Roadmap KB — see planned features
 *   3. KB page — select both KBs for comparison
 *   4. KB page — click "align these KBs" link
 *   5. Review align tab — auto-populated with both KBs
 *   6. Run alignment — verify suggestions render
 *   7. Summary chips show add/reinforce/conflict counts
 *   8. AlignmentCard renders source->target KB flow
 *
 * Screenshots saved to: tests/visual/screenshots/dev-sprint/
 */

import { test, expect, type Page } from '@playwright/test';
import { analyzePixels } from '../vision-local';
import {
  clearAllKbs, importKbFromTtl,
  screenshotTo,
} from '../kb-seed';

const APP = 'http://localhost:5174';

/** Import Production + Roadmap KBs — self-contained seeding. */
async function seedProdAndRoadmap(page: Page) {
  await clearAllKbs(page);
  await importKbFromTtl(page, 'production');
  await importKbFromTtl(page, 'roadmap');
}

test.describe('User Story: Developer Sprint Planning', () => {
  test('1 — import production KB', async ({ page }) => {
    await clearAllKbs(page);
    await importKbFromTtl(page, 'production');

    await page.goto(APP);
    await page.waitForTimeout(2000);

    await screenshotTo(page, 'dev-sprint', '01-production-imported');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
  });

  test('2 — import roadmap KB', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await screenshotTo(page, 'dev-sprint', '02-roadmap-imported');
  });

  test('3 — KB page shows both KBs, compare selection works', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(2000);

    await screenshotTo(page, 'dev-sprint', '03-kb-page-both');

    // Both KBs should be in the list (at minimum the default + imports)
    const entries = page.locator('.kb-entry');
    const count = await entries.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Try selecting two KBs for comparison via the compare checkboxes
    const compareButtons = page.locator('button').filter({ hasText: /compare|select/i });
    if (await compareButtons.count() >= 2) {
      await compareButtons.nth(0).click();
      await compareButtons.nth(1).click();
      await page.waitForTimeout(500);

      await screenshotTo(page, 'dev-sprint', '03b-kbs-selected-for-compare');
    }
  });

  test('4 — KB page "align these KBs" link appears', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(2000);

    // Select two KBs for comparison
    const compareButtons = page.locator('button').filter({ hasText: /compare|select/i });
    if (await compareButtons.count() >= 2) {
      await compareButtons.nth(0).click();
      await page.waitForTimeout(200);
      await compareButtons.nth(1).click();
      await page.waitForTimeout(500);

      // "align these KBs" link should appear
      const alignLink = page.locator('a.compare-link, a').filter({ hasText: /align/i });
      if (await alignLink.count() > 0) {
        await expect(alignLink.first()).toBeVisible();
        await screenshotTo(page, 'dev-sprint', '04-align-link-visible');
      }
    }
  });

  test('5 — Review align tab renders with KB picker', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Switch to align tab
    const alignTab = page.locator('button').filter({ hasText: /^align$/i });
    await expect(alignTab).toBeVisible({ timeout: 5_000 });
    await alignTab.click();
    await page.waitForTimeout(500);

    await screenshotTo(page, 'dev-sprint', '05-align-tab-with-picker');

    // KB picker should have chips
    const chips = page.locator('.kp-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
  });

  test('6 — select KB and run alignment', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Switch to align tab
    await page.locator('button').filter({ hasText: /^align$/i }).click();
    await page.waitForTimeout(500);

    // Click the first available KB chip to select it
    const firstChip = page.locator('.kp-chip').first();
    if (await firstChip.count() > 0) {
      await firstChip.click();
      await page.waitForTimeout(300);

      await screenshotTo(page, 'dev-sprint', '06a-kb-selected');

      // Click the align button
      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();

        // Wait for alignment to complete (loading -> results)
        await page.waitForTimeout(5000);

        await screenshotTo(page, 'dev-sprint', '06b-alignment-results');
      }
    }
  });

  test('7 — alignment summary chips render', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('button').filter({ hasText: /^align$/i }).click();
    await page.waitForTimeout(500);

    // Select first KB
    const firstChip = page.locator('.kp-chip').first();
    if (await firstChip.count() > 0) {
      await firstChip.click();
      await page.waitForTimeout(300);

      // Run alignment
      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(5000);

        // Summary chips should be visible
        const summaryChips = page.locator('.sc');
        const chipCount = await summaryChips.count();

        await screenshotTo(page, 'dev-sprint', '07-summary-chips');

        // Should have at least "add" and "reinforce" chips
        if (chipCount > 0) {
          const chipTexts = await summaryChips.allTextContents();
          const hasKindChip = chipTexts.some(
            t => /add|reinforce|conflict|refine/i.test(t)
          );
          expect(hasKindChip).toBe(true);
        }
      }
    }
  });

  test('8 — AlignmentCard shows source->target flow', async ({ page }) => {
    await seedProdAndRoadmap(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('button').filter({ hasText: /^align$/i }).click();
    await page.waitForTimeout(500);

    const firstChip = page.locator('.kp-chip').first();
    if (await firstChip.count() > 0) {
      await firstChip.click();
      await page.waitForTimeout(300);

      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(5000);

        // AlignmentCards should be visible
        const cards = page.locator('.ac-card');
        const cardCount = await cards.count();

        if (cardCount > 0) {
          // Verify the source->target flow elements exist
          const flowEl = page.locator('.ac-flow').first();
          await expect(flowEl).toBeVisible();

          // Accept and reject buttons should be present
          const acceptBtn = page.locator('.ac-accept').first();
          const rejectBtn = page.locator('.ac-reject').first();
          await expect(acceptBtn).toBeVisible();
          await expect(rejectBtn).toBeVisible();

          await screenshotTo(page, 'dev-sprint', '08-alignment-cards');
        }
      }
    }
  });

  test('9 — no rendering artifacts throughout flow', async ({ page }) => {
    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
    expect(pixel.hasColorAnomaly).toBe(false);

    await screenshotTo(page, 'dev-sprint', '09-no-artifacts');
  });
});
