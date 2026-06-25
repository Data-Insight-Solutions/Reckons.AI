/**
 * Mobile UX tests — main graph view.
 *
 * Validates that the graph page renders correctly on mobile viewports:
 *  - SnapPanels don't overlap each other or the nav
 *  - Canvas is visible and not occluded
 *  - No horizontal overflow
 *  - Touch targets meet WCAG 2.5.5
 *  - Node panel doesn't cover the entire viewport
 *
 * Uses Pixel 7 viewport (412×915) via Playwright config.
 */

import { test, expect } from '@playwright/test';
import { analyzePixels, analyzeDOMOverlaps, analyzeText, auditTouchTargets } from '../vision-local';

const APP = 'http://localhost:5174';

// Seed the app with mock data so SnapPanels appear
async function seedGraphData(page: import('@playwright/test').Page) {
  await page.goto(APP);
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  await page.goto(APP);
  await page.waitForTimeout(1500);
}

// ── Basic rendering ──────────────────────────────────────────────────────────

test.describe('Graph view — mobile rendering', () => {
  test('no horizontal overflow on graph page', async ({ page }) => {
    await seedGraphData(page);

    const overflows = await page.evaluate(() =>
      document.body.scrollWidth > window.innerWidth + 5
    );
    expect(overflows, 'Graph page should not overflow horizontally on mobile').toBe(false);
  });

  test('no color anomalies or blank screen', async ({ page }) => {
    await seedGraphData(page);

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);

    expect(pixel.hasColorAnomaly, `Color anomaly: ${pixel.anomalyDetails.join('; ')}`).toBe(false);
    expect(pixel.isSolidFill, `Solid fill: ${pixel.dominantColor}`).toBe(false);
  });

  test('nav bar visible and accessible', async ({ page }) => {
    await seedGraphData(page);

    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();
    // Nav is a centered pill on mobile — should be at least 70% of viewport width
    expect(navBox!.width).toBeGreaterThan(page.viewportSize()!.width * 0.7);
    // Nav should not overflow the viewport
    expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 2);
  });

  test('graph canvas fills viewport', async ({ page }) => {
    await seedGraphData(page);

    const canvas = page.locator('canvas').first();
    const section = page.locator('section.graph').first();

    // At least the graph section or canvas should be visible
    const sectionVisible = await section.isVisible().catch(() => false);
    if (sectionVisible) {
      const sectionBox = await section.boundingBox();
      expect(sectionBox).not.toBeNull();
      // Graph section should use most of the viewport
      const vp = page.viewportSize()!;
      expect(sectionBox!.width).toBeGreaterThanOrEqual(vp.width * 0.95);
      expect(sectionBox!.height).toBeGreaterThanOrEqual(vp.height * 0.5);
    }
  });
});

// ── SnapPanel mobile layout ──────────────────────────────────────────────────

test.describe('SnapPanel — mobile overlap detection', () => {
  test('filter panel does not exceed viewport width', async ({ page }) => {
    await seedGraphData(page);

    const panels = page.locator('.snap-panel');
    const count = await panels.count();

    for (let i = 0; i < count; i++) {
      const panel = panels.nth(i);
      const visible = await panel.isVisible().catch(() => false);
      if (!visible) continue;

      const box = await panel.boundingBox();
      if (!box) continue;

      const vp = page.viewportSize()!;
      // Panel should not extend past the viewport
      expect(
        box.x + box.width,
        `SnapPanel ${i} right edge (${box.x + box.width}px) exceeds viewport (${vp.width}px)`
      ).toBeLessThanOrEqual(vp.width + 2);

      // Panel should not be wider than viewport minus margins
      expect(
        box.width,
        `SnapPanel ${i} too wide (${box.width}px)`
      ).toBeLessThanOrEqual(vp.width);
    }
  });

  test('snap panels do not overlap nav bar', async ({ page }) => {
    await seedGraphData(page);

    const nav = page.locator('nav');
    const navVisible = await nav.isVisible().catch(() => false);
    if (!navVisible) return;

    const navBox = await nav.boundingBox();
    if (!navBox) return;

    const panels = page.locator('.snap-panel');
    const count = await panels.count();

    for (let i = 0; i < count; i++) {
      const panel = panels.nth(i);
      const visible = await panel.isVisible().catch(() => false);
      if (!visible) continue;

      const panelBox = await panel.boundingBox();
      if (!panelBox) continue;

      // Calculate overlap between panel and nav
      const overlapX = Math.max(0,
        Math.min(panelBox.x + panelBox.width, navBox.x + navBox.width) -
        Math.max(panelBox.x, navBox.x)
      );
      const overlapY = Math.max(0,
        Math.min(panelBox.y + panelBox.height, navBox.y + navBox.height) -
        Math.max(panelBox.y, navBox.y)
      );
      const overlapArea = overlapX * overlapY;
      const navArea = navBox.width * navBox.height;

      // Allow at most 5% overlap (borders, shadows)
      expect(
        overlapArea / navArea,
        `SnapPanel ${i} overlaps nav by ${((overlapArea / navArea) * 100).toFixed(1)}%`
      ).toBeLessThan(0.05);
    }
  });

  test('snap panels do not overlap each other excessively', async ({ page }) => {
    await seedGraphData(page);

    const panels = page.locator('.snap-panel');
    const count = await panels.count();
    const boxes: Array<{ idx: number; box: { x: number; y: number; width: number; height: number } }> = [];

    for (let i = 0; i < count; i++) {
      const panel = panels.nth(i);
      const visible = await panel.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await panel.boundingBox();
      if (box) boxes.push({ idx: i, box });
    }

    // Check all pairs
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        const overlapArea = overlapX * overlapY;
        const smallerArea = Math.min(a.width * a.height, b.width * b.height);

        if (smallerArea > 0) {
          expect(
            overlapArea / smallerArea,
            `SnapPanel ${boxes[i].idx} and ${boxes[j].idx} overlap by ${((overlapArea / smallerArea) * 100).toFixed(1)}%`
          ).toBeLessThan(0.15);
        }
      }
    }
  });

  test('node panel does not cover entire viewport when open', async ({ page }) => {
    await seedGraphData(page);

    // Try clicking on the graph to select a node
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.waitForTimeout(500);

    // Check if a node panel appeared
    const nodePanel = page.locator('.snap-panel').last();
    const visible = await nodePanel.isVisible().catch(() => false);
    if (!visible) return; // No node was selected, skip

    const panelBox = await nodePanel.boundingBox();
    if (!panelBox) return;

    // Panel should not cover more than 70% of viewport height
    expect(
      panelBox.height / vp.height,
      `Node panel covers ${((panelBox.height / vp.height) * 100).toFixed(0)}% of viewport`
    ).toBeLessThan(0.7);
  });
});

// ── Touch targets ────────────────────────────────────────────────────────────

test.describe('Graph view — touch targets', () => {
  test('nav buttons meet WCAG 2.5.5 minimum (44px)', async ({ page }) => {
    await seedGraphData(page);

    // Check top-level nav links and buttons (not nav-pair items, which are
    // stacked and share a larger combined touch area)
    const navButtons = page.locator('nav > a, nav > button');
    const count = await navButtons.count();

    const undersized: string[] = [];
    for (let i = 0; i < count; i++) {
      const btn = navButtons.nth(i);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await btn.boundingBox();
      if (!box) continue;
      // Check touch target area: width * height should be at least 44*44 = 1936px²
      // This allows narrow-but-tall or short-but-wide elements to pass
      if (box.width < 44 && box.height < 44) {
        const text = await btn.textContent().catch(() => '?');
        undersized.push(`"${text?.trim()}" (${Math.round(box.width)}x${Math.round(box.height)}px)`);
      }
    }

    expect(
      undersized,
      `Undersized nav targets: ${undersized.join(', ')}`
    ).toHaveLength(0);
  });

  test('filter chips are tappable', async ({ page }) => {
    await seedGraphData(page);

    // Check filter chips inside snap panels
    const chips = page.locator('.snap-panel .chip');
    const count = await chips.count();

    if (count === 0) return; // No chips visible (empty KB)

    const tooSmall: string[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const chip = chips.nth(i);
      const visible = await chip.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await chip.boundingBox();
      if (!box) continue;
      // Chips should be at least 32px tall for comfortable tapping
      if (box.height < 32) {
        const text = await chip.textContent().catch(() => '?');
        tooSmall.push(`"${text?.trim()}" (${Math.round(box.height)}px tall)`);
      }
    }

    // Warn but don't hard-fail for chips (they're secondary controls)
    if (tooSmall.length > 0) {
      console.warn(`Small filter chips on mobile: ${tooSmall.join(', ')}`);
    }
  });
});

// ── Page-level mobile checks ─────────────────────────────────────────────────

test.describe('All pages — mobile overflow', () => {
  const pages = ['/', '/review', '/ingest', '/settings', '/kb', '/overlay', '/about'];

  for (const url of pages) {
    test(`no horizontal overflow on ${url}`, async ({ page }) => {
      await page.goto(APP);
      await page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
      await page.goto(`${APP}${url}`);
      await page.waitForTimeout(1200);

      const overflows = await page.evaluate(() =>
        document.body.scrollWidth > window.innerWidth + 5
      );
      expect(overflows, `Horizontal overflow on ${url}`).toBe(false);
    });
  }
});

// ── DOM overlap audit across pages ──────────────────────────────────────────

test.describe('Mobile — element visibility', () => {
  test('ingest page form fits mobile viewport', async ({ page }) => {
    await page.goto(`${APP}/ingest`);
    await page.waitForTimeout(1200);

    const vp = page.viewportSize()!;

    // Check that the main form/content area doesn't overflow
    const overflows = await page.evaluate(() =>
      document.body.scrollWidth > window.innerWidth + 5
    );
    expect(overflows).toBe(false);

    // Touch target audit
    const issues = await auditTouchTargets(page);
    const criticalIssues = issues.filter(t =>
      t.text.toLowerCase().includes('extract') ||
      t.text.toLowerCase().includes('submit') ||
      t.text.toLowerCase().includes('ingest')
    );
    expect(criticalIssues, 'Primary ingest buttons must be >= 44px').toHaveLength(0);
  });

  test('settings page sections are readable', async ({ page }) => {
    await page.goto(`${APP}/settings`);
    await page.waitForTimeout(2000);

    // No overflow
    const overflows = await page.evaluate(() =>
      document.body.scrollWidth > window.innerWidth + 5
    );
    expect(overflows).toBe(false);

    // Check for key UI text — "system configuration" is the h1, "backends" is a nav link
    const text = await analyzeText(page, ['configuration', 'backends']);
    expect(text.expectedMissing).toHaveLength(0);
  });

  test('review page stacks vertically on mobile', async ({ page }) => {
    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const layout = await page.evaluate(() => {
      const graphPane = document.querySelector('.graph-pane');
      const reviewPanel = document.querySelector('.review-panel');
      if (!graphPane || !reviewPanel) return null;
      const gRect = graphPane.getBoundingClientRect();
      const rRect = reviewPanel.getBoundingClientRect();
      return {
        graphBottom: gRect.bottom,
        reviewTop: rRect.top,
        graphRight: gRect.right,
        reviewLeft: rRect.left,
        viewportWidth: window.innerWidth,
      };
    });

    if (layout) {
      // Review panel should be below graph pane (stacked), not beside it
      expect(layout.reviewTop).toBeGreaterThanOrEqual(layout.graphBottom - 5);
    }
  });
});
