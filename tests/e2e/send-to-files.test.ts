import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { clearStorage, waitForApp } from './helpers';

/**
 * Device sync without an account (2026-09-30). On a phone the button opens the share sheet; on a
 * desktop browser without one it downloads. Either way the file must be the FULL space, carrying
 * its stable id — that id is what makes "+ add → space file" on the other device update the space
 * instead of duplicating it.
 */
test('the Spaces page offers a full copy for another device, with the space\'s stable id', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/kb');
  const button = page.getByRole('button', { name: /full copy for another device|send to files or phone/i });
  await expect(button).toBeVisible({ timeout: 10_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toMatch(/\.ttl$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toContain('kbStableId');
  await expect(page.getByText(/\+ add → space file/i).first()).toBeVisible();
});
