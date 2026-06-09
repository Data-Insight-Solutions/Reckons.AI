/**
 * Visual regression tests against Storybook stories.
 *
 * Requires Storybook running on localhost:6006.
 * Run: npm run storybook & npm run test:visual
 *
 * Strategy:
 *  1. Navigate to each Storybook iframe story URL
 *  2. Take a screenshot
 *  3. (Optional) send to Claude Vision for semantic analysis
 *  4. Assert key structural properties
 *
 * Claude Vision analysis is gated on ANTHROPIC_API_KEY being set so
 * CI runs without an API key still perform the basic Playwright checks.
 */

import { test, expect } from '@playwright/test';
import {
  analyzePageScreenshot,
  PROMPTS,
  type NavBarAnalysis,
  type GraphAnalysis,
} from './vision-analyze';

const STORYBOOK = 'http://localhost:6006';

function storyUrl(id: string) {
  return `${STORYBOOK}/iframe.html?id=${id}&viewMode=story`;
}

// ── NavBar ───────────────────────────────────────────────────────────────────

test.describe('NavBar', () => {
  test('graph-active story renders', async ({ page }) => {
    await page.goto(storyUrl('shell-navbar--graph-active'));
    await page.waitForLoadState('networkidle');

    // Basic DOM check — at least one nav link present
    const links = page.locator('nav a, nav button');
    await expect(links.first()).toBeVisible();

    // AI visual analysis (only if API key is available)
    if (process.env.ANTHROPIC_API_KEY) {
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

    if (process.env.ANTHROPIC_API_KEY) {
      const result = await analyzePageScreenshot<NavBarAnalysis>(page, PROMPTS.navBar);
      expect(result.navPresent).toBe(true);
      expect(result.activeItem?.toLowerCase()).toContain('review');
    }
  });
});

// ── KnowledgeGraph2D ──────────────────────────────────────────────────────────

test.describe('KnowledgeGraph2D', () => {
  test('force layout renders nodes', async ({ page }) => {
    await page.goto(storyUrl('graph-knowledgegraph2d--force-layout'));
    await page.waitForLoadState('networkidle');
    // Give the force simulation time to settle
    await page.waitForTimeout(1500);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    if (process.env.ANTHROPIC_API_KEY) {
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

    // No JS errors on empty graph
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(300);
    expect(errors).toHaveLength(0);
  });

  test('snapshot — force layout', async ({ page }) => {
    await page.goto(storyUrl('graph-knowledgegraph2d--force-layout'));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Mask the canvas since force simulation is non-deterministic
    await expect(page).toHaveScreenshot('graph2d-force.png', {
      mask: [page.locator('canvas')],
      maxDiffPixelRatio: 0.02,
    });
  });
});

// ── SnapPanel ────────────────────────────────────────────────────────────────

test.describe('SnapPanel', () => {
  test('bottom-right story renders panel', async ({ page }) => {
    await page.goto(storyUrl('shell-snappanel--bottom-right'));
    await page.waitForLoadState('networkidle');

    // Panel element should exist
    const panel = page.locator('[class*="snap"]').first();
    await expect(panel).toBeVisible();
  });

  test('snapshot — bottom-right', async ({ page }) => {
    await page.goto(storyUrl('shell-snappanel--bottom-right'));
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('snappanel-bottom-right.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
