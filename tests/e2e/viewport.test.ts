import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Viewport & device tests — verify the UI adapts correctly across screen sizes.
 *
 * Runs against all device projects defined in playwright.config.ts:
 *   desktop-chrome, desktop-firefox, desktop-safari,
 *   mobile-android, mobile-ios, tablet
 *
 * Feature flags:
 *   @chromium-only — skipped on Firefox and WebKit (feature not available)
 *   @touch          — extra assertions for touch device form factors
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when the current project is a Chromium-based browser. */
function isChromium(page: Page): boolean {
  return page.context().browser()?.browserType().name() === 'chromium';
}

/** True when the current project is a mobile or tablet device (touch). */
function isTouchDevice(page: Page): boolean {
  const name = (page as any)._browserContext?._options?.isMobile ?? false;
  // Use viewport width as a proxy — mobile projects set width < 768
  return page.viewportSize()?.width !== undefined && (page.viewportSize()!.width < 800);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }, testInfo) => {
  // The load-budget case must begin from the fixture's untouched about:blank page. Navigating here
  // first warms the HTTP/module cache and turns a claimed first-load measurement into a reload.
  if (testInfo.title === 'app loads within 5 seconds on simulated slow connection') return;
  await clearStorage(page);
  await waitForApp(page);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('nav is accessible on all screen sizes', async ({ page }) => {
  await page.goto('/');

  // Nav must be present — may be a hamburger menu on small screens but still in DOM
  await expect(page.locator('nav')).toBeAttached({ timeout: 10_000 });

  // At least one nav link must be reachable (either visible or inside open menu)
  const navLinks = page.locator('nav a[href]');
  await expect(navLinks.first()).toBeAttached({ timeout: 5_000 });
});

test('ingest form is usable on all screen sizes', async ({ page }) => {
  await page.goto('/ingest');

  // Title input must be visible and fillable
  const titleInput = page.getByPlaceholder(/what is this about/i).first();
  await expect(titleInput).toBeVisible({ timeout: 8_000 });
  await titleInput.fill('Viewport test note');

  // Body textarea must be visible
  const bodyInput = page.locator('textarea').first();
  await expect(bodyInput).toBeVisible();
  await bodyInput.fill('A note to test form usability across device sizes.');

  // Submit button must be accessible
  const submitBtn = page.getByRole('button', { name: /extract facts/i });
  await expect(submitBtn).not.toBeDisabled({ timeout: 5_000 });
});

test('review page renders without horizontal overflow', async ({ page }) => {
  await page.goto('/review');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });

  // Check no horizontal scroll — body width should not exceed viewport
  const overflows = await page.evaluate(() => {
    return document.body.scrollWidth > window.innerWidth;
  });
  expect(overflows).toBe(false);
});

test('settings page renders without horizontal overflow', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('h1, h2, section').first()).toBeVisible({ timeout: 8_000 });

  const overflows = await page.evaluate(() => {
    return document.body.scrollWidth > window.innerWidth;
  });
  expect(overflows).toBe(false);
});

test('reckoning page loads on all screen sizes', async ({ page }) => {
  await page.goto('/reckoning');

  // Page must render — heading, textarea, or form element
  await expect(
    page.locator('h1, h2, textarea, input[type="text"]').first()
  ).toBeVisible({ timeout: 10_000 });

  // No uncaught exception overlay
  await expect(page.getByText(/unhandled.*exception/i)).not.toBeVisible();
});

test('touch targets are large enough on mobile viewports', async ({ page }) => {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width >= 800) {
    // Skip on desktop viewports — this check is only meaningful on mobile
    test.skip();
    return;
  }

  await page.goto('/ingest');

  // Every visible button and navigation link should have a 44×44px tap target.
  // This is a regression gate, not a diagnostic: icon-only controls need a
  // comfortable hit area just as much as labelled controls do.
  const tooSmall = await page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>(
      'button:not([hidden]), nav[aria-label="Main navigation"] a[href]'
    ));
    return targets
      .filter(target => {
        const r = target.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      })
      .map(target => {
        const r = target.getBoundingClientRect();
        return {
          name: target.getAttribute('aria-label') || target.innerText?.trim().slice(0, 30),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });
  });

  expect(tooSmall, `Undersized mobile targets: ${JSON.stringify(tooSmall)}`).toEqual([]);
});

test('File System Access API availability is handled gracefully', async ({ page }) => {
  // On non-Chromium browsers the File System Access API is unavailable.
  // The workspace sync feature should silently degrade, not crash the app.
  await page.goto('/settings');

  const fsAvailable = await page.evaluate(() => 'showDirectoryPicker' in window);

  if (!fsAvailable) {
    // No error related to workspace/filesystem should appear
    await expect(page.getByText(/showdirectorypicker|filesystem.*error|workspace.*unavailable/i)).not.toBeVisible();
    // The settings page must still load normally
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });
  }
  // On Chromium the feature IS available — no assertion needed
});

test('app loads within 5 seconds on simulated slow connection', async ({ page }) => {
  // Throttle network to Fast 3G via Chrome DevTools Protocol (Chromium only).
  // On Firefox/WebKit we skip throttling but still measure baseline load time.
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, // bytes/sec
      uploadThroughput: (750 * 1024) / 8,
      latency: 150,
    });
  } catch {
    // CDP not available on Firefox/WebKit — proceed without throttling
  }

  const start = Date.now();
  // The budget is for the usable app shell, not for every deferred image/model asset. Waiting for
  // the browser `load` event here charged unrelated subresources before we even looked for the nav.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('nav').waitFor({ timeout: 15_000 });
  const loadTime = Date.now() - start;

  // App shell (nav) should appear within 5 seconds even on throttled connection
  // This test deliberately bypasses the suite setup, so the context has not loaded or cached the app.
  expect(loadTime).toBeLessThan(5_000);

  console.log(`[viewport] App shell load time on ${page.viewportSize()?.width}px viewport: ${loadTime}ms`);
});
