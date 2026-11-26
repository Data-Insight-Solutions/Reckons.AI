import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { clearStorage, waitForApp } from './helpers';

/**
 * ONE COMPARE FLOW (F264.1). Extracting a note lands in Review's compare mode, which shows each
 * statement against what is already held with its own label, and "accept new only" settles
 * just the new one. The notes are synthetic (tests/fixtures/compare-demo) and the mock reader
 * returns their statements; the similar-wording label uses the test embedder seam in embed.ts
 * (flag `reckons-test-embedder`), so it proves the wiring, not the real model's judgment.
 */
const demo = JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  seed: { title: string; text: string };
  change: { title: string; text: string };
};

async function addNote(page: Page, title: string, text: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(text);
  const submit = page.getByRole('button', { name: /extract statements/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  await submit.click();
  await page.waitForURL((url) => url.pathname === '/review' && url.searchParams.get('view') === 'compare', { timeout: 30_000 });
}

async function statusesByPredicate(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string }; status: string }[];
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[`${r.p.value.split('/').pop()}=${r.o.value.split('/').pop()}`] ??= []).push(r.status);
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('reckons-test-embedder', '1'));
});

test('extracting a note opens compare in Review and labels exactly four kinds; accept new only settles the new one', async ({ page }) => {
  // Seed: read the first note, accept everything it says.
  await addNote(page, demo.seed.title, demo.seed.text);
  const flow = page.getByTestId('compare-flow');
  await expect(flow).toBeVisible({ timeout: 10_000 });
  await expect(flow.locator('.diff-entry')).toHaveCount(3);
  await flow.getByRole('button', { name: /^accept all/ }).click();
  await expect(flow.locator('.diff-entry')).toHaveCount(0, { timeout: 8_000 });

  // The change note: one repeat, one near-duplicate, one contradiction, one new.
  await addNote(page, demo.change.title, demo.change.text);
  await expect(flow.locator('.diff-entry')).toHaveCount(4, { timeout: 10_000 });
  await expect(flow.locator('.diff-entry[data-kind="reinforces"]')).toHaveCount(1);
  await expect(flow.locator('.diff-entry[data-kind="near-duplicate"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(flow.locator('.diff-entry[data-kind="conflicts"]')).toHaveCount(1);
  await expect(flow.locator('.diff-entry[data-kind="new"]')).toHaveCount(1);
  const chips = flow.getByTestId('compare-chips');
  await expect(chips).toContainText('1 repeat');
  await expect(chips).toContainText('1 near-duplicate');
  await expect(chips).toContainText('1 contradiction');
  await expect(chips).toContainText('1 new');
  // Wording: statements, not facts.
  await expect(flow.getByRole('button', { name: /accept new only \(1\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /extract facts/i })).toHaveCount(0);

  await flow.getByRole('button', { name: /accept new only/ }).click();
  await expect(flow.locator('.diff-entry')).toHaveCount(3, { timeout: 8_000 });
  const held = await statusesByPredicate(page);
  expect(held['has-roof=slate']).toEqual(['confirmed']);
  expect(held['press-day=Thursday'].sort()).toEqual(['confirmed', 'pending']); // the seed's own, and the untouched repeat
  for (const key of ['members=52', 'has-cellar=stone-cellar']) expect(held[key], key).toEqual(['pending']);
});

test('the Review tab no longer offers overlay mode', async ({ page }) => {
  await page.goto('/review');
  await expect(page.getByRole('button', { name: /^compare$/i })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('button', { name: /^overlay$/i })).toHaveCount(0);
});
