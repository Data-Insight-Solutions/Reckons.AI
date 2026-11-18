import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F223.12.3: a Reckoning's proposal is written into the knowledge base. Mock backend returns a fixed, valid, synthetic
 * proposal of two options. Each option must hold one proposed statement, one proposed job and one open
 * missing-input question; nothing is confirmed and no job is queued.
 */
async function seed(page: Page) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Company Alpha');
  await page.locator('textarea').first().fill('Company Alpha has 50 employees, was founded in 2020 by Jane Doe in Seattle, and makes battery software.');
  const submit = page.getByRole('button', { name: /extract facts/i });
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

type Row = { id: string; status: string; p: string; o: string; proposalOption?: string; needsObject?: boolean; question?: string };
const allRows = (page: Page) => page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const out: any[] = [];
  for (const info of dbs) {
    if (!info.name) continue;
    const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (open.objectStoreNames.contains('statements')) {
      const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
      for (const st of all) out.push({ id: st.id, status: st.status, s: st.s?.value, p: st.p?.value, o: st.o?.value, proposalOption: st.proposalOption, needsObject: st.needsObject, question: st.question });
    }
    open.close();
  }
  return out as (Row & { s: string })[];
});

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('a reckoning writes two pending options into the knowledge base: a dashed statement, an unqueued job and a hollow question each', async ({ page }) => {
  await seed(page);
  await page.goto('/reckoning');
  const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 });
  await boxes.first().check();
  await page.locator('.btn-next').click();
  await expect(page).toHaveURL(/[?&]r=/);
  const id = new URL(page.url()).searchParams.get('r')!;
  await page.locator('textarea').last().fill('Decide how to refresh the company logo this quarter.');
  await page.getByRole('button', { name: /review/i }).click();
  const before = (await allRows(page)).length;
  await page.getByRole('button', { name: /generate proposal/i }).click();

  const cards = page.locator('[data-testid="proposal-option"]');
  await expect(cards).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByText('Nothing is confirmed and no job has been queued.')).toBeVisible();
  await expect(page.locator('[data-testid="prose-fallback"]')).toHaveCount(0);

  const rows = await allRows(page);
  expect(rows.length).toBeGreaterThan(before);
  for (const key of ['a', 'b']) {
    const oid = `reckoning-${id}-option-${key}`;
    const mine = rows.filter((r) => r.proposalOption === oid);
    expect(mine.every((r) => r.status === 'pending')).toBe(true);
    expect(mine.filter((r) => r.p.endsWith('/brand-direction') && !r.needsObject)).toHaveLength(1);
    const jobStates = mine.filter((r) => r.p.endsWith('/job-state'));
    expect(jobStates).toHaveLength(1);
    expect(jobStates[0].o).toBe('proposed');
    const questions = mine.filter((r) => r.needsObject);
    expect(questions).toHaveLength(1);
    expect(questions[0].o).toBe('?');
    expect(questions[0].question).toBeTruthy();
  }
  // nothing the proposal wrote is confirmed, and no job record anywhere is queued
  const wrote = rows.filter((r) => r.id.startsWith(`reckoning-${id}-opt-`));
  expect(wrote.length).toBeGreaterThan(0);
  expect(wrote.some((r) => r.status === 'confirmed' || r.status === 'refined')).toBe(false);
  expect(rows.some((r) => r.p.endsWith('/job-state') && r.o === 'queued')).toBe(false);

  // the card points at an option on the canvas
  await cards.first().getByRole('link', { name: /show on the canvas/i }).click();
  await expect(page).toHaveURL(/[?&]focus=reckoning-/);
  await expect(page.getByTitle('Stop showing one proposal option')).toBeVisible({ timeout: 15_000 });
});
