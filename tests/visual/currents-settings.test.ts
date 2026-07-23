/**
 * Currents settings (F29.3) — the "currents" section on the /kb page.
 *
 * Currents are recurring streams (rss / url / topic) that feed arrivals into
 * the pod view. Their settings live IN the graph as meta statements under
 * urn:reckons:meta/currents/, so a save must survive a full page reload.
 *
 * Checks:
 *   1. Empty state — section renders with the "+ configure" affordance,
 *      opening it shows the location field, type-gate chips, and empty list
 *   2. Adding a current renders an editable card
 *   3. Round-trip — add + save, reload the page, values persist
 *
 * Screenshots saved to: tests/visual/screenshots/currents/
 */

import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from './kb-seed';

const APP = 'http://localhost:5174';

const CURRENT_LABEL = 'arxiv ai feed';
const CURRENT_URL = 'https://arxiv.org/rss/cs.AI';
const LOCATION = 'Colorado, US';

function currentsSection(page: Page) {
  return page.locator('section.section').filter({
    has: page.locator('h3', { hasText: /^currents$/ }),
  });
}

test.describe('Currents settings (/kb)', () => {
  test('empty state — configure affordance and editor fields', async ({ page }) => {
    await clearAllKbs(page);
    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(1500);

    const section = currentsSection(page);
    await expect(section).toBeVisible();

    // No currents yet — the toggle reads "+ configure"
    const toggle = section.locator('button', { hasText: /configure/ });
    await expect(toggle).toBeVisible();

    await screenshotTo(page, 'currents', '01-empty-collapsed');

    await toggle.click();
    const editor = section.locator('.currents-editor');
    await expect(editor).toBeVisible();

    // Location field, entity-type gate chips, and the empty list message
    await expect(editor.locator('#currents-location')).toBeVisible();
    expect(await editor.locator('.chip-row .chip').count()).toBeGreaterThan(0);
    await expect(editor.locator('.filter-empty')).toContainText('no currents configured');

    await screenshotTo(page, 'currents', '02-empty-editor-open');
  });

  test('adding a current renders an editable card', async ({ page }) => {
    await clearAllKbs(page);
    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(1500);

    const section = currentsSection(page);
    await section.locator('button', { hasText: /configure/ }).click();
    const editor = section.locator('.currents-editor');
    await expect(editor).toBeVisible();

    await editor.locator('button', { hasText: '+ add current' }).click();
    const card = editor.locator('.current-card');
    await expect(card).toBeVisible();

    await card.locator('.current-label').fill(CURRENT_LABEL);
    await card.locator('.current-source').fill(CURRENT_URL);

    // Label edits recompute the slug shown under the card
    await expect(card.locator('.currents-slug')).toContainText('urn:reckons:currents/arxiv-ai-feed');

    await screenshotTo(page, 'currents', '03-one-current');
  });

  test('round-trip — save, reload, values persist', async ({ page }) => {
    await clearAllKbs(page);
    await page.goto(`${APP}/kb`);
    await page.waitForTimeout(1500);

    const section = currentsSection(page);
    await section.locator('button', { hasText: /configure/ }).click();
    const editor = section.locator('.currents-editor');
    await expect(editor).toBeVisible();

    await editor.locator('#currents-location').fill(LOCATION);
    await editor.locator('button', { hasText: '+ add current' }).click();
    const card = editor.locator('.current-card');
    await card.locator('.current-label').fill(CURRENT_LABEL);
    await card.locator('.current-source').fill(CURRENT_URL);

    const saveBtn = editor.locator('button', { hasText: /save currents/ });
    await saveBtn.click();
    // Save is async (writes meta statements to the graph) — wait for it to settle
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await page.waitForTimeout(1000);

    // Full reload — settings must come back from the graph's statements
    await page.reload();
    await page.waitForTimeout(2000);

    const section2 = currentsSection(page);
    // The collapsed section now advertises the configured current
    await expect(section2.locator('button', { hasText: /edit \(1\)/ })).toBeVisible({ timeout: 10_000 });
    await expect(section2).toContainText('1 current configured');

    await section2.locator('button', { hasText: /edit \(1\)/ }).click();
    const editor2 = section2.locator('.currents-editor');
    await expect(editor2).toBeVisible();

    await expect(editor2.locator('#currents-location')).toHaveValue(LOCATION);
    const card2 = editor2.locator('.current-card');
    await expect(card2.locator('.current-label')).toHaveValue(CURRENT_LABEL);
    await expect(card2.locator('.current-source')).toHaveValue(CURRENT_URL);
    await expect(card2.locator('.currents-slug')).toContainText('urn:reckons:currents/arxiv-ai-feed');

    await screenshotTo(page, 'currents', '04-persisted-after-reload');
  });
});
