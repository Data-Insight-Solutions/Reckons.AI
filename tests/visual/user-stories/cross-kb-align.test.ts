/**
 * User Story: Cross-KB Alignment (Persona: "PM" — Product Manager)
 *
 * A PM uses all three KBs to get a holistic view: what's documented,
 * what's tested, and what's planned. They use the align feature to
 * find gaps: features in the roadmap with no tests, tested features
 * missing from docs, etc.
 *
 * Flow:
 *   1. Import all three KBs (production, roadmap, docs)
 *   2. KB page — all three visible in registry
 *   3. Review align — select multiple KBs
 *   4. Run alignment — results from multiple KBs show distinct source labels
 *   5. Verify accept/reject buttons work
 *   6. Tab switching — align tab preserves state after switching away and back
 *   7. Mobile viewport — align tab layout is usable on mobile
 *
 * Screenshots saved to: tests/visual/screenshots/cross-kb-align/
 */

import { test, expect, type Page } from '@playwright/test';
import { analyzePixels, analyzeDOMOverlaps } from '../vision-local';
import {
  clearAllKbs, importKbFromTtl,
  screenshotTo,
} from '../kb-seed';

const APP = 'http://localhost:5174';

/** Import all three KBs — called at the start of each test that needs them. */
async function seedThreeKbs(page: Page) {
  await clearAllKbs(page);
  await importKbFromTtl(page, 'production');
  await importKbFromTtl(page, 'roadmap');
  await importKbFromTtl(page, 'docs');
}

test.describe('User Story: Cross-KB Alignment', () => {
  test('1 — import all three KBs', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(APP);
    await page.waitForTimeout(2000);

    await screenshotTo(page, 'cross-kb-align', '01-all-three-imported');
  });

  test('2 — KB page shows all three KBs', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(2000);

    await screenshotTo(page, 'cross-kb-align', '02-kb-registry-three');

    // Should have at least 3 entries (default + 3 imports = 4, or 3 if default was overwritten)
    const entries = page.locator('.kb-entry');
    expect(await entries.count()).toBeGreaterThanOrEqual(3);
  });

  test('3 — align tab allows selecting multiple KBs', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
    await page.waitForTimeout(500);

    const chips = page.locator('.kp-chip');
    const chipCount = await chips.count();

    await screenshotTo(page, 'cross-kb-align', '03a-align-picker-multi');

    // Select multiple chips
    if (chipCount >= 2) {
      await chips.nth(0).click();
      await page.waitForTimeout(200);
      await chips.nth(1).click();
      await page.waitForTimeout(200);

      // Both should have active class
      const activeChips = page.locator('.kp-chip.active');
      expect(await activeChips.count()).toBe(2);

      await screenshotTo(page, 'cross-kb-align', '03b-two-kbs-selected');
    }
  });

  test('4 — multi-KB alignment shows distinct source labels', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
    await page.waitForTimeout(500);

    // Select up to 2 KBs
    const chips = page.locator('.kp-chip');
    const chipCount = await chips.count();
    const selectCount = Math.min(chipCount, 2);
    for (let i = 0; i < selectCount; i++) {
      await chips.nth(i).click();
      await page.waitForTimeout(200);
    }

    // Run alignment
    const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
    if (await alignBtn.count() > 0) {
      await alignBtn.click();
      await page.waitForTimeout(6000);

      await screenshotTo(page, 'cross-kb-align', '04-multi-kb-results');

      // Check for AlignmentCards
      const cards = page.locator('.ac-card');
      const cardCount = await cards.count();

      if (cardCount > 0) {
        // Source flow labels should be visible
        const flows = page.locator('.ac-flow');
        expect(await flows.count()).toBeGreaterThan(0);

        // The "from" labels should reference KB names
        const fromLabels = page.locator('.ac-from');
        const firstFrom = await fromLabels.first().textContent();
        expect(firstFrom?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('5 — accept button on alignment card works', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
    await page.waitForTimeout(500);

    // Select first KB
    const chips = page.locator('.kp-chip');
    if (await chips.count() > 0) {
      await chips.first().click();
      await page.waitForTimeout(300);

      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(5000);

        const cards = page.locator('.ac-card');
        const initialCount = await cards.count();

        if (initialCount > 0) {
          await screenshotTo(page, 'cross-kb-align', '05a-before-accept');

          // Click accept on the first card
          const acceptBtn = page.locator('.ac-accept').first();
          await acceptBtn.click();
          await page.waitForTimeout(1000);

          await screenshotTo(page, 'cross-kb-align', '05b-after-accept');

          // Card count should decrease by one
          const newCount = await page.locator('.ac-card').count();
          expect(newCount).toBeLessThan(initialCount);
        }
      }
    }
  });

  test('6 — reject button on alignment card works', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
    await page.waitForTimeout(500);

    const chips = page.locator('.kp-chip');
    if (await chips.count() > 0) {
      await chips.first().click();
      await page.waitForTimeout(300);

      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(5000);

        const cards = page.locator('.ac-card');
        const initialCount = await cards.count();

        if (initialCount > 0) {
          // Click reject
          const rejectBtn = page.locator('.ac-reject').first();
          await rejectBtn.click();
          await page.waitForTimeout(500);

          await screenshotTo(page, 'cross-kb-align', '06-after-reject');

          const newCount = await page.locator('.ac-card').count();
          expect(newCount).toBeLessThan(initialCount);
        }
      }
    }
  });

  test('7 — tab switching preserves align state', async ({ page }) => {
    await seedThreeKbs(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Go to align tab, select a KB
    await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
    await page.waitForTimeout(500);

    const chips = page.locator('.kp-chip');
    if (await chips.count() > 0) {
      await chips.first().click();
      await page.waitForTimeout(300);

      // Switch to incoming tab
      await page.locator('button').filter({ hasText: /^incoming$/i }).click();
      await page.waitForTimeout(300);

      await screenshotTo(page, 'cross-kb-align', '07a-switched-to-incoming');

      // Switch back to align tab
      await page.locator('.rp-tabs button').filter({ hasText: 'align' }).click();
      await page.waitForTimeout(300);

      // The KB chip should still be selected
      const activeChips = page.locator('.kp-chip.active');
      expect(await activeChips.count()).toBeGreaterThanOrEqual(1);

      await screenshotTo(page, 'cross-kb-align', '07b-back-to-align');
    }
  });
});

// ── Mobile viewport tests ──────────────────────────────────────────────────

test.describe('Cross-KB Alignment — Mobile', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });

  test('8 — align tab layout is usable on mobile', async ({ page }) => {
    // Seed at least one extra KB
    await clearAllKbs(page);
    await importKbFromTtl(page, 'production');

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Click align tab
    const alignTab = page.locator('.rp-tabs button').filter({ hasText: 'align' });
    if (await alignTab.count() > 0) {
      await alignTab.click();
      await page.waitForTimeout(500);

      await screenshotTo(page, 'cross-kb-align', '08-mobile-align-tab');

      // No horizontal overflow
      const overflows = await page.evaluate(() =>
        document.body.scrollWidth > window.innerWidth + 5
      );
      expect(overflows, 'No horizontal overflow on mobile').toBe(false);

      // No artifacts
      const screenshot = await page.screenshot();
      const pixel = await analyzePixels(screenshot);
      expect(pixel.isSolidFill).toBe(false);
      expect(pixel.hasColorAnomaly).toBe(false);
    }
  });

  test('9 — review panel stacks below graph on mobile', async ({ page }) => {
    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const dom = await analyzeDOMOverlaps(page, [
      '.graph-pane', '.review-panel',
    ]);
    const graphPane = dom.visibleElements.find(e => e.selector === '.graph-pane');
    const reviewPanel = dom.visibleElements.find(e => e.selector === '.review-panel');

    expect(graphPane?.visible).toBe(true);
    expect(reviewPanel?.visible).toBe(true);

    // Stacked vertically: review panel top >= graph pane bottom
    if (graphPane && reviewPanel) {
      const layout = await page.evaluate(() => {
        const g = document.querySelector('.graph-pane')!.getBoundingClientRect();
        const r = document.querySelector('.review-panel')!.getBoundingClientRect();
        return { graphBottom: g.bottom, reviewTop: r.top };
      });
      expect(layout.reviewTop).toBeGreaterThanOrEqual(layout.graphBottom - 5);
    }

    await screenshotTo(page, 'cross-kb-align', '09-mobile-stacked-layout');
  });
});
