/**
 * User Story: front-end contact form (n8n web-integration use case, F20).
 *
 * The About page carries a contact form. With an n8n instance configured it
 * POSTs to /webhook/reckons-contact; with none (the test's default) it degrades
 * to a mailto link so it always works. This verifies the form renders and the
 * graceful fallback shows.
 *
 * Screenshots: tests/visual/screenshots/contact-form/
 */
import { test, expect } from '@playwright/test';
import { screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

test('contact form renders on the About page (mailto fallback when no n8n)', async ({ page }) => {
  await page.goto(`${APP}/about`);
  await page.waitForTimeout(1500);

  const section = page.locator('.contact-section');
  await section.scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: /get in touch/i })).toBeVisible();
  await expect(section.locator('input[placeholder="your name"]')).toBeVisible();
  await expect(section.locator('input[type="email"]')).toBeVisible();
  await expect(section.locator('textarea')).toBeVisible();

  // No n8n configured on :5174 → the mailto fallback + hint are shown.
  await expect(section.getByText(/send via email/i)).toBeVisible();
  await expect(section.locator('.cf-hint')).toContainText(/Settings.*Integrations/i);

  await screenshotTo(page, 'contact-form', '01-about-contact-form');
});
