import { test, expect } from '@playwright/test';

// Also run by the minified-build smoke gate: this route owns a second database while the active
// graph remains open, so its startup and live queries must survive bundling as well as dev imports.
test('personal inbox survives reload and sends a reviewed copy in the built app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/notes');
  await expect(page.getByRole('heading', { name: 'Personal Notes', exact: true })).toBeVisible();
  await page.getByLabel('What’s on your mind?').fill('A project thought.\nA private aside.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByLabel('Text to send')).toHaveValue('A project thought.\nA private aside.');
  await page.reload();
  await expect(page.getByLabel('Text to send')).toHaveValue('A project thought.\nA private aside.');
  await page.locator('.permissions > summary').click();
  await page.getByLabel('Default Graph', { exact: true }).check();
  await page.getByLabel('Destination graph').selectOption('kbase');
  await page.getByLabel('Text to send').fill('A project thought.');
  await page.getByRole('button', { name: 'Approve and send copy' }).click();
  await expect(page.getByRole('status')).toContainText('Copied to Default Graph');
  await expect(page.locator('.history')).toContainText('Copied');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

/*
 * WHERE THE INBOX LIVES IS A DECISION, SO IT IS ASSERTED AS ONE.
 *
 * This file previously ended by requiring a top-level `notes` link in the navigation. Matt removed
 * that tab on 2026-09-16 — writing a note and keeping notes are the same errand, and /ingest
 * already defaults to mode 'note', so a second tab made the product ask a first-time user to learn
 * two answers to "where do I write something down". The assertion outlived the design and went on
 * demanding the tab back; nothing caught it because the branch was never committed, so CI never ran
 * it until 2026-09-17.
 *
 * Both halves are asserted deliberately. The presence check alone would still pass if somebody
 * re-added the tab, which is the exact thing that was decided against.
 */
test('the notes inbox is reached from the Add page, and is not a tab of its own', async ({ page }) => {
  await page.goto('/ingest');
  await expect(page.getByText('Your notes inbox', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'notes', exact: true })).toHaveCount(0);
});
