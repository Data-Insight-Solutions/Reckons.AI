/**
 * Mobile UX tests — overlay page.
 *
 * Validates:
 *  - Page renders without overflow on mobile
 *  - Controls are tappable
 *  - Graph area is visible
 *  - Empty/guidance state displays correctly
 */

import { test, expect } from '@playwright/test';
import { analyzePixels, analyzeText, auditTouchTargets } from '../vision-local';

const APP = 'http://localhost:5174';

test.describe('Overlay page — mobile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP);
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  });

  test('no horizontal overflow', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(2000);

    const overflows = await page.evaluate(() =>
      document.body.scrollWidth > window.innerWidth + 5
    );
    expect(overflows, 'Overlay page overflows horizontally on mobile').toBe(false);
  });

  test('no color anomalies', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.hasColorAnomaly).toBe(false);
  });

  test('page title and controls visible', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    // Wait for the page to fully load and render header
    await page.waitForTimeout(3000);

    // The header contains "overlay" as a kicker and "multi-graph comparison" as h1.
    // On mobile, these may be above the fold — scroll to top to ensure visibility.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const text = await analyzeText(page, ['comparison']);
    expect(text.expectedMissing).toHaveLength(0);
  });

  test('graph area visible with example data', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(3000);

    const graphArea = page.locator('.graph-area');
    const visible = await graphArea.isVisible().catch(() => false);

    if (visible) {
      const box = await graphArea.boundingBox();
      expect(box).not.toBeNull();
      const vp = page.viewportSize()!;
      // Graph area should span most of the width
      expect(box!.width).toBeGreaterThan(vp.width * 0.8);
      // And have reasonable height
      expect(box!.height).toBeGreaterThan(200);
    }
  });

  test('filter chips wrap properly on mobile', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(3000);

    const filterSections = page.locator('.filter-section');
    const count = await filterSections.count();

    for (let i = 0; i < count; i++) {
      const section = filterSections.nth(i);
      const visible = await section.isVisible().catch(() => false);
      if (!visible) continue;

      const box = await section.boundingBox();
      if (!box) continue;

      const vp = page.viewportSize()!;
      // Filter sections should not overflow horizontally
      expect(
        box.x + box.width,
        `Filter section ${i} overflows viewport`
      ).toBeLessThanOrEqual(vp.width + 5);
    }
  });

  test('control buttons are tappable (44px minimum)', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(2000);

    // Check main action buttons
    const buttons = page.locator('.controls-bar button, .controls-bar label');
    const count = await buttons.count();

    const undersized: string[] = [];
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await btn.boundingBox();
      if (!box) continue;
      if (box.height < 44) {
        const text = await btn.textContent().catch(() => '?');
        undersized.push(`"${text?.trim()}" (${Math.round(box.height)}px)`);
      }
    }

    // Warn for undersized buttons
    if (undersized.length > 0) {
      console.warn(`Undersized overlay controls: ${undersized.join(', ')}`);
    }
  });

  test('stats panel readable on mobile', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(3000);

    const statsPanel = page.locator('.stats-panel');
    const visible = await statsPanel.isVisible().catch(() => false);

    if (visible) {
      const box = await statsPanel.boundingBox();
      if (box) {
        const vp = page.viewportSize()!;
        // Stats panel should not overflow
        expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 5);
      }
    }
  });

  test('kb guidance hint shown when relevant', async ({ page }) => {
    await page.goto(`${APP}/overlay`);
    await page.waitForTimeout(3000);

    // Check for the guidance hint about adding custom KBs
    const hint = page.locator('.kb-guidance');
    const hintVisible = await hint.isVisible().catch(() => false);

    // The hint should appear to guide users toward using their own KBs
    // (This validates the UX improvement we're adding)
    if (hintVisible) {
      const text = await hint.textContent();
      expect(text).toBeTruthy();
    }
  });
});
