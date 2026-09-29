import { test, expect } from '@playwright/test';
import { waitForSettled } from '../visual/settle';

/*
 * THE GRAPH MUST SETTLE, AND WE MUST KNOW HOW LONG IT TAKES.
 *
 * Measured 2026-09-18 on the camping starter: the force simulation reaches rest at ~6.9s, while
 * tests/visual/ waits a fixed 1500ms in ten places. Every baseline that suite produced was shot
 * roughly five seconds mid-simulation, which is why two runs of the same page differ for reasons
 * unrelated to any change under test.
 *
 * This asserts the settle SIGNAL rather than a duration, so it fails if the simulation stops
 * converging, without becoming flaky on a slow machine. The generous ceiling is deliberate: the
 * failure worth catching is "never settles", not "settled a second later than last time".
 */
test('the starter graph reaches rest, and reports when', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Getting started/i }).click();

  const r = await waitForSettled(page, { timeoutMs: 25_000 });
  console.log(`settled: attribute=${r.settledAttribute} after=${r.elapsedMs}ms stablePixelFrames=${r.stableFrames}`);

  expect(r.settledAttribute, 'graph never reported data-graph-settled').toBe(true);
  expect(r.timedOut).toBe(false);
  // Pixels are NOT expected to freeze — the camping starter ships an animated campfire GIF, so
  // stableFrames of 0 is correct here and must not be asserted against.
});
