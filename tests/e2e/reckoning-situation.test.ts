import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F223.12.1: the situation of a Reckoning is chosen from statements and kept as an entity in the space.
 * Mock backend, no keys. Seeds one ingest, confirms it, then chooses on the list and from the canvas.
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

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('three chosen statements and a sentence become one Reckoning entity, and a reload restores them', async ({ page }) => {
  await seed(page);
  await page.goto('/reckoning');
  const boxes = page.locator('[data-testid="situation-picker"] input[type="checkbox"]');
  await expect(boxes.nth(2)).toBeVisible({ timeout: 10_000 });
  for (const i of [0, 1, 2]) await boxes.nth(i).check();
  await expect(page.getByTestId('chosen-count')).toContainText('3 statements chosen');
  await page.getByPlaceholder(/evaluating/i).fill('We need to decide about the vendor.');
  await page.locator('.btn-next').click();
  await expect(page).toHaveURL(/[?&]r=/);
  const id = new URL(page.url()).searchParams.get('r')!;

  // The entity is in the space: read the rows straight from the local database.
  const rows = await page.evaluate(async (rid) => {
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
  expect(rows.filter((r) => r.p.endsWith('/situation-statement'))).toHaveLength(3);
  expect(rows.filter((r) => r.p.endsWith('/situation-note')).map((r) => r.o)).toEqual(['We need to decide about the vendor.']);
  expect(rows.filter((r) => r.o === 'urn:kbase:type/Reckoning')).toHaveLength(1);

  await page.reload();
  await expect(page.getByTestId('chosen-count')).toContainText('3 statements chosen', { timeout: 10_000 });
  await expect(page.getByPlaceholder(/evaluating/i)).toHaveValue('We need to decide about the vendor.');
});

test('"Reckon with these" on the canvas opens the Reckoning page with the statements already chosen', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  const iri = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
      if (!info.name) continue;
      const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (open.objectStoreNames.contains('statements')) {
        const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
        const hit = all.find((st) => st.s?.kind === 'iri' && st.status === 'confirmed' && st.s.value.startsWith('urn:kbase:concept/'));
        open.close();
        if (hit) return hit.s.value as string;
      } else open.close();
    }
    return null;
  });
  expect(iri).toBeTruthy();
  await page.goto(`/?sel=${encodeURIComponent('i:' + iri)}`);
  const action = page.getByRole('button', { name: /reckon with these/i });
  await expect(action).toBeVisible({ timeout: 15_000 });
  await action.click();
  await page.waitForURL(/\/reckoning\?r=/);
  await expect(page.getByTestId('chosen-count')).not.toContainText('0 statements', { timeout: 10_000 });
});
