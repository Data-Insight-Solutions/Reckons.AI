/**
 * Visual regression tests — Storybook stories + full app pages.
 *
 * Analysis layers (cheapest first):
 *  1. Pixel analysis  — solid fill / blank screen detection (always)
 *  2. DOM analysis    — overlap, visibility, z-index (always)
 *  3. Text presence   — expected labels in DOM (always)
 *  4. Mistral OCR     — best-in-class screen text extraction (if MISTRAL_API_KEY)
 *  5. Claude Vision   — semantic layout analysis (if ANTHROPIC_API_KEY)
 *
 * Run:
 *   npm run storybook &           # for Storybook stories
 *   npm run dev:test &            # for full app pages
 *   npm run test:visual           # run all visual tests
 *   ANTHROPIC_API_KEY=... MISTRAL_API_KEY=... npm run test:visual  # with API tiers
 */

import { test, expect } from '@playwright/test';
import { analyzePixels, analyzeDOMOverlaps, analyzeText, auditTouchTargets } from './vision-local';
import {
  analyzePageScreenshot, analyzeOCR,
  hasAnthropicKey, hasMistralKey,
  PROMPTS,
  type NavBarAnalysis, type GraphAnalysis, type PageAnalysis,
} from './vision-analyze';

const STORYBOOK = 'http://localhost:6006';
const APP = 'http://localhost:5174';

function storyUrl(id: string) {
  return `${STORYBOOK}/iframe.html?id=${id}&viewMode=story`;
}

// ── Shared local checks ─────────────────────────────────────────────────────

async function assertNoArtifacts(page: import('@playwright/test').Page) {
  const screenshot = await page.screenshot();
  const pixel = await analyzePixels(screenshot);

  // These should NEVER happen — hard failures
  expect(pixel.hasColorAnomaly, `Color anomaly: ${pixel.anomalyDetails.join('; ')}`).toBe(false);
  expect(pixel.isSolidFill, `Solid fill: ${pixel.dominantColor} (${(pixel.dominantColorRatio * 100).toFixed(0)}%)`).toBe(false);

  return pixel;
}

// ── NavBar (Storybook) ──────────────────────────────────────────────────────

test.describe('NavBar', () => {
  test('graph-active story renders correctly', async ({ page }) => {
    await page.goto(storyUrl('shell-navbar--graph-active'));
    await page.waitForLoadState('networkidle');

    // DOM: nav links present
    const links = page.locator('nav a, nav button');
    await expect(links.first()).toBeVisible();

    // Text: expected labels
    const text = await analyzeText(page, ['graph', 'review', 'ingest']);
    expect(text.expectedMissing).toHaveLength(0);

    // AI semantic analysis (gated on API key)
    if (hasAnthropicKey()) {
      const result = await analyzePageScreenshot<NavBarAnalysis>(page, PROMPTS.navBar);
      expect(result.navPresent).toBe(true);
      expect(result.itemCount).toBeGreaterThanOrEqual(4);
      expect(result.layoutIssues).toHaveLength(0);
    }
  });

  test('review-active story shows review as active', async ({ page }) => {
    await page.goto(storyUrl('shell-navbar--review-active'));
    await page.waitForLoadState('networkidle');

    const links = page.locator('nav a, nav button');
    await expect(links.first()).toBeVisible();

    if (hasAnthropicKey()) {
      const result = await analyzePageScreenshot<NavBarAnalysis>(page, PROMPTS.navBar);
      expect(result.navPresent).toBe(true);
      expect(result.activeItem?.toLowerCase()).toContain('review');
    }
  });
});

// ── KnowledgeGraph2D (Storybook) ────────────────────────────────────────────

test.describe('KnowledgeGraph2D', () => {
  test('force layout renders nodes (no magenta fill)', async ({ page }) => {
    await page.goto(storyUrl('graph-knowledgegraph2d--force-layout'));
    await page.waitForLoadState('networkidle');
    // Give force simulation time to settle — this was too short before
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    // Pixel check: detect the magenta fill bug
    const pixel = await assertNoArtifacts(page);
    // Canvas should have varied content, not a mostly-uniform background
    expect(pixel.uniqueColorCount).toBeGreaterThan(20);

    // AI analysis (gated)
    if (hasAnthropicKey()) {
      const result = await analyzePageScreenshot<GraphAnalysis>(page, PROMPTS.graph2D);
      expect(result.nodesVisible).toBe(true);
      expect(result.nodeCount).toBeGreaterThanOrEqual(4);
      expect(result.layoutIssues).toHaveLength(0);
    }
  });

  test('empty graph renders blank canvas without errors', async ({ page }) => {
    await page.goto(storyUrl('graph-knowledgegraph2d--empty-graph'));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    // Should NOT have a solid anomaly color (magenta etc) even when empty
    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.hasColorAnomaly).toBe(false);

    // No JS errors
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(300);
    expect(errors).toHaveLength(0);
  });
});

// ── SnapPanel (Storybook) ───────────────────────────────────────────────────

test.describe('SnapPanel', () => {
  test('bottom-right story renders panel', async ({ page }) => {
    await page.goto(storyUrl('shell-snappanel--bottom-right'));
    await page.waitForLoadState('networkidle');

    const panel = page.locator('[class*="snap"]').first();
    await expect(panel).toBeVisible();
  });
});

// ── Full App Pages ──────────────────────────────────────────────────────────

test.describe('App Pages', () => {
  test.beforeEach(async ({ page }) => {
    // Clear storage for clean state
    await page.goto(APP);
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  });

  test('main page — no artifacts, nav visible', async ({ page }) => {
    await page.goto(APP);
    await page.locator('nav').waitFor({ timeout: 10_000 });

    await assertNoArtifacts(page);

    const text = await analyzeText(page, ['graph']);
    expect(text.expectedMissing).toHaveLength(0);
  });

  test('review page — split view layout intact', async ({ page }) => {
    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await assertNoArtifacts(page);

    // DOM structure check
    const dom = await analyzeDOMOverlaps(page, [
      '.graph-pane', '.review-panel', '.resize-handle', 'nav',
    ]);

    // Graph pane and review panel should both be visible
    const graphPane = dom.visibleElements.find(e => e.selector === '.graph-pane');
    const reviewPanel = dom.visibleElements.find(e => e.selector === '.review-panel');
    expect(graphPane?.visible, 'graph pane should be visible').toBe(true);
    expect(reviewPanel?.visible, 'review panel should be visible').toBe(true);

    // They should not significantly overlap
    const overlap = dom.overlaps.find(
      o => (o.element1.includes('graph') && o.element2.includes('review')) ||
           (o.element1.includes('review') && o.element2.includes('graph'))
    );
    if (overlap) {
      expect(overlap.overlapPercent, 'graph/review overlap should be minimal').toBeLessThan(0.05);
    }

    // Text checks
    const text = await analyzeText(page, ['review', 'preview', 'incoming']);
    expect(text.expectedMissing).toHaveLength(0);
  });

  test('ingest page — form visible', async ({ page }) => {
    await page.goto(`${APP}/ingest`);
    await page.waitForTimeout(1000);
    await assertNoArtifacts(page);
  });

  test('settings page — no overflow', async ({ page }) => {
    await page.goto(`${APP}/settings`);
    await page.waitForTimeout(1000);
    await assertNoArtifacts(page);

    const overflows = await page.evaluate(() =>
      document.body.scrollWidth > window.innerWidth
    );
    expect(overflows).toBe(false);
  });

  // ── OCR validation (Mistral — gated on API key) ──

  test('review page — OCR text readability', async ({ page }) => {
    test.skip(!hasMistralKey(), 'MISTRAL_API_KEY not set');

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const screenshot = await page.screenshot();
    const ocr = await analyzeOCR(screenshot);
    expect(ocr).not.toBeNull();

    const ocrText = ocr!.result.extractedText.toLowerCase();
    // Key UI text should be readable via OCR
    expect(ocrText).toContain('review');
    expect(ocrText).toContain('preview');
  });

  // ── Claude Vision semantic check (gated on API key) ──

  test('review page — semantic layout analysis', async ({ page }) => {
    test.skip(!hasAnthropicKey(), 'ANTHROPIC_API_KEY not set');

    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    const result = await analyzePageScreenshot<PageAnalysis>(page, PROMPTS.fullPage);
    expect(result.contentVisible).toBe(true);
    expect(result.layoutIssues).toHaveLength(0);
    expect(result.features.length).toBeGreaterThan(0);
  });
});

// ── Mobile UX ───────────────────────────────────────────────────────────────

test.describe('Mobile UX', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });

  test('touch targets meet WCAG 2.5.5 minimum', async ({ page }) => {
    await page.goto(`${APP}/ingest`);
    await page.waitForTimeout(1000);

    const issues = await auditTouchTargets(page);

    // Report all undersized targets
    if (issues.length > 0) {
      console.log(`Touch target issues (${issues.length}):`);
      for (const t of issues.slice(0, 10)) {
        console.log(`  ${t.selector}: "${t.text}" (${t.width}×${t.height}px)`);
      }
    }

    // Hard fail if primary action buttons are too small
    const criticalIssues = issues.filter(t =>
      t.text.toLowerCase().includes('extract') ||
      t.text.toLowerCase().includes('submit') ||
      t.text.toLowerCase().includes('accept')
    );
    expect(criticalIssues, 'Primary action buttons must be ≥44px').toHaveLength(0);
  });

  test('review page stacks vertically on mobile', async ({ page }) => {
    await page.goto(`${APP}/review`);
    await page.waitForTimeout(1500);

    await assertNoArtifacts(page);

    // On mobile, graph pane and review panel should be stacked (not side by side)
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
      // Allow some tolerance for borders/gaps
      expect(layout.reviewTop).toBeGreaterThanOrEqual(layout.graphBottom - 5);
    }
  });

  test('no horizontal overflow on mobile', async ({ page }) => {
    for (const url of ['/', '/ingest', '/review', '/settings']) {
      await page.goto(`${APP}${url}`);
      await page.waitForTimeout(800);
      const overflows = await page.evaluate(() =>
        document.body.scrollWidth > window.innerWidth + 5
      );
      expect(overflows, `Horizontal overflow on ${url}`).toBe(false);
    }
  });
});
