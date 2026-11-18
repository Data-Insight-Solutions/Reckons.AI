import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F223.12.2: the target of a Reckoning is chosen from the open questions and kept on the Reckoning entity.
 * Mock backend, no keys. Seeds one ingest, adds one open question straight into the local database, then
 * chooses the situation and the question and reloads.
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

/** Run a callback against every local database that holds statements (the app opens one per space). */
async function addOpenQuestion(page: Page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
      if (!info.name) continue;
      const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (open.objectStoreNames.contains('statements')) {
        const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
        const base = all.find((st) => st.s?.kind === 'iri' && st.status === 'confirmed');
        if (base) {
          const row = { ...base, id: 'e2e-open-question', status: 'pending', needsObject: true, o: { kind: 'literal', value: '?' }, question: 'How many offices does Company Alpha run?' };
          await new Promise<void>((res, rej) => { const w = open.transaction('statements', 'readwrite'); w.objectStore('statements').put(row); w.oncomplete = () => res(); w.onerror = () => rej(w.error); });
        }
      }
      open.close();
    }
  });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('choosing an open question as the target is written on the Reckoning entity and restored on reload', async ({ page }) => {
  await seed(page);
  await addOpenQuestion(page);
  await page.goto('/reckoning');
  const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible({ timeout: 10_000 });
  await boxes.first().check();
  await page.locator('.btn-next').click();
  await expect(page).toHaveURL(/[?&]r=/);
  const id = new URL(page.url()).searchParams.get('r')!;

  await page.getByLabel('Answer a question').check();
  const choice = page.locator('[data-testid="target-picker"] input[type="radio"]').first();
  await expect(choice).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('How many offices does Company Alpha run?')).toBeVisible();
  await choice.check();
  await page.getByRole('button', { name: /review/i }).click();
  await expect(page.getByText('Answer this open question: How many offices does Company Alpha run?')).toBeVisible();

  const targetRows = () => page.evaluate(async (rid) => {
    const dbs = await indexedDB.databases();
    const out: { p: string; o: string }[] = [];
    for (const info of dbs) {
      if (!info.name) continue;
      const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (open.objectStoreNames.contains('statements')) {
        const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
        for (const st of all) if (st.s?.value === `urn:kbase:concept/reckoning-${rid}`) out.push({ p: st.p.value, o: st.o.value });
      }
      open.close();
    }
    return out;
  }, id);
  await expect.poll(async () => (await targetRows()).filter((r) => r.p.endsWith('/target-statement')).length, { timeout: 8_000 }).toBe(1);
  expect((await targetRows()).find((r) => r.p.endsWith('/target-statement'))!.o).toContain('urn:kbase:stmt/');

  await page.reload();
  await expect(page.getByLabel('Answer a question')).toBeChecked({ timeout: 10_000 });
  await expect(page.locator('[data-testid="target-picker"] input[type="radio"]').first()).toBeChecked();
});
