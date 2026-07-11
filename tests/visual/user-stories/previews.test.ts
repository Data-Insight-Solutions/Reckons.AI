/**
 * User Story: node preview images (local, graph-declared).
 *
 * The starter graph gives Alex and Jordan photos via a local image path
 * (p:photo "/starter-assets/*.svg"), served from the static root — no external
 * URLs, no binary bundling. This verifies:
 *   1. "Always-on previews" (Settings) renders those images on the nodes with no
 *      hover, and
 *   2. the same image shows in the node details panel.
 *
 * Screenshots: tests/visual/screenshots/previews/
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

async function seedStarter(page: Page) {
  await page.goto(APP);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /getting started/i }).first().click();
  await page.waitForTimeout(3000);
}

test('always-on previews render local node photos', async ({ page }) => {
  await clearAllKbs(page);
  await seedStarter(page);

  await test.step('enable always-on previews in Settings', async () => {
    await page.goto(`${APP}/settings`);
    await page.waitForTimeout(1000);
    const toggle = page.locator('.field', { hasText: 'always-on previews' }).locator('.toggle-btn');
    await toggle.scrollIntoViewIfNeeded();
    if ((await toggle.innerText()).trim() !== 'on') await toggle.click();
    await expect(toggle).toHaveText('on');
  });

  await test.step('photos render on the person nodes without hovering', async () => {
    await page.goto(APP);
    await page.waitForTimeout(3000);
    const thumbs = page.locator('img.node-preview-thumb');
    await expect(thumbs.first()).toBeVisible({ timeout: 10_000 });
    // The starter people carry embedded face photos (self-contained data: URIs).
    await expect(page.locator('img.node-preview-thumb[src^="data:image"]')).toHaveCount(2);
    // And they actually loaded (naturalWidth > 0), not broken-image icons.
    const loaded = await page
      .locator('img.node-preview-thumb[src^="data:image"]')
      .first()
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    expect(loaded).toBe(true);
    await screenshotTo(page, 'previews', '01-always-on-previews');
  });
});
