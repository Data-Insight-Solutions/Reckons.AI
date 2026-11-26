import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { playStory, type StepException } from './story-runner';
import type { UnifiedStory } from '../../src/lib/rdf/story-steps';

/**
 * TEST WORKFLOW: COMPARE (v0.2.9; F264.1 to F264.3; F300.5). A second note is read against what your knowledge
 * base holds, lands in Review's compare flow with a label on each statement, is drawn over the canvas,
 * and its one contradiction is decided in place with the replaced statement still on record.
 *
 * The steps are the story story:quickstart-compare INSIDE the Quick-Start example (static/starter-quickstart.ttl);
 * static/docs-testing.ttl keeps a pointer to it, and this file plays it (playStory). The note is synthetic
 * (tests/fixtures/compare-demo, the entry named quickstart) and the mock reader returns its statements; the
 * near-duplicate label uses the test embedder seam in embed.ts.
 */

const WORKFLOW_ID = 'compare-v029';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const story = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts', `--story=${WORKFLOW_ID}`], { encoding: 'utf8' }),
) as UnifiedStory;

const demo = (JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  quickstart: { title: string; text: string };
}).quickstart;

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
async function deadlines(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { s: { value: string }; p: { value: string }; o: { value: string }; status: string; excerpt?: string }[];
    return rows.filter((r) => r.p.value.endsWith('/deadline') && r.s.value.endsWith('/project-phoenix')).map((r) => ({ status: r.status, value: r.o.value, excerpt: r.excerpt }));
  });
}

/**
 * SETUP, not a step: the Quick-Start example is opened as its own space, the way the About page's card does it.
 * (Both walks start with that example open; the example's own opening is the generated-assets walk's step 1.)
 */
async function openQuickstart(page: Page) {
  await page.goto('/about');
  await page.getByTestId('starter-card-quickstart').click();
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/lib/storage/db.ts';
    const { db } = await import(/* @vite-ignore */ path);
    return (await db.statements.count()) as number;
  }).catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(20); // a reload mid-poll returns 0, not a failure
}

const flow = (page: Page) => page.getByTestId('compare-flow');

/**
 * NAMED EXCEPTIONS (F300.3). The story declares what each step does and shows (type the note, press extract,
 * the labels, the legend, the pair decided, the record of it); this is what it cannot declare yet:
 *   - see-labels: that no button reads "extract facts" ANYWHERE on the page is an absence found by role, not a
 *     test id, and no expectation kind says "nothing like this exists".
 *   - see-on-canvas: pixels of the ghost overlay are read from the canvas, and the whole-database status tally
 *     (the example's confirmed statements plus four pending, nothing yet replaced) is not one standing.
 *   - decide-contradiction: the passage quoted from the new note and the held date must be read BEFORE the click,
 *     but a story's expectations are checked after its actions, so that part runs first as code (with the
 *     screenshot of the pair). The example's own statement quotes no passage, so only the new note's is read.
 *   - see-on-record: that the replacing row keeps its passage (`excerpt`) is a field no expectation reads, and the
 *     node panel (a region found by its name) must list the new deadline under the new note and not the old one.
 *     That last check is carried over from the retired build-and-change workflow (F183.3).
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
      const tally = await statusCounts(page);
      expect(tally.pending, 'the four statements of the note are still pending').toBe(4);
      expect(tally.confirmed, 'the example\'s own statements are held').toBeGreaterThan(10);
      expect(tally.superseded ?? 0, 'nothing is replaced before the person decides').toBe(0);
    },
  },
  'decide-contradiction': {
    why: 'the quoted passages are read before the click, and expectations are checked after the actions',
    before: async (page, snap) => {
      const pair = page.getByTestId('contradiction-pair');
      await expect(pair).toContainText('2026 09 15');
      await expect(pair.getByTestId('passage-incoming')).toContainText('Its deadline has moved to 2026-10-31');
      await snap(pair);
    },
  },
  'see-on-record': {
    why: 'that the replacing row keeps its passage is a field no expectation reads, and the node panel is a region found by its name',
    perform: async (page) => {
      const rows = await deadlines(page);
      expect(rows.find((r) => r.value === '2026-10-31')?.excerpt, 'the replacing statement keeps its passage').toContain('2026-10-31');
      expect(rows.find((r) => r.value === '2026-09-15')?.status, 'the replaced one is still on record').toBe('superseded');
    },
    after: async (page) => {
      // Select the project, the way a person clicks it: its statements are listed under the note each came from.
      await page.goto(`/?sel=${encodeURIComponent('i:urn:kbase:concept/project-phoenix')}`);
      const panel = page.getByRole('region', { name: 'Node sources' });
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(panel).toContainText('Phoenix check-in');
      await expect(panel).toContainText('2026-10-31');
      await expect(panel, 'the replaced date is on record but no longer listed as held').not.toContainText('2026-09-15');
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
  expect(typed, 'the story types the fixture title and text').toEqual([demo.title, demo.text]);
});

test(`${story.label}`, async ({ page }) => {
  test.setTimeout(150_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  await openQuickstart(page);
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
