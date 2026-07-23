/**
 * User Story: Pod View Arrivals (F29.3, Persona: "Dev")
 *
 * A developer has a "current" streaming new facts into their graph. Before
 * they're reviewed, those facts show up as translucent, drifting "arrival"
 * nodes when pod view is on. The developer toggles pod view, selects an
 * arrival, and either accepts it (confirming every pending statement that
 * touches the node) or dismisses it (rejecting them).
 *
 * Flow:
 *   1. Seed a pending fact (brand-new subject/object — an "arrival")
 *   2. Home graph, pod view OFF — chip present but inactive
 *   3. Toggle pod view ON — chip active, arrival halo renders
 *   4. Select the arrival via the search bar — node panel shows the
 *      "🐋 arrival" row with accept/dismiss actions
 *   5. Accept the arrival — statement is confirmed, panel closes
 *   6. Re-select the same node — no longer flagged as an arrival
 *
 * Screenshots saved to: tests/visual/screenshots/pod-view/
 */

import { test, expect, type Page } from '@playwright/test';
import { analyzePixels } from '../vision-local';
import { clearAllKbs, seedPendingArrival, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

/** The arrival seeded by seedPendingArrival()'s default triple. */
const ARRIVAL_LABEL = 'nimbus-station';

async function openSearchAndSelect(page: Page, query: string) {
  const input = page.locator('.sb-input');
  await input.click();
  await input.fill(query);
  const row = page.locator('.sb-node-row').first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
}

test.describe('User Story: Pod View Arrivals', () => {
  test('1 — pod chip present and inactive by default', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(APP);
    await page.waitForTimeout(1500);

    const podChip = page.locator('.pod-chip');
    await expect(podChip).toBeVisible();
    await expect(podChip).not.toHaveClass(/pod-active/);

    await screenshotTo(page, 'pod-view', '01-pod-off');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
  });

  test('2 — toggling pod view activates the chip', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(APP);
    await page.waitForTimeout(1500);

    const podChip = page.locator('.pod-chip');
    await podChip.click();
    await expect(podChip).toHaveClass(/pod-active/);

    // Give the drift animation a moment before capturing
    await page.waitForTimeout(1000);
    await screenshotTo(page, 'pod-view', '02-pod-on');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
    expect(pixel.hasColorAnomaly).toBe(false);
  });

  test('3 — selecting an arrival in pod mode shows accept/dismiss', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.locator('.pod-chip').click();
    await page.waitForTimeout(500);

    await openSearchAndSelect(page, ARRIVAL_LABEL);
    await page.waitForTimeout(500);

    const podActions = page.locator('.np-pod-actions');
    await expect(podActions).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.np-pod-label')).toContainText('arrival');
    await expect(page.locator('.np-pod-accept')).toBeVisible();
    await expect(page.locator('.np-pod-dismiss')).toBeVisible();

    await screenshotTo(page, 'pod-view', '03-arrival-selected');
  });

  test('4 — accept flow confirms the arrival statement', async ({ page }) => {
    await clearAllKbs(page);
    await seedPendingArrival(page);

    await page.goto(APP);
    await page.waitForTimeout(1500);
    await page.locator('.pod-chip').click();
    await page.waitForTimeout(500);

    await openSearchAndSelect(page, ARRIVAL_LABEL);
    await expect(page.locator('.np-pod-actions')).toBeVisible({ timeout: 5_000 });

    await page.locator('.np-pod-accept').click();
    await page.waitForTimeout(800);

    // Accepting clears `selected`, so the node panel closes entirely.
    await expect(page.locator('.np-pod-actions')).not.toBeVisible();

    await screenshotTo(page, 'pod-view', '04-after-accept');

    // Re-select the same node — it's now confirmed, so it should no longer
    // be treated as an arrival (the pod actions row must not reappear).
    await openSearchAndSelect(page, ARRIVAL_LABEL);
    await page.waitForTimeout(500);
    await expect(page.locator('.np-pod-actions')).not.toBeVisible();
  });
});
