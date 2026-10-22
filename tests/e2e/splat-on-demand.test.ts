import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F58.9.2, an entity splat over the Gaussian budget (131,072) does not load at
 * startup. The Generated assets example has a 262,144-Gaussian music box: opening the example
 * counts 2 loaded splats (the turtle and the island), selecting the music box offers "Load 3D splat",
 * and pressing it loads it, so the canvas counts 3.
 */
test('a heavy entity splat loads only when asked for', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/about');
  const card = page.locator('.starter-card', { hasText: /generated assets/i });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  const canvas = page.locator('main canvas[data-splats]').first();
  await expect(canvas).toHaveAttribute('data-splats', '2/0', { timeout: 60_000 });
  // Give the header read time to finish: the count must STAY 2 while the music box waits.
  await page.waitForTimeout(3_000);
  await expect(canvas).toHaveAttribute('data-splats', '2/0');

  const slug = 'gen-ornate-music-box-splat';
  await page.getByPlaceholder('search nodes or facts…').fill(slug);
  await page.locator('.sb-node-row').filter({ has: page.locator('.sb-node-iri') }).filter({ hasText: slug }).first().click();
  const load = page.getByRole('button', { name: /load 3d splat/i });
  await expect(load).toBeVisible({ timeout: 15_000 });
  await load.click();
  await expect(canvas).toHaveAttribute('data-splats', '3/0', { timeout: 90_000 });
  await expect(load).toHaveCount(0);
});
