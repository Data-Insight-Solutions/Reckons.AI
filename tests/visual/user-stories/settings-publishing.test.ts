/**
 * User Story: Publishing settings tab (F69). The Semantic Web & LLM Search
 * export (JSON-LD + llms.txt) moved off the backends page into its own tab.
 */
import { test, expect } from '@playwright/test';
import { screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

test('Publishing tab hosts the Semantic Web & LLM Search export', async ({ page }) => {
  await page.goto(`${APP}/settings/publishing`);
  await page.waitForTimeout(1200);
  await expect(page.getByRole('heading', { name: /semantic web.*llm search/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /\.jsonld/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /llms\.txt/i })).toBeVisible();
  await expect(page.locator('.nav-link.active')).toHaveText(/publishing/i);
  await screenshotTo(page, 'settings-publishing', '01-publishing-tab');

  // It's no longer on the backends page.
  await page.goto(`${APP}/settings`);
  await page.waitForTimeout(1000);
  await expect(page.getByRole('heading', { name: /semantic web.*llm search/i })).toHaveCount(0);
  await expect(page.locator('.settings-nav a', { hasText: 'publishing' })).toBeVisible();
});
