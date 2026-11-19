import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { playStory, type StepException } from './story-runner';
import type { UnifiedStory } from '../../src/lib/rdf/story-steps';

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

const story = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts', `--story=${WORKFLOW_ID}`], { encoding: 'utf8' }),
) as UnifiedStory;

const demo = JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  seed: { title: string; text: string };
  change: { title: string; text: string };
};

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

/**
 * NAMED EXCEPTIONS (F300.3). The story declares what each step does and shows (type the note, press extract,
 * the labels, the legend, the pair decided, the record of it); this is what it cannot declare yet:
 *   - see-labels: that no button reads "extract facts" ANYWHERE on the page is an absence found by role, not a
 *     test id, and no expectation kind says "nothing like this exists".
 *   - see-on-canvas: pixels of the ghost overlay are read from the canvas, and the whole-database status tally
 *     ({ confirmed: 3, pending: 4 }) is not one subject-predicate-object standing.
 *   - decide-contradiction: the two quoted passages must be read BEFORE the click, but a story's expectations
 *     are checked after its actions, so that part runs first as code (with the screenshot of the pair).
 *   - see-on-record: that both replaced rows keep their passage (`excerpt`) is a field no expectation reads.
 */
const exceptions: Record<string, StepException> = {
  'see-labels': {
    why: 'the absence of an "extract facts" button anywhere on the page is not an expectation kind',
    perform: async (page) => {
      await expect(page.getByRole('button', { name: /extract facts/i })).toHaveCount(0);
    },
  },
  'see-on-canvas': {
    why: 'canvas pixels and a whole-database status tally are not expectation kinds',
    perform: async (page) => {
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
    },
  },
  'decide-contradiction': {
    why: 'the quoted passages are read before the click, and expectations are checked after the actions',
    before: async (page, snap) => {
      const pair = page.getByTestId('contradiction-pair');
      await expect(pair.getByTestId('passage-held')).toContainText('forty members');
      await expect(pair.getByTestId('passage-incoming')).toContainText('Membership is now fifty-two');
      await snap(pair);
    },
  },
  'see-on-record': {
    why: 'that both replaced rows keep their passage is a field no expectation reads',
    perform: async (page) => {
      const rows = await members(page);
      expect(rows.every((r) => r.excerpt), 'both keep their passage').toBe(true);
    },
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('reckons-test-embedder', '1'));
});

test('every named exception belongs to a step of the story', () => {
  const inGraph = new Set(story.steps.map((st) => st.id));
  for (const id of Object.keys(exceptions)) expect(inGraph.has(id), `exception "${id}" names no step in the story`).toBe(true);
  for (const st of story.steps) expect(st.actions.length > 0 || st.expects.length > 0 || exceptions[st.id], `step "${st.id}" declares nothing and has no named exception`).toBeTruthy();
});

test('the notes quoted in the graph are the fixture notes', () => {
  const typed = story.steps.find((st) => st.id === 'extract-note')!.actions.filter((a) => a.kind === 'type').map((a) => (a as { text: string }).text);
  expect(typed, 'the story types the fixture title and text').toEqual([demo.change.title, demo.change.text]);
});

test(`${story.label}`, async ({ page }) => {
  test.setTimeout(150_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  // Setup, not a step: the first note is read and accepted so the knowledge base holds it.
  const first = await fillNote(page, demo.seed.title, demo.seed.text);
  await first.click();
  await landed(page);
  await flow(page).getByRole('button', { name: /^accept all/ }).click();
  await expect(flow(page).locator('.diff-entry')).toHaveCount(0, { timeout: 8_000 });
  const outcomes = await playStory(page, story, {
    exceptions,
    onSnap: async (step, target) => {
      if (!CAPTURE_DIR) return;
      await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(900);
      const cleanup = await boxTarget(page, target, step.target?.label ?? step.title);
      const png = await page.screenshot({ fullPage: false });
      await cleanup();
      writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
    },
  });
  expect(outcomes.map((o) => o.id), 'the runner played every step of the story, in order').toEqual(story.steps.map((st) => st.id));
});
