import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import type { Workflow } from '../../scripts/lib/test-workflow';

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

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

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

async function syntheticRunner(page: Page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const generation = await root.getDirectoryHandle('.reckons-generation', { create: true });
    await generation.getDirectoryHandle('jobs', { create: true });
    const writeCaps = async () => {
      const writable = await (await generation.getFileHandle('capabilities.json', { create: true })).createWritable();
      await writable.write(JSON.stringify({
        version: 1, workspaceId: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', heartbeat: Date.now(),
        stages: ['image', 'video', 'splat'].map((stage) => ({ stage, available: true })),
      }));
      await writable.close();
    };
    await writeCaps();
    setInterval(() => void writeCaps(), 5000);
  });
}
const linkRunner = (page: Page) => page.evaluate(async () => {
  const path = '/src/lib/stores/workspace.svelte.ts';
  const module = await import(/* @vite-ignore */ path);
  module.__linkHandleForTest(await navigator.storage.getDirectory());
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

const impls: Record<string, StepImpl> = {
  'select-on-canvas': async (page, snap) => {
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

  'choose-situation': async (page, snap) => {
    const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
    await expect(boxes.nth(2)).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 3; i++) await boxes.nth(i).check();
    await expect(page.getByTestId('chosen-count')).toContainText('3 statements chosen');
    await page.getByPlaceholder(/evaluating/i).fill('We need to decide how to refresh the company logo.');
    await snap(page.getByTestId('situation-picker'));
    await page.locator('.btn-next').click();
    await expect(page).toHaveURL(/[?&]r=/);
    expect(new URL(page.url()).searchParams.get('r')).toBeTruthy();
  },

  'choose-target': async (page, snap) => {
    await page.getByLabel('Answer a question').check();
    const choice = page.locator('[data-testid="target-picker"] input[type="radio"]').first();
    await expect(choice).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('What does Sample Company still need?')).toBeVisible();
    await choice.check();
    await snap(page.getByTestId('target-picker'));
    await page.getByRole('button', { name: /review/i }).click();
    await expect(page.getByText('Answer this open question: What does Sample Company still need?')).toBeVisible();
  },

  'generate-proposal': async (page, snap) => {
    await syntheticRunner(page);
    await page.getByRole('button', { name: /generate proposal/i }).click();
    await expect(cards(page)).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByText('Nothing is confirmed and no job has been queued.')).toBeVisible();
    const rows = await allRows(page);
    for (const key of ['a', 'b']) {
      const mine = rows.filter((r) => r.proposalOption === `reckoning-${ctx.id}-option-${key}`);
      expect(mine.every((r) => r.status === 'pending')).toBe(true);
      expect(mine.filter((r) => r.p.endsWith('/brand-direction') && !r.needsObject)).toHaveLength(1);
      expect(mine.filter((r) => r.p.endsWith('/job-state')).map((r) => r.o)).toEqual(['proposed']);
      expect(mine.filter((r) => r.needsObject)).toHaveLength(1);
    }
    expect(rows.some((r) => r.p.endsWith('/job-state') && r.o === 'queued')).toBe(false);
    await snap(page.locator('[data-testid="proposal-option"]').first());
  },

  'show-on-canvas': async (page, snap) => {
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

  'accept-option': async (page, snap) => {
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

  'answer-missing-input': async (page, snap) => {
    const q = cards(page).first().getByTestId('open-question');
    await expect(q).toBeVisible();
    await q.getByRole('textbox').fill('logo.png');
    await q.getByRole('button', { name: 'Answer' }).click();
    const status = page.getByTestId('proposal-status');
    await expect(status).toContainText('Completed', { timeout: 10_000 });
    await snap(status);
    expect(await requestCount(page)).toBe(ctx.before + 1);
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  expect(Object.keys(impls).sort(), 'every TestStep needs an implementation here, and every implementation a TestStep')
    .toEqual(workflow.steps.map((s) => s.id).sort());
});

test(`${workflow.title}`, async ({ page }) => {
  test.setTimeout(180_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  await seed(page);
  await addTargetQuestion(page);
  for (const step of workflow.steps) {
    await test.step(`${step.order}. ${step.title} (${step.page})`, async () => {
      const snap: Snap = async (target) => {
        if (!CAPTURE_DIR) return;
        const shotPage = target.page();
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await shotPage.waitForTimeout(900);
        const cleanup = await boxTarget(shotPage, target, step.boxLabel);
        const png = await shotPage.screenshot({ fullPage: false });
        await cleanup();
        writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
      };
      await impls[step.id](page, snap);
    });
  }
});
