import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * TEST WORKFLOW: COMPARE (v0.2.9; F264.1 to F264.3). A second note is read against what your knowledge base
 * holds, lands in Review's compare flow with a label on each statement, is drawn over the canvas,
 * and its one contradiction is decided in place with the replaced statement still on record.
 *
 * The steps are the ktype:TestStep triples of test:Workflow-CompareV029 in static/docs-testing.ttl;
 * this file supplies what each one DOES. The notes are synthetic (tests/fixtures/compare-demo) and the
 * mock reader returns their statements; the near-duplicate label uses the test embedder seam in embed.ts.
 */

const WORKFLOW_ID = 'compare-v029';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

const demo = JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  seed: { title: string; text: string };
  change: { title: string; text: string };
};

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

async function fillNote(page: Page, title: string, text: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(text);
  const submit = page.getByRole('button', { name: /extract statements/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  return submit;
}
const landed = (page: Page) =>
  page.waitForURL((url) => url.pathname === '/review' && url.searchParams.get('view') === 'compare', { timeout: 30_000 });

async function statusCounts(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { status: string }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  });
}
async function members(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string }; status: string; excerpt?: string }[];
    return rows.filter((r) => r.p.value.endsWith('/members')).map((r) => ({ status: r.status, value: r.o.value, excerpt: r.excerpt }));
  });
}

const flow = (page: Page) => page.getByTestId('compare-flow');

const impls: Record<string, StepImpl> = {
  'extract-note': async (page, snap) => {
    const submit = await fillNote(page, demo.change.title, demo.change.text);
    await snap(submit);
    await submit.click();
    await landed(page);
    await expect(flow(page).locator('.diff-entry')).toHaveCount(4, { timeout: 10_000 });
  },

  'see-labels': async (page, snap) => {
    const f = flow(page);
    await expect(f.locator('.diff-entry[data-kind="near-duplicate"]')).toHaveCount(1, { timeout: 15_000 });
    for (const [kind, n] of [['reinforces', 1], ['near-duplicate', 1], ['conflicts', 1], ['new', 1]] as const) {
      await expect(f.locator(`.diff-entry[data-kind="${kind}"]`)).toHaveCount(n);
    }
    const chips = f.getByTestId('compare-chips');
    for (const t of ['1 repeat', '1 near-duplicate', '1 contradiction', '1 new']) await expect(chips).toContainText(t);
    await expect(f.getByRole('button', { name: /accept new only \(1\)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /extract facts/i })).toHaveCount(0);
    await snap(chips);
  },

  'see-on-canvas': async (page, snap) => {
    const legend = page.getByTestId('overlay-legend');
    await expect(legend).toContainText('1 new, drawn as ghosts');
    await expect(legend).toContainText('1 repeat, folded onto what you hold');
    await expect(legend).toContainText('1 reinforcing, thickening what you hold');
    await expect(legend).toContainText('1 contradiction');
    await expect(page.getByTestId('contradiction-pair')).toHaveCount(1);
    await expect.poll(async () =>
      page.getByTestId('compare-canvas').locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
        const g = c.getContext('2d');
        if (!g) return 0;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 190 && d[i + 2] < 70 && d[i + 3] > 100) n++;
        return n;
      }), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await statusCounts(page)).toEqual({ confirmed: 3, pending: 4 });
    await snap(legend);
  },

  'decide-contradiction': async (page, snap) => {
    const pair = page.getByTestId('contradiction-pair');
    await expect(pair.getByTestId('passage-held')).toContainText('forty members');
    await expect(pair.getByTestId('passage-incoming')).toContainText('Membership is now fifty-two');
    await snap(pair);
    await pair.getByRole('button', { name: 'take the new one' }).click();
    await expect(page.getByTestId('contradiction-pair')).toHaveCount(0, { timeout: 8_000 });
    const rows = await members(page);
    expect(rows.map((r) => `${r.value}:${r.status}`).sort()).toEqual(['40:superseded', '52:refined']);
  },

  'see-on-record': async (page, snap) => {
    const settled = flow(page).getByTestId('decided-pair');
    await expect(settled).toHaveCount(1);
    await expect(settled).toContainText('replaced, still on record');
    await expect(settled).toContainText('members · 40');
    await expect(settled).toContainText('members · 52');
    await expect(settled).toContainText(`from ${demo.seed.title}`);
    await expect(settled).toContainText(`from ${demo.change.title}`);
    const rows = await members(page);
    expect(rows.every((r) => r.excerpt), 'both keep their passage').toBe(true);
    await snap(settled);
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('reckons-test-embedder', '1'));
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  expect(Object.keys(impls).sort(), 'every TestStep needs an implementation here, and every implementation a TestStep')
    .toEqual(workflow.steps.map((s) => s.id).sort());
});

test('the notes quoted in the graph are the fixture notes', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  expect(flat(workflow.steps.find((s) => s.id === 'extract-note')!.text)).toContain(flat(demo.change.text));
});

test(`${workflow.title}`, async ({ page }) => {
  test.setTimeout(150_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  // Setup, not a step: the first note is read and accepted so the knowledge base holds it.
  const first = await fillNote(page, demo.seed.title, demo.seed.text);
  await first.click();
  await landed(page);
  await flow(page).getByRole('button', { name: /^accept all/ }).click();
  await expect(flow(page).locator('.diff-entry')).toHaveCount(0, { timeout: 8_000 });
  for (const step of workflow.steps) {
    await test.step(`${step.order}. ${step.title} (${step.page})`, async () => {
      const snap: Snap = async (target) => {
        if (!CAPTURE_DIR) return;
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(900);
        const cleanup = await boxTarget(page, target, step.boxLabel);
        const png = await page.screenshot({ fullPage: false });
        await cleanup();
        writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
      };
      await impls[step.id](page, snap);
    });
  }
});
