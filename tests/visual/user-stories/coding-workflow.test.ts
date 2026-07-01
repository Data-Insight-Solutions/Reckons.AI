/**
 * User Story: Agent Coding Workflow — Pre/Post Action Review
 *
 * A developer uses Reckons.AI to review KB state before and after an AI agent
 * writes code. The workflow captures the production baseline, reviews the
 * roadmap plan, then verifies that code changes align with planned features.
 *
 * Persona: "Dev" — a developer using Claude Code with KB alignment
 *
 * Flow (3 narrative tests, each with sub-steps):
 *
 *   Test 1 — Pre-action: Establish baseline and review the plan
 *     1. Import Production KB as active baseline
 *     2. Verify production entities on KB page
 *     3. View production graph with feature nodes
 *     4. Import Roadmap KB (planned features the agent should implement)
 *     5. Review page > align tab: cross-reference production vs roadmap
 *     6. Run alignment: see which planned features already exist in production
 *
 *   Test 2 — Post-action: Code was written, review and accept/reject
 *     1. Seed: production (active) + roadmap + codebase (simulates agent output)
 *     2. Review page > align tab: see alignment targets
 *     3. Run alignment: codebase entities mapped against production
 *     4. Verify alignment cards with source->target flow
 *     5. Accept matching entities (approve implemented features)
 *     6. Reject unplanned entities (flag scope creep)
 *
 *   Test 3 — Visual integrity: no rendering artifacts across pages
 *
 * Screenshots saved to: tests/visual/screenshots/coding-workflow/
 */

import { test, expect, type Page } from '@playwright/test';
import { analyzePixels, analyzeText } from '../vision-local';
import {
  clearAllKbs, importKbFromTtl,
  screenshotTo,
} from '../kb-seed';

const APP = 'http://localhost:5174';

// ── Test 1: Pre-action — baseline + roadmap review ─────────────────────────

test.describe('Agent Coding Workflow', () => {

  test('Pre-action: establish production baseline and review roadmap plan', async ({ page }) => {

    await test.step('Import production KB as active baseline', async () => {
      await clearAllKbs(page);
      await importKbFromTtl(page, 'production', { switchTo: true });
    });

    await test.step('Verify production entities on KB page', async () => {
      await page.goto(`${APP}/kb`);
      await page.waitForTimeout(2000);
      await screenshotTo(page, 'coding-workflow', '01-production-baseline');

      const entries = page.locator('.kb-entry');
      expect(await entries.count()).toBeGreaterThanOrEqual(1);
    });

    await test.step('View production graph — feature nodes rendered', async () => {
      await page.goto(APP);
      await page.waitForTimeout(3000);
      await screenshotTo(page, 'coding-workflow', '02-production-graph');

      // Graph canvas should be present
      expect(await page.locator('canvas').count()).toBeGreaterThan(0);

      // Feature-related terms should appear somewhere in the DOM
      const text = await analyzeText(page, ['production', 'knowledge', 'triple']);
      expect(text.expectedFound.length).toBeGreaterThan(0);
    });

    await test.step('Import roadmap KB — planned features for the agent', async () => {
      await importKbFromTtl(page, 'roadmap');
      // Verify both KBs exist
      await page.goto(`${APP}/kb`);
      await page.waitForTimeout(2000);
      await screenshotTo(page, 'coding-workflow', '03-roadmap-imported');

      const entries = page.locator('.kb-entry');
      expect(await entries.count()).toBeGreaterThanOrEqual(2);
    });

    await test.step('Review page — align production vs roadmap', async () => {
      await page.goto(`${APP}/review`);
      await page.waitForTimeout(2000);

      // Click align tab
      const alignTab = page.locator('.rp-tabs').getByRole('button', { name: 'align' });
      await expect(alignTab).toBeVisible({ timeout: 10_000 });
      await alignTab.click();
      await page.waitForTimeout(500);
      await screenshotTo(page, 'coding-workflow', '04-align-tab');

      // Roadmap KB chip should appear in the picker
      const chips = page.locator('.kp-chip');
      const chipCount = await chips.count();
      expect(chipCount).toBeGreaterThanOrEqual(1);

      // Select the roadmap chip for alignment
      await chips.first().click();
      await page.waitForTimeout(300);
      await screenshotTo(page, 'coding-workflow', '05-roadmap-chip-selected');
    });

    await test.step('Run alignment — planned features vs production entities', async () => {
      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(6000);
        await screenshotTo(page, 'coding-workflow', '06-pre-action-alignment-results');

        // Alignment cards show how roadmap entities map to production
        const cards = page.locator('.ac-card');
        const cardCount = await cards.count();
        await screenshotTo(page, 'coding-workflow', '06b-alignment-cards-detail');

        if (cardCount > 0) {
          // Verify card structure: source->target flow visible
          const flowEl = page.locator('.ac-flow').first();
          await expect(flowEl).toBeVisible();
        }
      }
    });
  });

  // ── Test 2: Post-action — code written, review alignment ────────────────

  test('Post-action: review code changes against roadmap and accept/reject', async ({ page }) => {

    await test.step('Seed: production (active) + roadmap + codebase', async () => {
      await clearAllKbs(page);
      // Production as the active KB (the "before" state)
      await importKbFromTtl(page, 'production', { switchTo: true });
      // Roadmap = what the agent was told to implement
      await importKbFromTtl(page, 'roadmap');
      // Codebase = what the agent actually produced (simulated code commit)
      await importKbFromTtl(page, 'codebase');
    });

    await test.step('Verify 3 KBs in registry', async () => {
      await page.goto(`${APP}/kb`);
      await page.waitForTimeout(2000);
      await screenshotTo(page, 'coding-workflow', '07-three-kbs-seeded');

      const entries = page.locator('.kb-entry');
      expect(await entries.count()).toBeGreaterThanOrEqual(3);
    });

    await test.step('Review page — align tab with KB targets', async () => {
      await page.goto(`${APP}/review`);
      await page.waitForTimeout(2000);

      const alignTab = page.locator('.rp-tabs').getByRole('button', { name: 'align' });
      await expect(alignTab).toBeVisible({ timeout: 10_000 });
      await alignTab.click();
      await page.waitForTimeout(500);
      await screenshotTo(page, 'coding-workflow', '08-post-align-tab');

      // Should see chips for both roadmap and codebase KBs
      const chips = page.locator('.kp-chip');
      expect(await chips.count()).toBeGreaterThanOrEqual(2);
    });

    await test.step('Select KB and run alignment — code vs production', async () => {
      const chips = page.locator('.kp-chip');
      await chips.first().click();
      await page.waitForTimeout(300);
      await screenshotTo(page, 'coding-workflow', '09-kb-selected-for-alignment');

      const alignBtn = page.locator('button').filter({ hasText: /align \d/i });
      if (await alignBtn.count() > 0) {
        await alignBtn.click();
        await page.waitForTimeout(6000);
        await screenshotTo(page, 'coding-workflow', '10-post-alignment-results');
      }
    });

    await test.step('Verify alignment cards show source-target flow', async () => {
      const cards = page.locator('.ac-card');
      const cardCount = await cards.count();

      if (cardCount > 0) {
        await screenshotTo(page, 'coding-workflow', '11-alignment-cards');

        // Source->target flow
        const flowEl = page.locator('.ac-flow').first();
        await expect(flowEl).toBeVisible();

        // Accept and reject buttons present
        await expect(page.locator('.ac-accept').first()).toBeVisible();
        await expect(page.locator('.ac-reject').first()).toBeVisible();
      }
    });

    await test.step('Accept: approve aligned entities (implemented features)', async () => {
      const cards = page.locator('.ac-card');
      const initialCount = await cards.count();

      if (initialCount > 0) {
        await screenshotTo(page, 'coding-workflow', '12a-before-accept');

        // Accept the first alignment card
        await page.locator('.ac-accept').first().click();
        await page.waitForTimeout(1000);
        await screenshotTo(page, 'coding-workflow', '12b-after-accept');

        // Card count should decrease
        const newCount = await page.locator('.ac-card').count();
        expect(newCount).toBeLessThan(initialCount);
      }
    });

    await test.step('Reject: flag unplanned entities (scope creep)', async () => {
      const cards = page.locator('.ac-card');
      const cardCount = await cards.count();

      if (cardCount > 0) {
        await page.locator('.ac-reject').first().click();
        await page.waitForTimeout(500);
        await screenshotTo(page, 'coding-workflow', '13-after-reject');

        const newCount = await page.locator('.ac-card').count();
        expect(newCount).toBeLessThan(cardCount);
      }
    });
  });

  // ── Test 3: Visual integrity ────────────────────────────────────────────

  test('Visual integrity: no rendering artifacts across workflow pages', async ({ page }) => {
    await clearAllKbs(page);
    await importKbFromTtl(page, 'production', { switchTo: true });
    await importKbFromTtl(page, 'roadmap');

    const pagesToCheck = [
      { url: APP, name: 'graph' },
      { url: `${APP}/review`, name: 'review' },
      { url: `${APP}/kb`, name: 'kb' },
    ];

    for (const p of pagesToCheck) {
      await page.goto(p.url);
      await page.waitForTimeout(1500);

      const screenshot = await page.screenshot();
      const pixel = await analyzePixels(screenshot);
      await screenshotTo(page, 'coding-workflow', `14-artifacts-${p.name}`);

      expect(pixel.isSolidFill, `${p.name} should not be a solid fill`).toBe(false);
      expect(pixel.hasColorAnomaly, `${p.name} should have no color anomalies`).toBe(false);
    }
  });
});
