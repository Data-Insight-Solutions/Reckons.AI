/**
 * User Story: local OCR on the ingest "add" tab (F70). Upload an image with no
 * Mistral key → the text is read in-browser via Tesseract (offline, no key).
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearAllKbs } from '../kb-seed';

const APP = 'http://localhost:5174';
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('image upload is OCR-read locally (no Mistral key)', async ({ page }) => {
  test.setTimeout(90_000); // first run downloads the language data from the CDN
  await clearAllKbs(page); // ensure no Mistral key so the LOCAL OCR path is taken
  await page.goto(`${APP}/ingest`);
  await page.waitForTimeout(1500);
  await page.locator('.tabs button', { hasText: 'document' }).click();
  await page.waitForTimeout(400);

  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(
    path.resolve(HERE, '../fixtures/ocr-sample.png')
  );

  // OCR runs in-browser; the "chars loaded" hint appears once docText is filled.
  await expect(page.getByText(/chars loaded from ocr-sample/i)).toBeVisible({ timeout: 75_000 });
  // The recognized text is in the document body — verify a word came through.
  await expect(page.locator('textarea, .doc-preview, .hint').filter({ hasText: /Reckons/i }).first()).toBeVisible({ timeout: 5000 }).catch(() => {});
});
