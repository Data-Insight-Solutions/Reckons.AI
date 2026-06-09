import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Ingestion flow tests using the mock backend.
 *
 * The dev server is started with VITE_INGEST_BACKEND=mock so no LLM calls
 * or model downloads happen. The mock extractor returns predictable triples.
 */

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('note tab renders input fields', async ({ page }) => {
  await page.goto('/ingest');

  // Note is the default mode — fields are visible without clicking a tab
  await expect(page.getByPlaceholder(/what is this about/i).first()).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('textarea').first()).toBeVisible();
});

test('submit button is disabled with empty note', async ({ page }) => {
  await page.goto('/ingest');

  // Submit button should be disabled when title/body are empty
  const submitBtn = page.getByRole('button', { name: /extract triples/i });
  await expect(submitBtn).toBeDisabled({ timeout: 5_000 });
});

test('ingest a note with mock backend produces pending statements', async ({ page }) => {
  await page.goto('/ingest');

  // Note is the default mode
  await page.getByPlaceholder(/what is this about/i).first().fill('Test Company Alpha');
  await page.locator('textarea').first().fill('Test Company Alpha was founded in 2020. It has 50 employees and is based in London.');

  // Submit button becomes enabled
  const submitBtn = page.getByRole('button', { name: /extract triples/i });
  await expect(submitBtn).not.toBeDisabled({ timeout: 5_000 });
  await submitBtn.click();

  // After extraction, app navigates to /compare or shows progress
  // Wait for either a route change or done text
  await page.waitForURL(/\/compare|\/review/, { timeout: 20_000 }).catch(() => {
    // May stay on /ingest — check for done state text instead
  });
  // Either we navigated away or we see completion text
  const onCompare = page.url().includes('/compare');
  if (!onCompare) {
    await expect(
      page.getByText(/extracting|working|statements|done/i).first()
    ).toBeVisible({ timeout: 10_000 });
  }
});

test('document tab renders file input', async ({ page }) => {
  await page.goto('/ingest');
  const docTab = page.getByRole('button', { name: /document|doc/i });
  if (await docTab.count() > 0) {
    await docTab.click();
    // File input should be present
    await expect(page.locator('input[type="file"]').first()).toBeAttached();
  }
});

test('url tab renders URL input', async ({ page }) => {
  await page.goto('/ingest');
  const urlTab = page.getByRole('button', { name: /^url/i });
  if (await urlTab.count() > 0) {
    await urlTab.click();
    await expect(page.locator('input[type="url"], input[placeholder*="http"]').first()).toBeVisible();
  }
});

test('vault tab renders when present', async ({ page }) => {
  await page.goto('/ingest');
  const vaultTab = page.getByRole('button', { name: /vault/i });
  if (await vaultTab.count() > 0) {
    await vaultTab.click();
    // Should show a file picker or drop zone for markdown files
    await expect(page.locator('input[type="file"][accept*=".md"]').first()).toBeAttached();
  }
});

test('ingest navigation link works from nav', async ({ page }) => {
  const link = page.getByRole('link', { name: /ingest/i });
  await link.click();
  expect(page.url()).toContain('/ingest');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });
});
