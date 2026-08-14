import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  collectRuntimeErrors,
  finishEvidenceRun,
  recordEvidenceScreenshot,
  sha256,
  startEvidenceRun,
  type EvidenceCheck,
} from '../../../scripts/visual-evidence-contract';

async function countStatements(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('kbase');
        request.onerror = () => reject(request.error ?? new Error('Failed to open kbase'));
        request.onsuccess = () => {
          try {
            const transaction = request.result.transaction('statements', 'readonly');
            const count = transaction.objectStore('statements').count();
            count.onerror = () => reject(count.error ?? new Error('Failed to count statements'));
            count.onsuccess = () => resolve(count.result);
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
}

async function captureWithBaseline(
  page: Page,
  testInfo: Parameters<typeof startEvidenceRun>[1],
  run: Awaited<ReturnType<typeof startEvidenceRun>>,
  id: string,
  label: string,
  audit: EvidenceCheck[],
): Promise<void> {
  // Capture the audited viewport. Full-page capture temporarily rewrites the
  // mobile document viewport around fixed navigation and can leave subsequent
  // interaction waiting on layout stabilization; the report records the exact
  // viewport/orientation and the workflow captures the next state separately.
  const buffer = await page.screenshot({ fullPage: false });
  const baselineName = `${id}.png`;
  expect(buffer).toMatchSnapshot(baselineName, { maxDiffPixelRatio: 0.005 });
  const baselinePath = testInfo.snapshotPath(baselineName);
  const baselineBuffer = await readFile(baselinePath);
  await recordEvidenceScreenshot(run, page, {
    id,
    label,
    buffer,
    audit,
    baseline: {
      name: baselineName,
      path: baselinePath,
      sha256: sha256(baselineBuffer),
    },
  });
}

test('manual Facts workflow produces strict, reviewable evidence', async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const run = await startEvidenceRun(page, testInfo, runtimeErrors);

  await page.goto('/ingest');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'facts ✎', exact: true }).click();
  await page.locator('input[placeholder="name for this set of notes"]').fill('Trip logistics');

  const facts: [string, string, string][] = [
    ['weekend-trip', 'check-in', '2026-07-10'],
    ['alex', 'drives-from', 'San Francisco'],
    ['jordan', 'drives-from', 'Los Angeles'],
  ];
  for (let index = 0; index < facts.length; index++) {
    if (index > 0) await page.locator('.add-triple-btn').click();
    await page.getByLabel(`Fact ${index + 1} subject`).fill(facts[index][0]);
    await page.getByLabel(`Fact ${index + 1} predicate`).fill(facts[index][1]);
    await page.getByLabel(`Fact ${index + 1} object`).fill(facts[index][2]);
  }

  const addToGraph = page.getByRole('button', { name: 'add to graph →' });
  // Native scrollIntoViewIfNeeded considers pixels behind the fixed navigation
  // "visible". Center the action explicitly so the overlap audit and click both
  // exercise a genuinely reachable control.
  await addToGraph.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const ingestAudit = await page.evaluate(() => {
    const fields = [...document.querySelectorAll<HTMLInputElement>('.triple-entry input')];
    const action = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim().toLowerCase() === 'add to graph →');
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]');
    const actionBox = action?.getBoundingClientRect();
    const navBox = nav?.getBoundingClientRect();
    const contrast = (input: HTMLInputElement) => {
      const style = getComputedStyle(input);
      const channels = (value: string) =>
        (value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
      const [fr, fg, fb] = channels(style.color);
      const [br, bg, bb] = channels(style.backgroundColor);
      const foreground = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
      const background = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
      return (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);
    };
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      fieldCount: fields.length,
      labelsPresent: fields.every((field) => field.getAttribute('aria-label')?.startsWith('Fact ')),
      minimumContrast: Math.min(...fields.map(contrast)),
      actionHeight: actionBox?.height ?? 0,
      actionClearsNavigation: !navBox || !actionBox || (
        actionBox.right <= navBox.left ||
        navBox.right <= actionBox.left ||
        actionBox.bottom <= navBox.top ||
        navBox.bottom <= actionBox.top
      ),
    };
  });
  expect(ingestAudit.overflow).toBe(false);
  expect(ingestAudit.fieldCount).toBe(9);
  expect(ingestAudit.labelsPresent).toBe(true);
  expect(ingestAudit.minimumContrast).toBeGreaterThanOrEqual(4.5);
  expect(ingestAudit.actionHeight).toBeGreaterThanOrEqual(44);
  expect(ingestAudit.actionClearsNavigation).toBe(true);
  await captureWithBaseline(page, testInfo, run, 'facts-populated', 'Populated Facts form', [
    { name: 'no-horizontal-overflow', pass: !ingestAudit.overflow, detail: `${ingestAudit.overflow}` },
    { name: 'all-nine-fields-labeled', pass: ingestAudit.fieldCount === 9 && ingestAudit.labelsPresent, detail: `${ingestAudit.fieldCount} labeled fields` },
    { name: 'wcag-aa-input-contrast', pass: ingestAudit.minimumContrast >= 4.5, detail: ingestAudit.minimumContrast.toFixed(2) },
    { name: 'primary-action-touch-size', pass: ingestAudit.actionHeight >= 44, detail: `${ingestAudit.actionHeight}px` },
    { name: 'primary-action-clears-navigation', pass: ingestAudit.actionClearsNavigation, detail: `${ingestAudit.actionClearsNavigation}` },
  ]);

  await addToGraph.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(addToGraph).toBeVisible();
  await addToGraph.click({ timeout: 10_000 });
  await page.waitForURL(/\/compare/, { timeout: 20_000 });
  await expect.poll(() => countStatements(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const compareAudit = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    mainVisible: !!document.querySelector('#main-content'),
  }));
  expect(compareAudit.overflow).toBe(false);
  expect(compareAudit.mainVisible).toBe(true);
  await captureWithBaseline(page, testInfo, run, 'facts-compare', 'Facts persisted on compare', [
    { name: 'three-statements-persisted', pass: (await countStatements(page)) >= 3, detail: `${await countStatements(page)} statements` },
    { name: 'no-horizontal-overflow', pass: !compareAudit.overflow, detail: `${compareAudit.overflow}` },
    { name: 'main-landmark-present', pass: compareAudit.mainVisible, detail: `${compareAudit.mainVisible}` },
  ]);

  await page.goto('/');
  await expect.poll(() => page.locator('.node-label').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('[data-graph-ready="true"]')).toBeVisible();
  const renderer = await page.locator('[data-graph-renderer]').first()
    .getAttribute('data-graph-renderer');
  expect(['2d', '3d']).toContain(renderer);
  const graphBuffer = await page.screenshot({ fullPage: false });
  await recordEvidenceScreenshot(run, page, {
    id: 'facts-graph',
    label: 'Populated graph rendering',
    buffer: graphBuffer,
    audit: [
      { name: 'nonempty-graph', pass: (await page.locator('.node-label').count()) > 0, detail: `${await page.locator('.node-label').count()} labels` },
      { name: 'renderer-ready', pass: renderer === '2d' || renderer === '3d', detail: renderer ?? 'none' },
    ],
  });

  await page.waitForTimeout(500);
  expect(runtimeErrors.page, `Uncaught page errors:\n${runtimeErrors.page.join('\n---\n')}`)
    .toHaveLength(0);
  expect(runtimeErrors.console, `Console errors:\n${runtimeErrors.console.join('\n---\n')}`)
    .toHaveLength(0);
  await finishEvidenceRun(run);
});
