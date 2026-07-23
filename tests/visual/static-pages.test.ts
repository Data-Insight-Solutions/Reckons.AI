/**
 * Static page visuals — About footer DIS branding + prerendered /docs site.
 *
 * Checks:
 *   1. About page footer renders the animated DIS synapse lockup
 *      (static/svg/dis-synapse.svg) with name + tagline and the credit line
 *   2. Case study page carries the DIS credit mark in its footer
 *   3. /docs index lists sections with the release post (dated)
 *   4. /docs/releases/v0-1-0 post renders with sidebar nav and date
 *
 * Screenshots saved to: tests/visual/screenshots/static-pages/
 */

import { test, expect } from '@playwright/test';
import { analyzePixels, analyzeText } from './vision-local';
import { screenshotTo } from './kb-seed';

const APP = 'http://localhost:5174';

test.describe('About page — DIS branding', () => {
  test('footer shows the DIS synapse lockup', async ({ page }) => {
    await page.goto(`${APP}/about`);
    await page.waitForTimeout(1500);

    const lockup = page.locator('.dis-lockup');
    await lockup.scrollIntoViewIfNeeded();
    await expect(lockup).toBeVisible();

    // Animated synapse mark + lockup text
    const mark = page.locator('.dis-mark');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute('src', '/svg/dis-synapse.svg');
    await expect(page.locator('.dis-name')).toContainText('Data Insight Solutions');
    await expect(page.locator('.dis-tagline')).toContainText('Collect · Integrate · Display');

    // Credit line links to the DIS site
    const credit = page.locator('.footer-credit a').first();
    await expect(credit).toHaveAttribute('href', /data-insight\.solutions/);

    await page.waitForTimeout(500);
    await screenshotTo(page, 'static-pages', '01-about-dis-footer');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
    expect(pixel.hasColorAnomaly).toBe(false);
  });

  test('case study footer carries the DIS credit mark', async ({ page }) => {
    await page.goto(`${APP}/about/case-study-0`);
    await page.waitForTimeout(1500);

    const footer = page.locator('.article-footer');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(footer.locator('img[src*="dis-synapse"]')).toBeVisible();

    const text = await analyzeText(page, ['Data Insight Solutions']);
    expect(text.expectedMissing).toHaveLength(0);

    await screenshotTo(page, 'static-pages', '02-case-study-dis-credit');
  });
});

test.describe('Prerendered /docs site', () => {
  test('docs index lists sections and the release post', async ({ page }) => {
    await page.goto(`${APP}/docs`);
    await page.waitForLoadState('networkidle');

    // Shell chrome: header brand + sidebar nav
    await expect(page.locator('.docs-header .docs-brand')).toBeVisible();
    await expect(page.locator('.docs-nav')).toBeVisible();

    // Index content
    await expect(page.locator('h1', { hasText: 'Docs' })).toBeVisible();
    expect(await page.locator('.index-section').count()).toBeGreaterThan(0);

    // The release post is listed with its date
    const releaseLink = page.locator('a[href="/docs/releases/v0-1-0"]').first();
    await releaseLink.scrollIntoViewIfNeeded();
    await expect(releaseLink).toBeVisible();
    const text = await analyzeText(page, ['Releases', '2026-07-01']);
    expect(text.expectedMissing).toHaveLength(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshotTo(page, 'static-pages', '03-docs-index');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
  });

  test('release post v0-1-0 renders with sidebar and date', async ({ page }) => {
    await page.goto(`${APP}/docs/releases/v0-1-0`);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h1', { hasText: 'Reckons.AI v0.1.0' }).first()).toBeVisible();
    await expect(page.locator('.docs-nav')).toBeVisible();

    // Post template shows its date; body mentions the headline features
    const text = await analyzeText(page, ['2026-07-01', 'Local-first', 'Highlights']);
    expect(text.expectedMissing).toHaveLength(0);

    await screenshotTo(page, 'static-pages', '04-docs-release-post');

    const screenshot = await page.screenshot();
    const pixel = await analyzePixels(screenshot);
    expect(pixel.isSolidFill).toBe(false);
  });

  test('docs pages have no horizontal overflow', async ({ page }) => {
    for (const url of ['/docs', '/docs/releases/v0-1-0']) {
      await page.goto(`${APP}${url}`);
      await page.waitForLoadState('networkidle');
      const overflows = await page.evaluate(() =>
        document.body.scrollWidth > window.innerWidth + 5
      );
      expect(overflows, `Horizontal overflow on ${url}`).toBe(false);
    }
  });
});
