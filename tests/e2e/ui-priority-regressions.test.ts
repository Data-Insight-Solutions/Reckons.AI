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

async function seedLargeReviewQueue(page: Page, count = 104) {
  await page.goto('/');
  await page.evaluate(async (statementCount) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const db = new KBaseDB('kbase');
    await db.sources.put({
      id: 'ui-review-scale',
      title: 'Mobile review scale fixture',
      uri: 'test://ui-review-scale',
      kind: 'note',
      ingestedAt: 1,
      trustLevel: 'review',
    });
    await db.statements.bulkPut(Array.from({ length: statementCount }, (_, index) => ({
      id: `ui-review-${index}`,
      s: { kind: 'iri' as const, value: `urn:ui-review:item-${index}` },
      p: { kind: 'iri' as const, value: 'http://www.w3.org/2004/02/skos/core#broader' },
      o: {
        kind: 'iri' as const,
        value: index === 0 ? 'urn:ui-review:root' : `urn:ui-review:item-${index - 1}`,
      },
      g: { kind: 'iri' as const, value: 'urn:kbase:source/ui-review-scale' },
      sourceId: 'ui-review-scale',
      confidence: 0.75,
      status: 'pending' as const,
      createdAt: index + 1,
      updatedAt: index + 1,
    })));
    db.close();
  }, count);
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

test('starter and ingest failures are visible, announced, and retryable', async ({ page }, testInfo) => {
  await page.route('**/starter-everyday.ttl', async (route) => {
    await route.fulfill({ status: 503, body: 'fixture unavailable' });
  });
  await page.goto('/');
  const starter = page.getByRole('button', { name: /getting started/i });
  await starter.click();
  const starterError = page.getByRole('alert').filter({ hasText: /starter graph.*503/i });
  await expect(starterError).toBeVisible();
  await expect(starterError).toBeFocused();
  await expect(starter).toBeEnabled();

  await page.goto('/ingest');
  await page.getByRole('button', { name: 'repo', exact: true }).click();
  await page.getByPlaceholder(/owner\/repo or/i).fill('not a valid repo');
  await page.getByRole('button', { name: 'preview', exact: true }).click();
  const ingestError = page.getByRole('alert').filter({ hasText: /invalid repo url/i });
  await expect(ingestError).toBeVisible();
  await expect(ingestError).toBeFocused();
  await expect(page.getByText('fetching repo info…', { exact: true })).toHaveCount(0);
  const box = await ingestError.boundingBox();
  expect(box?.y ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
  await attachViewport(page, testInfo, 'visible-actionable-errors');
});

test('everyday starter opens in transient 2D without overwriting the saved renderer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).click();

  // The curated first-run graph contains 177 nodes. Avoid charging its CTA for synchronous WebGL
  // context and shader setup; an explicit user renderer preference remains authoritative later.
  const graph = page.locator('[data-graph-renderer="2d"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  // Performance consumers must see this graph's real lifecycle, not inherit the landing page's
  // no-work `true`. This is the exact false→true contract the flow crawl now waits on.
  await expect(graph).toHaveAttribute('data-graph-settled', 'false');
  await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 15_000 });

  await page.goto('/settings');
  const rendererRow = page.getByText('graph renderer').locator('..').locator('..');
  await expect(rendererRow.getByRole('button', { name: '3D', exact: true })).toHaveClass(/active/);
  await expect(rendererRow.getByRole('button', { name: '2D', exact: true })).not.toHaveClass(/active/);
});

test('starter graph keeps prose and URL attributes off the canvas topology', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', '3D label integration regression');
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).click();
  const graph = page.locator('[data-graph-renderer="2d"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 15_000 });

  // Inspect the 2D renderer's complete label callback. Unlike 3D's deliberately camera-visible
  // subset, 2D publishes every rendered node to the shared DOM overlay (collision-hidden labels
  // remain in the DOM at zero alpha), so this is an honest topology inventory rather than a claim
  // about which side of a rotating camera an entity happened to occupy.
  const labels = page.locator('.node-label');
  await expect.poll(async () => labels.count(), { timeout: 15_000 }).toBeGreaterThan(5);

  const labelText = (await labels.allInnerTexts()).join('\n');
  expect(labelText).not.toMatch(/Drives up from San Francisco|behind the wheel/i);
  expect(labelText).not.toMatch(/google\.com|recreation\.gov|forecast\.weather\.gov/i);
  expect(labelText).toMatch(/Alex/);
  expect(labelText).toMatch(/Jordan/);

  // The prose did not disappear: selecting Alex still exposes the full fact in node details.
  await page.getByPlaceholder('search nodes or facts…').fill('Alex');
  await page.locator('.sb-node-row').filter({ hasText: 'Alex' }).first().click();
  await page.locator('.np-stmts-toggle').click();
  await expect(page.getByText(/Wants a fair, even meet-up point/i)).toBeVisible();
});

test('successful mobile starter opens a legible, touch-safe guided tour', async ({ page }, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'mobile starter handoff regression');
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).click();

  const graph = page.locator('section.graph');
  await expect(graph).not.toHaveAttribute('data-graph-renderer', 'landing', { timeout: 15_000 });
  const shelly = page.getByRole('dialog', { name: 'Shelly' });
  await expect(shelly).toBeVisible({ timeout: 15_000 });

  // The first response can take several seconds even with a local model. Say what is happening
  // instead of presenting an unexplained row of animated dots.
  const initialStatus = shelly.getByRole('status').filter({ hasText: /reading your graph|thinking/i });
  if (await initialStatus.count()) await expect(initialStatus).toBeVisible();

  const tourTargets = shelly.locator('button, textarea').filter({ visible: true });
  const undersizedTourTargets = await tourTargets.evaluateAll((targets) => targets.map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      name: target.getAttribute('aria-label') || target.textContent?.trim() || target.getAttribute('placeholder'),
      width: rect.width,
      height: rect.height,
    };
  }).filter(({ width, height }) => width < 44 || height < 44));
  expect(undersizedTourTargets, 'Every visible starter-tour control should have a 44×44px target').toEqual([]);

  await shelly.getByRole('button', { name: 'close' }).click();
  const askShelly = page.getByRole('button', { name: 'Ask Shelly' });
  await expect(askShelly).toBeVisible();
  const askShellyBox = await askShelly.boundingBox();
  expect(askShellyBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(askShellyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await attachViewport(page, testInfo, 'mobile-starter-guided-tour');
});

test('mobile navigation keeps secondary actions usable without crowding primary tasks', async ({ page }, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'mobile navigation disclosure regression');
  await page.goto('/ingest');

  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const more = nav.getByRole('button', { name: 'More' });
  await expect(more).toBeVisible();
  await expect(nav.getByRole('link', { name: 'settings' })).toBeHidden();

  const primaryTargets = nav.locator(':scope > a:visible, :scope > button:visible');
  const primarySizes = await primaryTargets.evaluateAll((targets) => targets.map((target) => {
    const rect = target.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(primarySizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);

  await more.click();
  const menu = page.getByRole('menu', { name: 'More navigation' });
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.getByRole('menuitem', { name: 'settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'info' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'send feedback' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'settings' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'info' })).toBeFocused();

  const menuSizes = await menu.getByRole('menuitem').evaluateAll((targets) => targets.map((target) => {
    const rect = target.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(menuSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  const analyze = nav.getByRole('button', { name: 'Analyze graph' });
  await analyze.click();
  const analysisMenu = page.getByRole('menu', { name: 'Analysis actions' });
  await expect(analysisMenu).toBeVisible();
  await expect(analysisMenu.getByRole('menuitem', { name: 'enrich' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(analysisMenu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(analysisMenu).toBeHidden();
  await expect(nav.getByRole('link', { name: 'reckon', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await attachViewport(page, testInfo, 'mobile-navigation-more-menu');
});

test('review entries expose a standalone graph-focus control without nested interactive elements', async ({ page }) => {
  await seedLargeReviewQueue(page, 3);
  await page.goto('/review');
  await expect(page.getByTestId('review-pending-count')).toContainText('3', { timeout: 15_000 });

  const entries = page.locator('.entry-focus-wrap');
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).not.toHaveAttribute('role');
  await expect(entries.first()).not.toHaveAttribute('tabindex');

  const nestedControls = await page.locator('.review-panel').evaluate((panel) => {
    const interactive = 'button, a[href], input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
    return [...panel.querySelectorAll<HTMLElement>(interactive)].flatMap((control) => {
      const ancestor = control.parentElement?.closest(interactive);
      return ancestor ? [{
        control: control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName,
        ancestor: ancestor.getAttribute('aria-label') || ancestor.textContent?.trim() || ancestor.tagName,
      }] : [];
    });
  });
  expect(nestedControls, 'Review actions must not be nested inside another interactive control').toEqual([]);

  // A native button supplies both Enter and Space semantics. Selecting one entry and then using a
  // different entry's action also proves that child actions do not bubble into card focus.
  const declineModel = page.getByRole('button', { name: /not now/i });
  if (await declineModel.isVisible()) await declineModel.click();

  const first = entries.nth(0);
  const second = entries.nth(1);
  const firstFocus = first.locator('.entry-focus-action');
  const secondFocus = second.locator('.entry-focus-action');
  await expect(firstFocus).toHaveAccessibleName(/show .+ in the preview graph/i);
  await expect(secondFocus).toHaveAccessibleName(/show .+ in the preview graph/i);
  await secondFocus.press('Enter');
  await expect(second).toHaveClass(/entry-focused/);
  await firstFocus.press('Space');
  await expect(first).toHaveClass(/entry-focused/);
  await second.getByRole('button', { name: 'accept', exact: true }).click();
  await expect(first).toHaveClass(/entry-focused/);
});

test('large mobile review queues scroll inside the panel and keep controls reachable', async ({ page }, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'mobile review scrolling regression');
  await seedLargeReviewQueue(page);
  await page.goto('/review');
  await expect(page.getByTestId('review-pending-count')).toContainText('104', { timeout: 15_000 });
  await expect(page.locator('.review-panel .triple button')).toHaveCount(0);
  await expect(page.locator('.review-panel .row[role="button"]')).toHaveCount(0);

  const sizes = await page.locator(
    '.graph-pane button, .graph-pane input:not([type="hidden"]), .review-panel button, .review-panel input:not([type="hidden"]), .review-panel a[href]'
  ).evaluateAll((targets) => targets.filter((target) => {
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      name: target.getAttribute('aria-label') || target.textContent?.trim(),
      width: rect.width,
      height: rect.height,
    };
  }));
  expect(
    sizes.filter(({ width, height }) => width < 44 || height < 44),
    'Every visible mobile review control should have its own 44×44px target',
  ).toEqual([]);

  // The coarse 3D labels above exercise touch hit areas. Switch to 2D to verify that a large
  // hierarchy can actually fit below the old 4x zoom floor and reports real simulation completion.
  const graphPane = page.locator('.graph-pane');
  const declineModel = page.getByRole('button', { name: /not now/i });
  if (await declineModel.isVisible()) await declineModel.click();
  await graphPane.getByRole('button', { name: /^(2D|3D)$/ }).click();
  await graphPane.getByRole('radio', { name: 'tree', exact: true }).click();
  const graph2d = graphPane.locator('canvas.graph2d');
  await expect(graph2d).toBeVisible();
  await expect.poll(async () => Number(await graph2d.getAttribute('data-camera-scale'))).toBeLessThan(4);
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'true', { timeout: 12_000 });

  const originalViewport = page.viewportSize()!;
  const scaleBeforeResize = Number(await graph2d.getAttribute('data-camera-scale'));
  await page.setViewportSize({ width: originalViewport.width, height: 700 });
  await expect.poll(async () => {
    const scale = Number(await graph2d.getAttribute('data-camera-scale'));
    return Math.abs(scale - scaleBeforeResize) > 0.0001;
  }, { message: 'Hierarchy camera should re-fit when its canvas changes size' }).toBe(true);
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'true');
  await page.setViewportSize(originalViewport);

  const scroll = await page.locator('.review-panel').evaluate(async (panel) => {
    const content = panel.querySelector<HTMLElement>('.rp-content')!;
    const layout = panel.closest<HTMLElement>('.review-layout')!;
    const header = panel.querySelector<HTMLElement>('.rp-header')!;
    const panelRect = panel.getBoundingClientRect();
    const before = {
      panelBottom: panelRect.bottom,
      viewportHeight: innerHeight,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
    };
    content.scrollTop = 500;
    await new Promise(requestAnimationFrame);
    return {
      ...before,
      contentScrollTop: content.scrollTop,
      layoutScrollTop: layout.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      panelTop: panel.getBoundingClientRect().top,
    };
  });

  expect(scroll.panelBottom).toBeLessThanOrEqual(scroll.viewportHeight + 1);
  expect(scroll.contentScrollHeight).toBeGreaterThan(scroll.contentClientHeight);
  expect(scroll.contentScrollTop).toBeGreaterThan(0);
  expect(scroll.layoutScrollTop).toBe(0);
  expect(scroll.headerTop).toBeGreaterThanOrEqual(scroll.panelTop);
  await attachViewport(page, testInfo, 'large-mobile-review-scrolls-internally');
});

test('review graph remount starts a fresh settled-signal cycle', async ({ page }) => {
  await seedLargeReviewQueue(page, 3);
  await page.goto('/review');
  await expect(page.getByTestId('review-pending-count')).toContainText('3', { timeout: 15_000 });

  const graphPane = page.locator('.graph-pane');
  const declineModel = page.getByRole('button', { name: /not now/i });
  if (await declineModel.isVisible()) await declineModel.click();
  const rendererToggle = graphPane.getByRole('button', { name: /^(2D|3D)$/ });
  if ((await rendererToggle.textContent())?.trim() === '3D') await rendererToggle.click();
  await expect(graphPane.locator('canvas.graph2d')).toBeVisible();
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'true', { timeout: 12_000 });

  // Non-preview modes are settled by definition and unmount the force renderer. Returning to
  // preview must not inherit that `true`: the new renderer has a fresh simulation to cool.
  await graphPane.getByRole('button', { name: 'compare', exact: true }).click();
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'true');
  await graphPane.getByRole('button', { name: /preview/i }).click();
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'false');
  await expect(graphPane).toHaveAttribute('data-graph-settled', 'true', { timeout: 12_000 });
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
  const clearance = await page.locator('.rp-content').evaluate(async (content) => {
    const probe = document.createElement('span');
    probe.style.cssText = 'display:block;width:1px;height:1px;';
    content.append(probe);
    content.scrollTop = content.scrollHeight;
    await new Promise(requestAnimationFrame);
    const result = {
      probeBottom: probe.getBoundingClientRect().bottom,
      navTop: document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')
        ?.getBoundingClientRect().top ?? innerHeight,
    };
    probe.remove();
    return result;
  });
  expect(clearance.probeBottom).toBeLessThanOrEqual(clearance.navTop + 1);
  await attachViewport(page, testInfo, 'mobile-navigation-clearance');
});
