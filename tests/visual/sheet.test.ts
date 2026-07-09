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

  // F36 mobile: the sheet must be dismissable by swiping the grabber/header down
  // (not only via the ✕). Small drags snap back; a drag past the threshold closes.
  test('swipe-down on the grabber dismisses the sheet; a small drag snaps back', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(storyUrl('shell-sheet--open'));
    await page.waitForTimeout(500);

    const drag = page.locator('.sheet-drag');
    await expect(drag).toBeVisible();
    const start = await drag.boundingBox();
    expect(start, 'drag handle should have a box').not.toBeNull();
    const cx = start!.x + start!.width / 2;
    const topY = start!.y + 6;

    // Small drag (20px) — below threshold — must NOT close.
    await page.mouse.move(cx, topY);
    await page.mouse.down();
    await page.mouse.move(cx, topY + 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(page.locator('.sheet-content'), 'small drag should snap back').toBeVisible();

    // Large drag (400px down) — past threshold — must close.
    await page.mouse.move(cx, topY);
    await page.mouse.down();
    await page.mouse.move(cx, topY + 400, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.sheet-content'), 'swipe past threshold should dismiss').toHaveCount(0);
  });
});
