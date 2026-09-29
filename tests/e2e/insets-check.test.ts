import { test, expect } from '@playwright/test';
import { waitForSettled } from '../visual/settle';

/*
 * THE GRAPH IS FRAMED BY WHAT THE USER CAN SEE, NOT BY THE CANVAS RECTANGLE.
 *
 * Measured 2026-09-18 with Shelly's explore panel and the filter stack open: 372px of a 1280px
 * canvas is covered on the left and nothing on the right, so the free centre is 826px while the
 * camera sat at 640px. The default force layout has no camera fit, so it rested at the canvas
 * centre forever and the graph settled underneath the panels — which reads as "the nodes are
 * bunched up", because the visible half is crowded while the hidden half holds the rest.
 *
 * Tuning the physics does not fix this and the sweep proved it: REPEL, BASE_REST and CENTER
 * varied across both renderers moved the spread by less than noise, because those constants scale
 * the whole layout and the camera simply refits. Zooming is not spreading.
 */
test('panel gutters are measured while the graph is open', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Getting started/i }).click();
  await waitForSettled(page, { timeoutMs: 25_000 });

  const m = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('.snap-panel')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const mid = window.innerWidth / 2;
    let left = 0, right = 0;
    for (const r of rects) {
      if ((r.left + r.right) / 2 < mid) left = Math.max(left, r.right);
      else right = Math.max(right, window.innerWidth - r.left);
    }
    return { panels: rects.length, left, right, width: window.innerWidth };
  });

  console.log(`panels=${m.panels} leftGutter=${m.left} rightGutter=${m.right} shift=${Math.round((m.left - m.right) / 2)}px`);

  // The regression worth catching is a panel that stops being measured — a renamed class, a panel
  // that no longer carries .snap-panel — which would silently return the camera to the canvas
  // centre and put the graph back under the panels with nothing failing.
  expect(m.panels, 'no side panels found — the gutter measurement has lost its selector').toBeGreaterThan(0);
  expect(m.left + m.right, 'panels present but occluding zero pixels').toBeGreaterThan(100);
});
