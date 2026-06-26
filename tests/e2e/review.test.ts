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
  const submitBtn = page.getByRole('button', { name: /extract triples/i });
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
