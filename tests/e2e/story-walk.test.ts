import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F292.2 done-test (kb:story-walk-player), on a synthetic space with a three-step story: the counter
 * reads 1 / 3; Next lights step 2's markers and dims the rest; marker positions before and after are equal;
 * Back returns; the step link restores the step after a reload. Also: the arrow keys step the story
 * unless focus is in a text field, and on a phone stepping opens no detail sheet over the story.
 */
const S = 'urn:test:walk/';
const STORY = S + 'story';
const ITEMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const STEPS = [['alpha', 'beta'], ['gamma'], ['delta', 'epsilon']];

async function seed(page: Page) {
  await page.evaluate(async ({ S, STORY, ITEMS, STEPS }) => {
    const path = '/src/lib/stores/kb.svelte.ts';
    const kb = await import(/* @vite-ignore */ path);
    const at = Date.now();
    let n = 0;
    const iri = (value: string) => ({ kind: 'iri' as const, value });
    const lit = (value: string, datatype?: string) => ({ kind: 'literal' as const, value, ...(datatype ? { datatype } : {}) });
    const st = (s: string, p: string, o: ReturnType<typeof iri> | ReturnType<typeof lit>) => ({
      id: 'walk-' + n++, s: iri(s), p: iri(p), o, g: iri('urn:kbase:source/walk'), sourceId: 'walk', confidence: 1, status: 'confirmed' as const, createdAt: at, updatedAt: at,
    });
    const sts = [];
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#label';
    const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    ITEMS.forEach((name, i) => {
      sts.push(st(S + name, RDFS, lit(name[0].toUpperCase() + name.slice(1))));
      sts.push(st(S + name, TYPE, iri('urn:kbase:type/Thing')));
      sts.push(st(S + name, 'urn:kbase:predicate/next-to', iri(S + ITEMS[(i + 1) % ITEMS.length])));
    });
    sts.push(st(STORY, TYPE, iri('urn:reckons:story/Story')), st(STORY, RDFS, lit('Walk test')));
    STEPS.forEach((hl, i) => {
      const step = S + 'step' + (i + 1);
      sts.push(st(step, TYPE, iri('urn:reckons:story/Step')), st(step, 'urn:reckons:story/partOf', iri(STORY)),
        st(step, 'urn:reckons:story/order', lit(String(i + 1), 'http://www.w3.org/2001/XMLSchema#integer')),
        st(step, 'urn:reckons:story/title', lit('Step title ' + (i + 1))), st(step, 'urn:reckons:story/content', lit('Caption ' + (i + 1))));
      for (const h of hl) sts.push(st(step, 'urn:reckons:story/highlight', iri(S + h)));
    });
    await kb.addStatements(sts as never, 'walk');
  }, { S, STORY, ITEMS, STEPS });
}

async function positions(page: Page): Promise<Record<string, number[]>> {
  const canvas = page.locator('main canvas').first();
  await expect.poll(() => canvas.evaluate((c) => typeof (c as unknown as { __markerPositions?: unknown }).__markerPositions), { timeout: 90_000, intervals: [1000] }).toBe('function');
  return canvas.evaluate((c) => Object.fromEntries((c as unknown as { __markerPositions: () => [string, number, number, number][] }).__markerPositions().map(([k, x, y, z]) => [k, [x, y, z]])));
}
const counter = (page: Page) => page.locator('.story-step-label, .walk-controls .story-step-label').first();
async function open(page: Page, step?: number) {
  await page.goto('/?story=' + encodeURIComponent(STORY) + (step ? '&step=' + step : ''), { waitUntil: 'domcontentloaded' });
  await page.locator('nav').waitFor({ timeout: 15_000 });
}
/** The labels drawn lit are only the step's own markers, at least one is drawn, and none of them is drawn dimmed (a label can be hidden by overlap, so not every marker has one). */
async function expectLit(page: Page, names: string[]) {
  const want = names.map((n) => n[0].toUpperCase() + n.slice(1));
  await expect.poll(async () => {
    const lit = await litLabels(page); const dim = await dimmedLabels(page);
    return lit.length > 0 && lit.every((l) => want.includes(l)) && !dim.some((l) => want.includes(l)) && dim.length > 0;
  }, { timeout: 15_000 }).toBe(true);
}
const dimmedLabels = (page: Page) => page.locator('.node-label.dim-hidden').allTextContents();
const litLabels = (page: Page) => page.locator('.node-label:not(.dim-hidden)').allTextContents();

test.describe('the story walk', () => {
  test.beforeEach(async ({ page }) => { await clearStorage(page); await waitForApp(page); await seed(page); });

  test('counter, Next lights and dims without moving a marker, Back returns, the step link survives a reload', async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await expect(counter(page)).toHaveText('1 / 3');
    const before = await positions(page);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(6);
    await expectLit(page, STEPS[0]);

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(counter(page)).toHaveText('2 / 3');
    await expectLit(page, STEPS[1]);
    await page.waitForTimeout(1500);
    const after = await positions(page);
    for (const k of Object.keys(before)) for (let i = 0; i < 3; i++) expect(after[k]?.[i], k + ' axis ' + i).toBeCloseTo(before[k][i], 6);
    expect(new URL(page.url()).searchParams.get('step')).toBe('2');

    await page.getByRole('button', { name: 'Previous step' }).click();
    await expect(counter(page)).toHaveText('1 / 3');
    await expectLit(page, STEPS[0]);

    await open(page, 3);
    await expect(counter(page)).toHaveText('3 / 3');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(counter(page)).toHaveText('3 / 3');
    await expectLit(page, STEPS[2]);
  });

  test('left and right arrows step the story, except while typing in a text field', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await expect(counter(page)).toHaveText('1 / 3');
    await page.locator('main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('ArrowRight');
    await expect(counter(page)).toHaveText('2 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(counter(page)).toHaveText('1 / 3');
    await page.getByPlaceholder('ask about this step…').focus();
    await page.keyboard.press('ArrowRight');
    await expect(counter(page)).toHaveText('1 / 3');
  });

  test('on a phone the walk is a slim bar: stepping opens no detail sheet and the caption stays visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    const bar = page.locator('.walk-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Caption 1');
    await bar.getByRole('button', { name: 'Next step' }).click();
    await expect(bar).toContainText('Caption 2');
    await expect(bar.locator('.story-step-label')).toHaveText('2 / 3');
    await expect(page.getByText('also known as', { exact: false })).toHaveCount(0);
    const box = await bar.boundingBox();
    expect(box!.height).toBeLessThan(844 * 0.45);
    await expectLit(page, STEPS[1]);
  });
});
