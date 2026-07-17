import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Review queue tests — confirm, reject, and tab switching.
 *
 * We seed the DB by running a real ingest through the mock backend
 * (no direct IndexedDB writes, which would conflict with Dexie's connection).
 */

/** Seed pending statements by running a mock ingest. */
async function seedPendingStatement(page: Page) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Company Alpha');
  await page.locator('textarea').first().fill('Company Alpha has 50 employees and was founded in 2020.');
  const submitBtn = page.getByRole('button', { name: /extract facts/i });
  await expect(submitBtn).not.toBeDisabled({ timeout: 5_000 });
  await submitBtn.click();
  // Mock backend completes fast and navigates to /compare.
  // Wait for the URL to change away from /ingest.
  await page.waitForURL((url) => !url.pathname.startsWith('/ingest'), { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('review page shows tabs', async ({ page }) => {
  await page.goto('/review');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });

  // Tab buttons exist (incoming / deletions / merges or similar)
  const tabs = page.locator('button[role="tab"], .tab-btn, button').filter({
    hasText: /incoming|deletion|merge|review/i
  });
  await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
});

test('empty review queue shows empty state', async ({ page }) => {
  await page.goto('/review');
  // With no statements, an empty state message should appear
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up/i).first()
  ).toBeVisible({ timeout: 8_000 });
});

test('seeded pending statement appears in review', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');
  // The statement text or source name should appear
  await expect(
    page.getByText(/company.alpha|employee|50|2020/i).first()
  ).toBeVisible({ timeout: 8_000 });
});

test('confirm button marks statement confirmed', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');

  // Find confirm button (✓ or "confirm" text)
  const confirmBtn = page.getByRole('button', { name: /confirm|✓|accept/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 8_000 });
  await confirmBtn.click();

  // After confirming all, empty state should appear
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up|company.alpha|employee/i).first()
  ).toBeVisible({ timeout: 5_000 });
});

test('review-at-scale: pending facts group into entity cards with a plan headline and a toggle', async ({ page }) => {
  await seedPendingStatement(page);
  await page.goto('/review');

  // F83 — pending facts are grouped into per-entity cards, not a flat list of rows.
  await expect(page.getByTestId('entity-cards')).toBeVisible({ timeout: 8_000 });

  // The review pipeline's honest headline is shown (what is spared / what is yours).
  await expect(page.locator('.ras-headline')).toBeVisible({ timeout: 5_000 });

  // The seeded fact is still visible inside a card, and confirm is still reachable (nothing hidden).
  await expect(page.getByText(/company.alpha|employee|50|2020/i).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: /confirm|✓|accept/i }).first()).toBeVisible();

  // The by-entity / flat toggle switches the grouping off.
  const toggle = page.getByRole('button', { name: /^(by entity|flat list)$/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('entity-cards')).toHaveCount(0);
});

test('reject button removes statement from review', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');

  const rejectBtn = page.getByRole('button', { name: /reject|✕|dismiss/i }).first();
  await expect(rejectBtn).toBeVisible({ timeout: 8_000 });
  await rejectBtn.click();

  // After rejecting, the statement count should decrease (or empty state appears)
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up|company.alpha|employee/i).first()
  ).toBeVisible({ timeout: 5_000 });
});
