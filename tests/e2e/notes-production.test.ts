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
  await expect(page.getByRole('navigation').getByRole('link', { name: 'notes', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
