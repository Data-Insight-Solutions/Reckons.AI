import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Closing one notice closes one notice (Matt, 2026-11-26: "I closed a notification, and all of them closed?"). On a
 * page where the tray folds into the bell, an important notice holds it open; closing that one must not fold the
 * tray and hide the others.
 */
test('closing an important notice leaves the other notices showing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.goto('/review');
  await page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { pushNotification } = await runtimeImport('/src/lib/stores/notifications.svelte.ts');
    pushNotification({ id: 'test-a', type: 'info', title: 'First ordinary notice', body: 'a' });
    pushNotification({ id: 'test-b', type: 'info', title: 'Second ordinary notice', body: 'b' });
    pushNotification({ id: 'test-imp', type: 'warn', important: true, title: 'An important notice', body: 'c' });
  });
  await expect(page.getByText('An important notice')).toBeVisible();
  await expect(page.getByText('First ordinary notice')).toBeVisible();
  const important = page.locator('.notification', { hasText: 'An important notice' });
  await important.getByRole('button', { name: 'dismiss' }).click();
  await expect(page.getByText('An important notice')).toHaveCount(0);
  await expect(page.getByText('First ordinary notice')).toBeVisible();
  await expect(page.getByText('Second ordinary notice')).toBeVisible();
});
