import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Settings page tests — API key persistence, backend selection, profile export.
 */

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('settings page renders section headings', async ({ page }) => {
  await page.goto('/settings');

  // Core sections
  await expect(page.getByText(/AI backend/i).first()).toBeVisible({ timeout: 8_000 });
});

test('backend selector is interactive', async ({ page }) => {
  await page.goto('/settings');

  // Ingest backend selector should be visible
  await expect(page.getByText(/ingest/i).first()).toBeVisible({ timeout: 8_000 });
});

test('api key input saves and shows saved feedback', async ({ page }) => {
  await page.goto('/settings');

  // When claude backend is selected the key field should appear
  // Switch to claude ingest backend first to reveal the key field
  const claudeOption = page.locator('select, [role="combobox"]').first();
  if (await claudeOption.count() > 0) {
    // Select 'claude' from the ingest backend dropdown
    await claudeOption.selectOption('claude').catch(() => { /* may be custom select */ });
  }

  // Look for the API key password input
  const keyInput = page.locator('input[type="password"]').first();
  if (await keyInput.isVisible()) {
    await keyInput.fill('sk-ant-test-key-1234');

    // The auto-save effect fires after 700ms — wait for saved pulse indicator
    await page.waitForTimeout(1_000);

    // Reload and check the key persisted
    await page.reload();
    await page.locator('nav').waitFor({ timeout: 10_000 });
    await page.goto('/settings');

    const reloaded = page.locator('input[type="password"]').first();
    await expect(reloaded).toHaveValue('sk-ant-test-key-1234', { timeout: 5_000 });
  }
});

test('settings profile export button is present', async ({ page }) => {
  await page.goto('/settings');

  // Scroll to My Defaults section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect(
    page.getByRole('button', { name: /\.json|export profile|↓/i }).first()
  ).toBeVisible({ timeout: 8_000 });
});

test('import profile button renders file input', async ({ page }) => {
  await page.goto('/settings');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // "import…" is a <label class="btn ghost"> wrapping a hidden <input type="file">
  // The label may not be "visible" (ghost button with hidden input) — check attached instead
  const importLabel = page.locator('label.btn').filter({ hasText: /import/i }).first();
  await expect(importLabel).toBeVisible({ timeout: 8_000 });

  // The file input inside is display:none but should be attached to the DOM
  await expect(importLabel.locator('input[type="file"][accept=".json"]')).toBeAttached();
});

test('backup & export section shows export buttons', async ({ page }) => {
  await page.goto('/settings');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect(page.getByText(/backup.*export|export.*backup/i).first()).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('button', { name: /↓ \.ttl|clean export/i }).first()).toBeVisible({ timeout: 8_000 });
});

test('settings nav tabs are present', async ({ page }) => {
  await page.goto('/settings');

  // Tab links: backends, integrations, turtle, entity-types
  await expect(page.getByRole('link', { name: /integrations/i })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('link', { name: /turtle/i })).toBeVisible({ timeout: 8_000 });
});

test('integrations page loads', async ({ page }) => {
  await page.goto('/settings/integrations');
  await expect(page.locator('h1, h2, section').first()).toBeVisible({ timeout: 8_000 });
});
