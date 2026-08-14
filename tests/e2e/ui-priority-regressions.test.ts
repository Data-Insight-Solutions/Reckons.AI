import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Focused UI regressions from the 2026-07 mobile/visual review.
 *
 * These are deterministic DOM/layout assertions; screenshots are attached for
 * human review without committing generated images. The default CI run covers
 * desktop, while `npm run test:e2e:mobile -- ui-priority-regressions` exercises
 * the complete Pixel/iPhone/tablet device projects locally.
 */

async function attachViewport(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
}

function isPhoneProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'mobile-android' || testInfo.project.name === 'mobile-ios';
}

test('manual Facts inputs retain readable dark-theme styling', async ({ page }, testInfo) => {
  await page.goto('/ingest');
  await page.getByRole('button', { name: 'facts ✎', exact: true }).click();

  const fields = [
    page.getByLabel('Fact 1 subject'),
    page.getByLabel('Fact 1 predicate'),
    page.getByLabel('Fact 1 object'),
  ];
  await fields[0].fill('weekend-trip');
  await fields[1].fill('check-in');
  await fields[2].fill('2026-07-10');

  const appearance = await Promise.all(fields.map((field) => field.evaluate((input) => {
    const style = getComputedStyle(input);
    const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value: string) => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    return {
      type: input.getAttribute('type'),
      background: style.backgroundColor,
      contrast,
    };
  })));

  for (const fieldAppearance of appearance) {
    expect(fieldAppearance.type).toBe('text');
    expect(fieldAppearance.background).not.toBe('rgb(255, 255, 255)');
    expect(fieldAppearance.contrast).toBeGreaterThanOrEqual(4.5);
  }
  await attachViewport(page, testInfo, 'manual-facts-readable');
});

test('Docs keeps content ahead of a compact mobile navigation disclosure', async ({ page }, testInfo) => {
  await page.goto('/docs');

  const mobileNavigation = page.locator('.docs-mobile-nav');
  const desktopNavigation = page.locator('.docs-nav');
  const content = page.locator('.docs-main');

  if (isPhoneProject(testInfo)) {
    await expect(mobileNavigation).toBeVisible();
    await expect(mobileNavigation).not.toHaveAttribute('open', '');
    await expect(desktopNavigation).toBeHidden();

    const [contentBox, summaryBox] = await Promise.all([
      content.boundingBox(),
      mobileNavigation.locator('summary').boundingBox(),
    ]);
    expect(contentBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(page.viewportSize()?.height ?? 0);
    expect(summaryBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  } else {
    await expect(desktopNavigation).toBeVisible();
    await expect(mobileNavigation).toBeHidden();
  }

  await attachViewport(page, testInfo, 'docs-navigation-and-content');
});

test('graph cards keep metadata and actions separated at narrow widths', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('kbRegistry', JSON.stringify([
      { id: 'kbase', name: 'Default Graph', createdAt: 0, statementCount: 0 },
      {
        id: 'kbase_research_with_a_deliberately_long_identifier_for_mobile_layout',
        name: 'Climate research and policy evidence with a deliberately long graph name',
        description: 'A long description that must remain in the metadata area instead of colliding with graph actions.',
        createdAt: 1,
        lastModified: Date.now() - 60_000,
        statementCount: 2656,
      },
      {
        id: 'kbase_client_delivery_notes',
        name: 'Client delivery notes',
        createdAt: 2,
        lastModified: Date.now() - 120_000,
        statementCount: 443,
      },
    ]));
  });
  await page.goto('/kb');

  const entries = page.locator('.kb-entry');
  await expect(entries).toHaveCount(3);
  const layout = await entries.evaluateAll((cards) => cards.map((card) => {
    const meta = card.querySelector('.kb-entry-meta')?.getBoundingClientRect();
    const actions = card.querySelector('.kb-entry-actions')?.getBoundingClientRect();
    const targets = [...card.querySelectorAll<HTMLElement>('.kb-entry-actions button, .kb-entry-actions a')]
      .map((target) => target.getBoundingClientRect().height);
    const intersects = !!meta && !!actions && !(
      meta.right <= actions.left || actions.right <= meta.left ||
      meta.bottom <= actions.top || actions.bottom <= meta.top
    );
    return { intersects, targetHeights: targets };
  }));

  expect(layout.every(({ intersects }) => !intersects)).toBe(true);
  if (isPhoneProject(testInfo)) {
    expect(layout.flatMap(({ targetHeights }) => targetHeights).every((height) => height >= 44)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await attachViewport(page, testInfo, 'graph-card-layout');
});

test('ordinary mobile notifications collapse while Shelly is open', async ({ page }, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'mobile overlay coordination regression');
  await page.goto('/');
  // Let the route's asynchronous first-run tip register before isolating this
  // test's notices; clearing immediately races the onMount notification.
  await expect(page.locator('.notif-title')).toHaveText('Meet Shelly');

  await page.evaluate(async () => {
    const notificationModule = '/src/lib/stores/notifications.svelte.ts';
    const notificationStore = await import(/* @vite-ignore */ notificationModule);
    for (const notice of notificationStore.notifications()) {
      notificationStore.dismissNotification(notice.id);
    }
    notificationStore.pushNotification({ id: 'ui-one', type: 'info', title: 'First notice' });
    notificationStore.pushNotification({ id: 'ui-two', type: 'info', title: 'Second notice' });
  });
  await expect(page.locator('.notification')).toHaveCount(1);
  await expect(page.locator('.notif-title')).toHaveText('First notice');
  await expect(page.locator('.bell-badge')).toHaveText('2');

  await page.evaluate(async () => {
    const shellyModule = '/src/lib/stores/shelly-bridge.svelte.ts';
    const shellyStore = await import(/* @vite-ignore */ shellyModule);
    shellyStore.setShellyChatOpen(true);
  });
  await expect(page.locator('.notification-stack')).toHaveCount(0);
  await expect(page.locator('.notif-bell')).toHaveAttribute('aria-expanded', 'false');

  // An urgent notice must outrank the one-item mobile limit, including while
  // the ordinary tray would otherwise remain collapsed under Shelly.
  await page.evaluate(async () => {
    const notificationModule = '/src/lib/stores/notifications.svelte.ts';
    const notificationStore = await import(/* @vite-ignore */ notificationModule);
    for (const notice of notificationStore.notifications()) {
      notificationStore.dismissNotification(notice.id);
    }
    notificationStore.pushNotification({ id: 'ui-ordinary', type: 'info', title: 'Ordinary audit notice' });
    notificationStore.pushNotification({ id: 'ui-urgent', type: 'warn', title: 'Urgent audit notice', important: true });
  });
  await expect(page.locator('.notification')).toHaveCount(1);
  await expect(page.locator('.notif-title')).toHaveText('Urgent audit notice');
  await expect(page.locator('.bell-badge')).toHaveText('2');
  await attachViewport(page, testInfo, 'notifications-with-shelly');
});

test('mobile document and status surfaces reserve navigation clearance', async ({ page }, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'mobile navigation-clearance regression');

  const expectReservedShell = async () => {
    const [navBox, mainBox] = await Promise.all([
      page.getByRole('navigation', { name: 'Main navigation' }).boundingBox(),
      page.locator('#main-content').boundingBox(),
    ]);
    expect(mainBox?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((mainBox?.y ?? 0) + (mainBox?.height ?? Number.POSITIVE_INFINITY))
      .toBeLessThanOrEqual((navBox?.y ?? 0) + 1);
    return navBox;
  };

  await page.goto('/settings');
  const navBox = await expectReservedShell();
  const saveBox = await page.locator('.autosave-indicator').boundingBox();
  expect(saveBox?.y ?? 0).toBeGreaterThan(0);
  expect((saveBox?.y ?? 0) + (saveBox?.height ?? 0)).toBeLessThanOrEqual(navBox?.y ?? 0);

  await page.goto('/kb');
  const kbNavBox = await expectReservedShell();
  const kbActions = page.locator('.kb-entry-actions').first();
  await kbActions.scrollIntoViewIfNeeded();
  const kbActionBox = await kbActions.boundingBox();
  expect((kbActionBox?.y ?? 0) + (kbActionBox?.height ?? 0)).toBeLessThanOrEqual((kbNavBox?.y ?? 0) + 1);

  await page.goto('/ingest');
  await page.getByRole('button', { name: 'facts ✎', exact: true }).click();
  const ingestNavBox = await expectReservedShell();
  const ingestAction = page.getByRole('button', { name: 'add to graph →' });
  await ingestAction.scrollIntoViewIfNeeded();
  const ingestActionBox = await ingestAction.boundingBox();
  expect((ingestActionBox?.y ?? 0) + (ingestActionBox?.height ?? 0))
    .toBeLessThanOrEqual((ingestNavBox?.y ?? 0) + 1);

  await page.goto('/review');
  const clearance = await page.locator('.review-panel').evaluate((panel) => ({
    paddingBottom: Number.parseFloat(getComputedStyle(panel).paddingBottom),
    navHeight: document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')
      ?.getBoundingClientRect().height ?? 0,
  }));
  expect(clearance.paddingBottom).toBeGreaterThanOrEqual(clearance.navHeight);
  await attachViewport(page, testInfo, 'mobile-navigation-clearance');
});
