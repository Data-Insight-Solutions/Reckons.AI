/**
 * User Story: Review Workbench (F30, Persona: "Dev")
 *
 * The review page's preview pane grew browse controls (layout chips + node
 * search), a node-details panel with facts + a mini Shelly chat, and
 * click-to-focus on review cards (accent left border, camera fly, a ◉ name
 * badge over the graph, gold edge highlight).
 *
 * Flow:
 *   1. Seed a pending fact so the incoming tab has a review card
 *   2. Preview pane shows browse controls (free/focus/hub chips + node search)
 *   3. Click the review card — card gets the focused accent border, the
 *      ◉ badge appears over the graph, and the node-details panel opens
 *   4. Node search finds and focuses a node
 *
 * Screenshots saved to: tests/visual/screenshots/review-workbench/
 */

import { test, expect } from '@playwright/test';
import { analyzePixels } from '../vision-local';
import { clearAllKbs, seedPendingArrival, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

/** seedPendingArrival()'s default subject renders as this label. */
const ARRIVAL_BADGE_LABEL = 'nimbus station';

test.describe('User Story: Review Workbench', () => {
  test('1 — preview pane shows browse controls', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // Browse controls: layout ToggleGroup chips + node search input
    const browse = page.locator('.browse-controls');
    await expect(browse).toBeVisible();
    for (const chip of ['free', 'focus', 'hub']) {
      await expect(browse.locator('.tg-chip', { hasText: chip })).toBeVisible();
    }
    await expect(page.locator('.node-search-input')).toBeVisible();

    await screenshotTo(page, 'review-workbench', '01-browse-controls');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
    expect(pixel.hasColorAnomaly).toBe(false);
  });

  test('2 — clicking a review card focuses its node (badge + details panel)', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    // The seeded pending fact appears as an incoming review card
    const card = page.locator('.entry-focus-wrap').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.click();
    await page.waitForTimeout(800);

    // Card shows the focused accent left border
    await expect(card).toHaveClass(/entry-focused/);

    // ◉ name badge appears over the graph with the node's label
    const badge = page.locator('.focus-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('◉');
    await expect(badge).toContainText(ARRIVAL_BADGE_LABEL);

    // Node-details panel opens on the left with the fact list
    const details = page.locator('.node-details-pane');
    await expect(details).toBeVisible();
    await expect(details.locator('.ndp-stmt').first()).toBeVisible();
    // The seeded fact is pending, so it carries the pending tag
    await expect(details.locator('.ndp-pending-tag').first()).toBeVisible();
    // Mini chat input is part of the panel
    await expect(details.locator('.ndp-chat-input')).toBeVisible();

    await screenshotTo(page, 'review-workbench', '02-card-focused');
  });

  test('3 — node search focuses a node', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const search = page.locator('.node-search-input');
    await search.fill('nimbus');
    const row = page.locator('.node-search-row').first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();
    await page.waitForTimeout(800);

    // Focusing via search shows the badge and opens the details panel too
    await expect(page.locator('.focus-badge')).toContainText(ARRIVAL_BADGE_LABEL);
    await expect(page.locator('.node-details-pane')).toBeVisible();

    await screenshotTo(page, 'review-workbench', '03-node-search-focus');
  });

  test('4 — closing the details panel clears the focus state', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const card = page.locator('.entry-focus-wrap').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page.locator('.node-details-pane')).toBeVisible();

    await page.locator('.ndp-close').click();
    await expect(page.locator('.node-details-pane')).not.toBeVisible();
    await expect(page.locator('.focus-badge')).not.toBeVisible();
    await expect(card).not.toHaveClass(/entry-focused/);
  });
});
