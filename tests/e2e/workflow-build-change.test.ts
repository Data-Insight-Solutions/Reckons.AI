import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * BUILD A SPACE, THEN CHANGE IT (F183.3) — the half of space building the README path does not
 * reach: a second note that changes facts the space already holds.
 *
 * As in workflow-readme-path.test.ts, the steps are read from the ktype:TestStep triples in
 * static/docs-testing.ttl and this file only supplies what each step DOES; the two lists must match.
 *
 * THE NOTES ARE THE BENCHMARK'S NOTES. Both come from tests/fixtures/notes-corpus, and the mock
 * backend returns the facts written down for them in expectations.json (corpus-fixture.ts), so this
 * test drives the review on the RIGHT facts while the extraction bench scores real models on the
 * same notes. The step text in the graph quotes each note so a person can run the steps by hand with
 * a real model; the test fails if the quote and the corpus file drift apart.
 */

const WORKFLOW_ID = 'build-change';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

const corpus = (f: string) => readFileSync(join('tests/fixtures/notes-corpus', f), 'utf8').trim();
const BUILD_NOTE = corpus('06-garden-build.txt');
const CHANGE_NOTE = corpus('07-garden-change.txt');

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

async function addNote(page: Page, snap: Snap, title: string, body: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(body);
  const submit = page.getByRole('button', { name: /extract facts/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  await snap(submit);
  await submit.click();
  const deadline = Date.now() + 30_000;
  while (new URL(page.url()).pathname.startsWith('/ingest') && Date.now() < deadline) {
    await page.getByRole('button', { name: /^not now$/i }).click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  expect(new URL(page.url()).pathname, 'reading finishes and leaves the Add page').not.toMatch(/^\/ingest/);
}

/** The Review card for one source, grouped by source. */
const sourceCard = (page: Page, title: string) =>
  page.getByTestId('source-cards').locator('.entity-card').filter({ has: page.locator('.entity-label', { hasText: title }) });

/** Statement values in this space by status, read from storage: what the space actually holds. */
async function heldValues(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string }; status: string }[];
    const pick = (...status: string[]) => rows.filter((r) => status.includes(r.status) && /raised-beds|coordinator|open-on/.test(r.p.value)).map((r) => r.o.value.split('/').pop()).sort();
    // "keep new" settles the chosen value as `refined`, which is as much a part of the space as `confirmed`.
    return { confirmed: pick('confirmed', 'refined'), superseded: pick('superseded'), pending: rows.filter((r) => r.status === 'pending').length };
  });
}

const impls: Record<string, StepImpl> = {
  'add-first-note': (page, snap) => addNote(page, snap, 'Garden notes', BUILD_NOTE),

  'accept-source': async (page, snap) => {
    await page.goto('/review?group=source');
    const card = sourceCard(page, 'Garden notes');
    await expect(card).toBeVisible({ timeout: 10_000 });
    const accept = card.getByRole('button', { name: /^accept \d+$/ });
    await expect(accept).toHaveText('accept 4');
    await snap(card);
    await accept.click();
    await expect(card).toHaveCount(0, { timeout: 8_000 });
    expect((await heldValues(page)).confirmed).toEqual(['12', 'Saturday', 'priya-shah']);
  },

  'add-change-note': (page, snap) => addNote(page, snap, 'Garden meeting', CHANGE_NOTE),

  'see-held-back': async (page, snap) => {
    await page.goto('/review?group=source');
    const card = sourceCard(page, 'Garden meeting');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('3 held back');
    await expect(card.locator('.held-reason')).toHaveCount(3);
    await expect(card.locator('.held-reason').first()).toContainText('disagrees with a fact you have');
    // Nothing in it can go in one press, so there is no group accept to press by mistake.
    await expect(card.getByRole('button', { name: /^accept \d+$/ })).toHaveCount(0);
    // The canvas follows this group.
    await card.locator('.entity-label').click();
    await expect(page.locator('.focus-badge')).toContainText('Garden meeting');
    await snap(card);
  },

  'keep-new': async (page, snap) => {
    await page.goto('/review?group=source');
    const keepNew = () => page.getByRole('button', { name: /^keep new$/i }).first();
    await expect(keepNew()).toBeVisible({ timeout: 10_000 });
    await snap(keepNew());
    for (let i = 0; i < 6 && (await keepNew().count()); i++) {
      await keepNew().click();
      await page.waitForTimeout(300);
    }
    await expect(keepNew()).toHaveCount(0, { timeout: 8_000 });
  },

  'see-changed-space': async (page, snap) => {
    await page.goto('/');
    const held = await heldValues(page);
    expect(held.confirmed, 'the new values are the space').toEqual(['16', 'Sunday', 'marco-ruiz']);
    expect(held.superseded, 'the old values are kept as replaced, not deleted').toEqual(['12', 'Saturday', 'priya-shah']);
    expect(held.pending).toBe(0);
    // Select the garden, the way a person clicks it, so its facts are on screen and not only in storage.
    const garden = await page.evaluate(async () => {
      const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
      const { db } = await runtimeImport('/src/lib/storage/db.ts');
      const rows = (await db.statements.toArray()) as { s: { value: string }; p: { value: string } }[];
      return rows.find((r) => r.p.value.endsWith('raised-beds'))!.s.value;
    });
    await page.goto(`/?sel=${encodeURIComponent(`i:${garden}`)}`);
    // The node's facts, listed under the source each came from.
    const panel = page.getByRole('region', { name: 'Node sources' });
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText('raised-beds "16"');
    await expect(panel).toContainText('Garden meeting');
    await expect(panel).not.toContainText('"12"');
    await snap(panel);
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts');
    await updateSettings({ ingestBackend: 'mock', prefer2D: true });
  });
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  expect(Object.keys(impls).sort(), 'every TestStep needs an implementation here, and every implementation a TestStep')
    .toEqual(workflow.steps.map((s) => s.id).sort());
});

test('the notes quoted in the graph are the corpus notes the benchmark scores', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  expect(flat(workflow.steps.find((s) => s.id === 'add-first-note')!.text)).toContain(flat(BUILD_NOTE));
  expect(flat(workflow.steps.find((s) => s.id === 'add-change-note')!.text)).toContain(flat(CHANGE_NOTE));
});

test(`${workflow.title}`, async ({ page }) => {
  test.setTimeout(120_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
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
