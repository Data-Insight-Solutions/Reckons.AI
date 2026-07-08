/**
 * Visual test — Sheet (F36 mobile bottom-sheet primitive).
 *
 * Renders the Storybook story in a phone viewport and checks the chrome plus
 * the >= 44px close target (kb:web-uiux-rubric → touch-targets guideline).
 * Runs against Storybook (auto-started by playwright.visual.config webServer).
 */
import { test, expect } from '@playwright/test';
import { analyzePixels } from './vision-local';

const STORYBOOK = 'http://localhost:6006';
const storyUrl = (id: string) => `${STORYBOOK}/iframe.html?id=${id}&viewMode=story`;

test.describe('Sheet (mobile bottom-sheet)', () => {
  test('renders title, no blank fill, >=44px close target', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone-ish
    await page.goto(storyUrl('shell-sheet--open'));
    await page.waitForTimeout(500);

    // Sheet chrome is present (title + close button).
    await expect(page.locator('.sheet-title')).toHaveText('Panel title');
    const close = page.locator('.sheet-close');
    await expect(close).toBeVisible();

    // No blank screen / solid-fill artifact.
    const pixel = await analyzePixels(await page.screenshot());
    expect(pixel.isSolidFill, `Solid fill: ${pixel.dominantColor}`).toBe(false);

    // Touch-target rubric: close control must be at least 44x44.
    const box = await close.boundingBox();
    expect(box, 'close button should have a box').not.toBeNull();
    expect(box!.width, 'close width').toBeGreaterThanOrEqual(44);
    expect(box!.height, 'close height').toBeGreaterThanOrEqual(44);
  });
});
