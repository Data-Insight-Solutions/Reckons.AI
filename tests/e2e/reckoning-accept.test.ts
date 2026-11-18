import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F223.12.4: accepting one option of a proposal. Mock provider and a SYNTHETIC file-queue runner in OPFS (as in
 * generated-assets-story.test.ts): no GPU job ever runs, the request file is only counted.
 *
 * A: its statement is confirmed, its one job is queued exactly once (one approval), B's rows are superseded,
 * the missing-input question stays open; answering it closes the proposal (the target is that question).
 */
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

/** The open question the person will choose as the target: the same entity and relationship the mock's missing input uses. */
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

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('accepting option A confirms its statement, queues its job once, supersedes B and keeps the question open; answering it closes the proposal', async ({ page }) => {
  await seed(page);
  await addTargetQuestion(page);
  await page.goto('/reckoning');
  await syntheticRunner(page);
  const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 });
  await boxes.first().check();
  await page.locator('.btn-next').click();
  await expect(page).toHaveURL(/[?&]r=/);
  const id = new URL(page.url()).searchParams.get('r')!;
  await page.getByLabel('Answer a question').check();
  const choice = page.locator('[data-testid="target-picker"] input[type="radio"]').first();
  await expect(choice).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('What does Sample Company still need?')).toBeVisible();
  await choice.check();
  await page.getByRole('button', { name: /review/i }).click();
  await page.getByRole('button', { name: /generate proposal/i }).click();
  const cards = page.locator('[data-testid="proposal-option"]');
  await expect(cards).toHaveCount(2, { timeout: 15_000 });
  await linkRunner(page);
  await page.waitForTimeout(2500);
  await linkRunner(page);

  const A = `reckoning-${id}-option-a`;
  const B = `reckoning-${id}-option-b`;
  const before = await requestCount(page);

  // the confirm step says what will happen before anything changes
  await cards.first().getByTestId('accept-option').click();
  const confirm = cards.first().getByTestId('accept-confirm');
  await expect(confirm).toContainText(/confirm \d+ statements?/);
  await expect(confirm).toContainText('queue 1 job in one approval');
  await expect(confirm).toContainText(/superseded/);
  await expect(confirm).toContainText('1 missing-input question stays open');
  expect((await allRows(page)).some((r) => r.proposalOption === A && r.status === 'confirmed')).toBe(false);
  await cards.first().getByTestId('accept-confirm-yes').click();
  await expect(cards.first().getByText('Accepted by you.')).toBeVisible({ timeout: 15_000 });

  // the card turns to 'Accepted' while the last rows are still being written: wait for the link to the real job
  await expect.poll(async () => (await allRows(page)).some((r) => r.p.endsWith('/queued-as')), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId('proposal-status')).toContainText('active', { timeout: 10_000 });
  const rows = await allRows(page);
  const a = rows.filter((r) => r.proposalOption === A);
  const b = rows.filter((r) => r.proposalOption === B);
  expect(a.filter((r) => r.p.endsWith('/brand-direction') && !r.needsObject).map((r) => r.status)).toEqual(['confirmed']);
  expect(a.filter((r) => r.needsObject)).toHaveLength(1);
  expect(a.find((r) => r.needsObject)!.status).toBe('pending');
  expect(b.length).toBeGreaterThan(0);
  expect(b.every((r) => r.status === 'superseded')).toBe(true);
  // exactly one job was queued, in one approval; the proposed record now says queued and points at the real job
  expect(await requestCount(page)).toBe(before + 1);
  expect(a.find((r) => r.p.endsWith('/job-state'))!.o).toBe('queued');

  // answering the missing input closes the proposal
  const q = cards.first().getByTestId('open-question');
  await expect(q).toBeVisible();
  await q.getByRole('textbox').fill('logo.png');
  await q.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByTestId('proposal-status')).toContainText('Completed', { timeout: 10_000 });
  expect(await requestCount(page)).toBe(before + 1);
});
