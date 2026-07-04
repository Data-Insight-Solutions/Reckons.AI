import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp, collectErrors } from './helpers';

/**
 * Smoke tests — verify the app loads cleanly on every route
 * and never throws a JS error on startup.
 */

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
});

test('app loads and shows navigation', async ({ page }) => {
  const errors = collectErrors(page);
  await waitForApp(page);

  // NavBar is present
  await expect(page.locator('nav')).toBeVisible();

  // Core nav links exist. NavBar labels: "add" (ingest), "review", "settings"
  // (terminology sweep renamed ingest -> add; scope to <nav> to avoid picking
  // up unrelated "add" text elsewhere on the page).
  const nav = page.locator('nav');
  await expect(nav.getByRole('link', { name: /^add$/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /review/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /settings/i })).toBeVisible();

  expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
});

test('loading screen does not hang', async ({ page }) => {
  await clearStorage(page);
  await page.goto('/');

  // "loading…" should disappear within 10 s and the nav should appear
  await expect(page.locator('nav')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('loading…')).not.toBeVisible();
});

test('ingest page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/ingest');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });
});

test('review page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/review');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });
});

test('settings page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/settings');
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 8_000 });
});

test('reckoning page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/reckoning');
  await expect(page.locator('h1, h2, .kicker').first()).toBeVisible({ timeout: 8_000 });
});

test('history page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/history');
  await expect(page.locator('h1, h2, .kicker, main').first()).toBeVisible({ timeout: 8_000 });
});

test('compare page loads', async ({ page }) => {
  await waitForApp(page);
  await page.goto('/compare');
  await expect(page.locator('h1, h2, .kicker, main').first()).toBeVisible({ timeout: 8_000 });
});

test('404 does not crash the app', async ({ page }) => {
  const errors = collectErrors(page);
  await waitForApp(page);
  await page.goto('/does-not-exist');
  // Should show SvelteKit 404 or redirect — not a blank crash
  await expect(page.locator('body')).not.toBeEmpty();
  expect(errors.filter(e => !e.includes('favicon') && !e.includes('404'))).toHaveLength(0);
});
