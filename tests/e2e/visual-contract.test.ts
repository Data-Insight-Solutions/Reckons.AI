import { test, expect, type Page } from '@playwright/test';

type RuntimeErrors = {
  page: string[];
  console: string[];
};

function collectRuntimeErrors(page: Page): RuntimeErrors {
  const errors: RuntimeErrors = { page: [], console: [] };
  page.on('pageerror', (error) => {
    errors.page.push(`${error.message}\n${error.stack ?? ''}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  return errors;
}

test('Pixel 7 renders a populated Facts ingest state without layout or runtime errors', async ({
  page,
}, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page);

  await page.goto('/ingest');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'facts ✎', exact: true }).click();

  await page.locator('input[placeholder="name for this set of notes"]').fill('Trip logistics');
  await page.getByLabel('Fact 1 subject').fill('weekend-trip');
  await page.getByLabel('Fact 1 predicate').fill('check-in');
  await page.getByLabel('Fact 1 object').fill('2026-07-10');

  const device = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    screenWidth: screen.width,
    screenHeight: screen.height,
    pixelRatio: devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    noHover: matchMedia('(hover: none)').matches,
    userAgent: navigator.userAgent,
  }));
  expect(device.width).toBe(412);
  expect(device.height).toBe(839);
  expect(device.screenWidth).toBe(412);
  // Chromium normalizes screen.height to the emulated visual viewport, while
  // Playwright's Pixel descriptor retains the physical 412×915 screen metadata.
  expect(device.screenHeight).toBe(device.height);
  expect(device.pixelRatio).toBe(2.625);
  expect(device.touchPoints).toBeGreaterThan(0);
  expect(device.coarsePointer).toBe(true);
  expect(device.noHover).toBe(true);
  expect(device.userAgent).toContain('Pixel 7');

  const addToGraph = page.getByRole('button', { name: 'add to graph →' });
  await addToGraph.scrollIntoViewIfNeeded();
  await expect(addToGraph).toBeEnabled();

  const audit = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]');
    const action = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim().toLowerCase() === 'add to graph →');
    const fields = [...document.querySelectorAll<HTMLInputElement>('.triple-entry input')];
    const navBox = nav?.getBoundingClientRect();
    const actionBox = action?.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    return {
      overflow: document.documentElement.scrollWidth > viewportWidth + 1,
      fieldCount: fields.length,
      fieldsWithinViewport: fields.every((field) => {
        const box = field.getBoundingClientRect();
        return box.left >= -1 && box.right <= viewportWidth + 1;
      }),
      actionAboveNavigation:
        !!navBox && !!actionBox && actionBox.bottom <= navBox.top + 1,
      actionHeight: actionBox?.height ?? 0,
    };
  });

  expect(audit).toEqual({
    overflow: false,
    fieldCount: 3,
    fieldsWithinViewport: true,
    actionAboveNavigation: true,
    actionHeight: expect.any(Number),
  });
  expect(audit.actionHeight).toBeGreaterThanOrEqual(44);

  const screenshot = await page.screenshot({ fullPage: false });
  await testInfo.attach('pixel-7-populated-facts', {
    body: screenshot,
    contentType: 'image/png',
  });

  await page.waitForTimeout(500);
  expect(runtimeErrors.page, `Uncaught page errors:\n${runtimeErrors.page.join('\n---\n')}`)
    .toHaveLength(0);
  expect(runtimeErrors.console, `Console errors:\n${runtimeErrors.console.join('\n---\n')}`)
    .toHaveLength(0);
});
