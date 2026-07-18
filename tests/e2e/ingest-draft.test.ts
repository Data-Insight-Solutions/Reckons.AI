import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Crash-safe ingest draft (Matt's prod report, 2026-07-17): loading the local WASM model during
 * extraction can OOM-crash the tab (esp. iOS Safari/WebKit — "the note disappears after refresh").
 * The typed note must survive a reload and be restored, and must be cleared once it's safely
 * extracted into the graph.
 */

async function fillNote(page: Page, title: string, body: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(body);
  await page.waitForTimeout(400); // let the persist effect run
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('a typed note survives a reload (crash-safe draft)', async ({ page }) => {
  await fillNote(page, 'My important note', 'Body that must survive a crash.');

  // Simulate the crash + reload: navigate away and back to /ingest without submitting.
  await page.goto('/');
  await page.goto('/ingest');

  await expect(page.getByPlaceholder(/what is this about/i).first()).toHaveValue('My important note');
  await expect(page.locator('textarea').first()).toHaveValue('Body that must survive a crash.');
});

test('the draft is cleared once the note is extracted', async ({ page }) => {
  await fillNote(page, 'Note to extract', 'This becomes facts.');

  await page.getByRole('button', { name: /extract facts/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/ingest'), { timeout: 30_000 });

  // Back on /ingest, the fields must be empty — the draft was cleared on success.
  await page.goto('/ingest');
  await page.waitForTimeout(600);
  await expect(page.getByPlaceholder(/what is this about/i).first()).toHaveValue('');
});
