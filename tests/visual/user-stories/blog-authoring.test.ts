/**
 * VISUAL verification of the blog authoring workflow (F27, /publish).
 *
 * Functional behaviour is covered by `tests/e2e/blog-authoring.test.ts` (10 tests) and the pure
 * core by 24 unit tests. This file exists for what those cannot settle, and the track record in
 * this repo justifies it: on three consecutive pieces of work a bug passed every assertion and
 * was caught only by looking — a caution rendered in brand teal, a button spanning a mobile row,
 * and a destructive action that read as a hyperlink.
 *
 * What it checks, at the widths where those failed:
 *   1. the editor and its preview do not collapse into each other or overflow the page;
 *   2. the honest build-boundary notice is actually VISIBLE, not merely present in the DOM —
 *      a warning scrolled off or clipped to zero height satisfies `toContainText` and warns
 *      nobody;
 *   3. the F36 44px touch minimum on every control in the form.
 *
 * The screenshots in tests/visual/screenshots/blog-authoring/ are the point; the assertions are
 * only the parts a machine can settle.
 */
import { test, expect, type Page } from '@playwright/test';

const APP = 'http://localhost:5174';
const SHOTS = 'tests/visual/screenshots/blog-authoring';
const TOUCH_MIN = 44;

async function fillPost(page: Page): Promise<void> {
  await page.goto(`${APP}/publish`);
  await page.getByTestId('post-title').waitFor({ timeout: 20_000 });
  await page.getByTestId('post-title').fill('Shipping the Archive Sweep');
  await page.getByTestId('post-section').fill('Blog');
  await page.getByTestId('post-date').fill('2026-07-30');
  await page.getByTestId('post-excerpt').fill('How F97 finally got an entry point.');
  await page.getByTestId('post-body').fill(
    '# Shipping\n\nThe storage layer existed for weeks with no caller.\n\n'
    + 'A long line to prove wide content scrolls inside its own box rather than widening the page: '
    + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  await expect(page.getByTestId('preview-markdown')).toContainText('template: post');
}

/** Horizontal overflow of the document — a page must never scroll sideways. */
async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('Blog authoring — visual', () => {
  test('desktop: editor and preview sit side by side, neither overflowing', async ({ page }) => {
    await fillPost(page);
    await page.screenshot({ path: `${SHOTS}/desktop-editor.png`, fullPage: false });

    const editor = (await page.locator('.editor').boundingBox())!;
    const preview = (await page.locator('.preview').boundingBox())!;
    // Two columns, not one stacked on the other.
    expect(preview.x).toBeGreaterThan(editor.x + editor.width - 1);

    // The long body line must scroll INSIDE the preview box, not widen the document.
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
    const scrolls = await page.locator('.preview-md').evaluate(
      (el) => el.scrollWidth > el.clientWidth,
    );
    expect(scrolls, 'wide preview content should scroll in its own box').toBe(true);
  });

  test('the form fields are themed, not the browser default white', async ({ page }) => {
    // REGRESSION, found by looking at the first screenshot. global.css styles fields via
    // `input[type='text'], …` — an ATTRIBUTE selector that does not match an input whose type is
    // merely the HTML default. The fields rendered with the browser's white fill inside a dark
    // app, with near-invisible placeholder text, and every functional assertion passed.
    await fillPost(page);

    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const bodyLuma = luminance(body);

    for (const id of ['post-title', 'post-section', 'post-slug', 'post-excerpt']) {
      const bg = await page.getByTestId(id).evaluate((el) => getComputedStyle(el).backgroundColor);
      // The field must sit in the same tonal world as the page, not invert it.
      expect(Math.abs(luminance(bg) - bodyLuma), `${id} background ${bg} fights the page ${body}`)
        .toBeLessThan(0.4);
    }

    /** Rough relative luminance of an `rgb(...)`/`rgba(...)` string, 0..1. */
    function luminance(color: string): number {
      const [r, g, b] = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
  });

  test('the build-boundary notice is genuinely visible, not just in the DOM', async ({ page }) => {
    await fillPost(page);
    const notice = page.getByTestId('publish-boundary');

    // toContainText passes on a zero-height or clipped element. A warning nobody can read is
    // the overclaim kb:honest-status exists to prevent, dressed as compliance.
    await expect(notice).toBeInViewport();
    const box = (await notice.boundingBox())!;
    expect(box.height).toBeGreaterThan(10);
    expect(box.width).toBeGreaterThan(100);
  });

  test('phone: the form stacks, stays on-screen, and meets the touch minimum', async ({ page }) => {
    // 412×915 — the Pixel width the button-crawler measures, where the gallery's grid bug lived.
    await page.setViewportSize({ width: 412, height: 915 });
    await fillPost(page);
    await page.screenshot({ path: `${SHOTS}/phone-editor.png`, fullPage: false });

    const editor = (await page.locator('.editor').boundingBox())!;
    const preview = (await page.locator('.preview').boundingBox())!;
    // Stacked, not squeezed into two unreadable columns.
    expect(preview.y).toBeGreaterThan(editor.y);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    for (const id of ['post-title', 'post-section', 'post-date', 'post-slug', 'post-excerpt', 'post-status', 'post-save', 'post-export']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} is under the ${TOUCH_MIN}px touch minimum`)
        .toBeGreaterThanOrEqual(TOUCH_MIN);
    }
  });

  test('an invalid draft shows its objections and disables the save', async ({ page }) => {
    await page.goto(`${APP}/publish`);
    await page.getByTestId('post-title').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/desktop-empty.png`, fullPage: false });

    await expect(page.getByTestId('post-problems')).toBeVisible();
    await expect(page.getByTestId('post-save')).toBeDisabled();
    // The empty state must explain itself rather than showing a blank panel.
    await expect(page.getByTestId('preview-empty')).toBeVisible();
  });
});
