import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { playStory, type StepException } from './story-runner';
import { advertiseRunner, linkRunner } from './synthetic-runner';
import type { UnifiedStory } from '../../src/lib/rdf/story-steps';

/**
 * TEST WORKFLOW: RECKONING (v0.2.9; F223.12.1 to F223.12.4). Choose the situation (canvas and list),
 * choose the target, generate a proposal that is written into the knowledge base, look at an option on the
 * canvas, accept one, answer its missing input.
 *
 * As in workflow-build-change.test.ts the steps are the ktype:TestStep triples of
 * test:Workflow-ReckoningV029 in static/docs-testing.ttl; this file supplies what each one DOES and
 * fails if the two lists differ. The mock provider writes the proposal and a SYNTHETIC file-queue
 * runner in OPFS stands in for the generation tools: no job ever runs, the request file is counted.
 */

const WORKFLOW_ID = 'reckoning-v029';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const story = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts', `--story=${WORKFLOW_ID}`], { encoding: 'utf8' }),
) as UnifiedStory;

async function seed(page: Page) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Company Alpha');
  await page.locator('textarea').first().fill('Company Alpha has 50 employees, was founded in 2020 by Jane Doe in Seattle, and makes battery software.');
  const submit = page.getByRole('button', { name: /extract (facts|statements)/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 30_000 });
  await page.goto('/review');
  await expect(page.getByText(/company.alpha|employee|2020|seattle/i).first()).toBeVisible({ timeout: 8_000 });
  for (let i = 0; i < 40; i++) {
    const confirm = page.getByRole('button', { name: /confirm|✓|accept/i }).first();
    if (!(await confirm.count()) || !(await confirm.isVisible().catch(() => false))) break;
    await confirm.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

/** The open question the person chooses as the target; the mock's missing input uses the same entity and relationship. */
async function addTargetQuestion(page: Page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
      if (!info.name) continue;
      const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (open.objectStoreNames.contains('statements')) {
        const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
        const base = all.find((st) => st.s?.kind === 'iri' && st.status === 'confirmed');
        if (base) {
          const row = { ...base, id: 'e2e-target-question', s: { kind: 'iri', value: 'urn:kbase:concept/sample-company' }, p: { kind: 'iri', value: 'urn:kbase:predicate/needs-input' }, status: 'pending', needsObject: true, o: { kind: 'literal', value: '?' }, question: 'What does Sample Company still need?' };
          await new Promise<void>((res, rej) => { const w = open.transaction('statements', 'readwrite'); w.objectStore('statements').put(row); w.oncomplete = () => res(); w.onerror = () => rej(w.error); });
        }
      }
      open.close();
    }
  });
}

type Row = { id: string; status: string; s: string; p: string; o: string; proposalOption?: string; needsObject?: boolean };
const allRows = (page: Page) => page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const out: any[] = [];
  for (const info of dbs) {
    if (!info.name) continue;
    const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (open.objectStoreNames.contains('statements')) {
      const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
      for (const st of all) out.push({ id: st.id, status: st.status, s: st.s?.value, p: st.p?.value, o: st.o?.value, proposalOption: st.proposalOption, needsObject: st.needsObject });
    }
    open.close();
  }
  return out as Row[];
});

const requestCount = (page: Page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const jobs = await (await root.getDirectoryHandle('.reckons-generation')).getDirectoryHandle('jobs');
  let n = 0;
  const entries = jobs as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
  for await (const h of entries.values()) {
    if (h.kind !== 'directory') continue;
    try { await (h as FileSystemDirectoryHandle).getFileHandle('request.json'); n++; } catch { /* no request */ }
  }
  return n;
});

/** State shared between steps, which run in order in one browser page. */
const ctx: { id: string; before: number } = { id: '', before: 0 };
const cards = (page: Page) => page.locator('[data-testid="proposal-option"]');

/**
 * NAMED EXCEPTIONS (F300.3). Steps 2, 3, 4 and 7 declare their typing, pressing and what must then be true;
 * what a story cannot declare yet stays here as code, with its reason:
 *   - select-on-canvas: the node to select is found from the data at run time, the button is found by its
 *     name, and the reckoning id is read from the address for the later steps.
 *   - choose-situation: statements are ticked by position and the count is read before the next press.
 *   - choose-target: the "Answer a question" radio and the first choice are picked by label and position.
 *   - generate-proposal: the synthetic runner is set up first, and the per-option row checks (status,
 *     job-state, one open question) read fields no expectation kind reads.
 *   - show-on-canvas: a second browser tab, a modified click and relinking the runner.
 *   - accept-option: the confirm text must be read between pressing Accept and pressing Confirm, and
 *     expectations are only checked after all of a step's actions.
 *   - answer-missing-input: the count of queued job requests (OPFS files) is unchanged.
 */
const exceptions: Record<string, StepException> = {
  'select-on-canvas': {
    why: 'the node is found from the data at run time, the button by its name, and the reckoning id is read from the address',
    perform: async (page, snap) => {
      const iri = (await allRows(page)).find((r) => r.status === 'confirmed' && r.s.startsWith('urn:kbase:concept/') && r.s.includes('company-alpha'))?.s
        ?? (await allRows(page)).find((r) => r.status === 'confirmed' && r.s.startsWith('urn:kbase:concept/'))!.s;
      await page.goto(`/?sel=${encodeURIComponent('i:' + iri)}`);
      const action = page.getByRole('button', { name: /reckon with these/i });
      await expect(action).toBeVisible({ timeout: 15_000 });
      await snap(action);
      await action.click();
      await page.waitForURL(/\/reckoning\?r=/);
      await expect(page.getByTestId('chosen-count')).not.toContainText('0 statements', { timeout: 10_000 });
      ctx.id = new URL(page.url()).searchParams.get('r')!;
    },
  },

  'choose-situation': {
    why: 'statements are ticked by position and the count is read before the next press',
    before: async (page, snap) => {
      const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
      await expect(boxes.nth(2)).toBeVisible({ timeout: 10_000 });
      for (let i = 0; i < 3; i++) await boxes.nth(i).check();
      await expect(page.getByTestId('chosen-count')).toContainText('3 statements chosen');
      await snap(page.getByTestId('situation-picker'));
    },
    after: async (page) => {
      await expect(page).toHaveURL(/[?&]r=/);
      expect(new URL(page.url()).searchParams.get('r')).toBeTruthy();
    },
  },

  'choose-target': {
    why: 'the radio is picked by its label and the first choice by position, before the next press',
    before: async (page, snap) => {
      await page.getByLabel('Answer a question').check();
      const choice = page.locator('[data-testid="target-picker"] input[type="radio"]').first();
      await expect(choice).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('What does Sample Company still need?')).toBeVisible();
      await choice.check();
      await snap(page.getByTestId('target-picker'));
    },
    after: async (page) => {
      await expect(page.getByText('Answer this open question: What does Sample Company still need?')).toBeVisible();
    },
  },

  'generate-proposal': {
    why: 'the synthetic runner is set up first, and the per-option row checks read fields no expectation kind reads',
    before: async (page) => { await advertiseRunner(page); },
    perform: async (page) => {
      await expect(cards(page)).toHaveCount(2, { timeout: 15_000 });
      const rows = await allRows(page);
      for (const key of ['a', 'b']) {
        const mine = rows.filter((r) => r.proposalOption === `reckoning-${ctx.id}-option-${key}`);
        expect(mine.every((r) => r.status === 'pending')).toBe(true);
        expect(mine.filter((r) => r.p.endsWith('/brand-direction') && !r.needsObject)).toHaveLength(1);
        expect(mine.filter((r) => r.p.endsWith('/job-state')).map((r) => r.o)).toEqual(['proposed']);
        expect(mine.filter((r) => r.needsObject)).toHaveLength(1);
      }
      expect(rows.some((r) => r.p.endsWith('/job-state') && r.o === 'queued')).toBe(false);
    },
  },

  'show-on-canvas': {
    why: 'a second browser tab, a modified click and relinking the runner',
    perform: async (page, snap) => {
      // The link opens in a second tab (as a person can with ctrl-click), so this page keeps its proposal on screen.
      const popup = page.context().waitForEvent('page');
      await cards(page).first().getByRole('link', { name: /show on the canvas/i }).click({ modifiers: ['Control'] });
      const canvasPage = await popup;
      await canvasPage.setViewportSize({ width: 1280, height: 800 });
      await expect(canvasPage).toHaveURL(/[?&]focus=reckoning-/);
      const stop = canvasPage.getByTitle('Stop showing one proposal option');
      await expect(stop).toBeVisible({ timeout: 15_000 });
      await snap(stop);
      await canvasPage.close();
      await linkRunner(page);
      await page.waitForTimeout(2500);
      await linkRunner(page);
      ctx.before = await requestCount(page);
    },
  },

  'accept-option': {
    why: 'the confirm text is read between pressing Accept and pressing Confirm, and expectations are checked after all of a step\'s actions',
    perform: async (page, snap) => {
      const A = `reckoning-${ctx.id}-option-a`;
      const B = `reckoning-${ctx.id}-option-b`;
      await cards(page).first().getByTestId('accept-option').click();
      const confirm = cards(page).first().getByTestId('accept-confirm');
      await expect(confirm).toContainText(/confirm \d+ statements?/);
      await expect(confirm).toContainText('queue 1 job in one approval');
      await expect(confirm).toContainText(/superseded/);
      await expect(confirm).toContainText('1 missing-input question stays open');
      await snap(confirm);
      await cards(page).first().getByTestId('accept-confirm-yes').click();
      await expect(cards(page).first().getByText('Accepted by you.')).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await allRows(page)).some((r) => r.p.endsWith('/queued-as')), { timeout: 10_000 }).toBe(true);
      const rows = await allRows(page);
      const a = rows.filter((r) => r.proposalOption === A);
      const b = rows.filter((r) => r.proposalOption === B);
      expect(a.filter((r) => r.p.endsWith('/brand-direction') && !r.needsObject).map((r) => r.status)).toEqual(['confirmed']);
      expect(b.length).toBeGreaterThan(0);
      expect(b.every((r) => r.status === 'superseded')).toBe(true);
      expect(await requestCount(page)).toBe(ctx.before + 1);
    },
  },

  'answer-missing-input': {
    why: 'the count of queued job requests (OPFS files) is unchanged',
    after: async (page) => { expect(await requestCount(page)).toBe(ctx.before + 1); },
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
});

test('every named exception belongs to a step of the story', () => {
  const inGraph = new Set(story.steps.map((st) => st.id));
  for (const id of Object.keys(exceptions)) expect(inGraph.has(id), `exception "${id}" names no step in the story`).toBe(true);
  for (const st of story.steps) expect(st.actions.length > 0 || exceptions[st.id], `step "${st.id}" declares nothing and has no named exception`).toBeTruthy();
});

test(`${story.label}`, async ({ page }) => {
  test.setTimeout(180_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  await seed(page);
  await addTargetQuestion(page);
  const outcomes = await playStory(page, story, {
    exceptions,
    onSnap: async (step, target) => {
      if (!CAPTURE_DIR) return;
      const shotPage = target.page();
      await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shotPage.waitForTimeout(900);
      const cleanup = await boxTarget(shotPage, target, step.target?.label ?? step.title);
      const png = await shotPage.screenshot({ fullPage: false });
      await cleanup();
      writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
    },
  });
  expect(outcomes.map((o) => o.id), 'the runner played every step of the story, in order').toEqual(story.steps.map((st) => st.id));
});
