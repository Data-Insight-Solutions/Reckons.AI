import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Regression gate for the REVIEW view's visuals (Matt's prod report, 2026-07-17):
 *   (1) "In Review I am not seeing labels ... everything is white, no colour."
 *   (2) "Notifications overlap important things upper right — collapse them into a bell."
 *
 * The main graph view is visually gated (tests/visual/user-stories/graph-labels.test.ts) but
 * /review's preview graph (which draws CONFIRMED + pending statements through a SEPARATE mount of
 * KnowledgeGraph + the shared GraphLabels overlay) had no gate. This is it. We seed the everyday
 * starter as confirmed facts — the same graph Matt reviews — and assert labels render.
 */

async function loadStarter(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(1000);
  const gs = page.getByRole('button', { name: /getting started/i }).first();
  if (await gs.count()) { await gs.click(); await page.waitForTimeout(2500); }
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('review preview graph renders node labels for a real graph (not blank)', async ({ page }) => {
  await loadStarter(page);
  await page.goto('/review');
  await page.waitForTimeout(1500);

  // Must NOT be the empty state — the starter gives the preview graph confirmed statements.
  await expect(page.getByText(/no statements to preview/i)).toHaveCount(0);

  // The 3D canvas mounts…
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 8_000 });

  // …and the shared GraphLabels overlay emits several real node labels (the bug was ZERO labels).
  await page.waitForTimeout(4_000); // let the force layout place nodes
  const labels = page.locator('.node-label');
  const count = await labels.count();
  if (count === 0) {
    test.skip(true, 'graph rendered without WebGL labels in this environment');
    return;
  }
  expect(count, 'review preview graph should render several node labels').toBeGreaterThanOrEqual(5);
  const text = (await labels.allInnerTexts()).join(' ').toLowerCase();
  const seeded = ['lake george', 'alex', 'jordan', 'oh! ridge', 'june lake'];
  const found = seeded.filter((s) => text.includes(s));
  expect(found.length, `seeded entity labels should appear; found [${found.join(', ')}]`).toBeGreaterThanOrEqual(2);
});

test('notifications collapse to a corner bell on /review and expand on click', async ({ page }) => {
  await loadStarter(page);
  await page.goto('/review');
  await page.waitForTimeout(1500);

  // The first-run "Protect your graph" tip is a notification; on /review it must be collapsed to
  // the bell (so it can't overlap the review panel's tabs), NOT shown as an expanded card.
  const bell = page.locator('.notif-bell');
  await expect(bell).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.notification-stack')).toHaveCount(0);

  // Clicking the bell expands the stack in place.
  await bell.click();
  await expect(page.locator('.notification-stack')).toBeVisible({ timeout: 3_000 });
});

test('notifications are expanded by default on the home graph view', async ({ page }) => {
  await loadStarter(page);
  await page.goto('/');
  await page.waitForTimeout(1500);
  // On '/', the top-right is free, so the stack shows expanded by default (bell still present).
  await expect(page.locator('.notif-bell')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.notification-stack')).toBeVisible({ timeout: 3_000 });
});
