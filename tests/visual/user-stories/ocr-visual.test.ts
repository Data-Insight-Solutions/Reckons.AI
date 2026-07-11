/**
 * User Story: OCR in visual testing (F70.1). Assert the actual RENDERED text on
 * a screenshot via local Tesseract OCR — stronger than "does an element exist".
 */
import { test, expect } from '@playwright/test';
import { ocrScreenshot, normalizeOcr } from '../vision-local';

const APP = 'http://localhost:5174';

test('OCR reads the rendered text off the Publishing settings tab', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP}/settings/publishing`);
  // Wait for the content to render before screenshotting (else OCR reads a
  // half-loaded page).
  await expect(page.getByRole('heading', { name: /semantic web.*llm search/i })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const shot = await page.screenshot();

  // Assert the body paragraph, which OCRs reliably (stylized display fonts + tiny
  // nav text are noisier, so we avoid asserting those exactly).
  const text = normalizeOcr(await ocrScreenshot(shot));
  expect(text).toContain('understand your content');
  expect(text).toContain('llm search');
  expect(text).toContain('schema org');
});
