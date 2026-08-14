import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * LLM config Quick Setup (Matt: "configuration of the LLM seems painfully difficult").
 * The old settings showed ~8 per-task backend dropdowns up front. The simple path is now one
 * control — "use one model for everything" — with an honest readiness line, and the per-task grid
 * moved behind an Advanced disclosure.
 */

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('Quick Setup is the simple path; the per-task grid is behind Advanced', async ({ page }) => {
  await page.goto('/settings');

  // The quick-setup card is present and the per-task grid is collapsed by default.
  const quick = page.locator('.quick-setup');
  await expect(quick).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('.quick-status')).toBeVisible();
  const advanced = page.locator('.advanced-backends');
  expect(await advanced.evaluate((el) => el.hasAttribute('open'))).toBe(false);
});

test('picking one backend applies it to every task, and the status reflects key readiness', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('.quick-setup')).toBeVisible({ timeout: 8_000 });

  // Pick a cloud provider via the quick-setup dropdown (bits-ui Select: click trigger, then option).
  await page.locator('.quick-setup .ui-select-trigger').click();
  await page.getByRole('option', { name: /^Claude/i }).first().click();

  // The status line recomputes for the chosen backend — either it's ready (key present) or it names
  // the missing key. Both are honest; it must not stay silent.
  await expect(page.locator('.quick-status')).toContainText(/ready|needs an API key/i, { timeout: 5_000 });

  // "One model for everything" really propagated: open Advanced and the ingest task now inherits it.
  await page.locator('.advanced-backends > summary').click();
  const ingestTrigger = page.locator('.task-row', { hasText: /extraction/i }).locator('.ui-select-trigger').first();
  await expect(ingestTrigger).toContainText(/claude/i, { timeout: 5_000 });
});
