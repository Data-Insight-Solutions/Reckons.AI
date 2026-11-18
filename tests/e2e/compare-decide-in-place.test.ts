import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { clearStorage, waitForApp } from './helpers';

/**
 * DECIDE IN PLACE (F264.3). With the synthetic four-label note read against the first, the one
 * contradiction (members 40 against 52) is decided on its own card. Taking the new one confirms it
 * and marks the old one superseded; keeping mine rejects the arriving one. Both sides stay readable
 * with their sources and passages. Read straight from storage, as the workflow test does.
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

type Row = { status: string; value: string; sourceId: string; excerpt?: string; knownDisagreement?: string[] };
async function members(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string }; status: string; sourceId: string; excerpt?: string; knownDisagreement?: string[] }[];
    return rows.filter((r) => r.p.value.endsWith('/members')).map((r) => ({ status: r.status, value: r.o.value, sourceId: r.sourceId, excerpt: r.excerpt, knownDisagreement: r.knownDisagreement }));
  });
}

async function openContradiction(page: Page) {
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('reckons-test-embedder', '1'));
  await addNote(page, demo.seed.title, demo.seed.text);
  const flow = page.getByTestId('compare-flow');
  await flow.getByRole('button', { name: /^accept all/ }).click();
  await expect(flow.locator('.diff-entry')).toHaveCount(0, { timeout: 8_000 });
  await addNote(page, demo.change.title, demo.change.text);
  await expect(page.getByTestId('contradiction-pair')).toHaveCount(1, { timeout: 15_000 });
  return flow;
}

test('take the new one: it is confirmed, the old one is marked replaced, both stay readable with their sources', async ({ page }) => {
  const flow = await openContradiction(page);
  const pair = page.getByTestId('contradiction-pair');
  await expect(pair.getByTestId('passage-held')).toContainText('forty members');
  await expect(pair.getByTestId('passage-incoming')).toContainText('Membership is now fifty-two');
  await pair.getByRole('button', { name: 'take the new one' }).click();

  await expect(page.getByTestId('contradiction-pair')).toHaveCount(0, { timeout: 8_000 });
  const rows = await members(page);
  expect(rows.map((r) => `${r.value}:${r.status}`).sort()).toEqual(['40:superseded', '52:refined']);
  expect(rows.every((r) => r.excerpt), 'both keep their passage').toBe(true);

  const settled = flow.getByTestId('decided-pair');
  await expect(settled).toHaveCount(1);
  await expect(settled).toContainText('replaced, still on record');
  await expect(settled).toContainText('members · 40');
  await expect(settled).toContainText('members · 52');
  await expect(settled).toContainText(`from ${demo.seed.title}`);
  await expect(settled).toContainText(`from ${demo.change.title}`);
  await expect(settled).toContainText('forty members');
});

test('keep mine: the held one stays confirmed and the arriving one is rejected', async ({ page }) => {
  await openContradiction(page);
  await page.getByTestId('contradiction-pair').getByRole('button', { name: 'keep mine' }).click();
  await expect(page.getByTestId('contradiction-pair')).toHaveCount(0, { timeout: 8_000 });
  const rows = await members(page);
  expect(rows.map((r) => `${r.value}:${r.status}`).sort()).toEqual(['40:confirmed', '52:rejected']);
  await expect(page.getByTestId('decided-pair')).toContainText('the arriving statement was rejected');
});

test('keep both: both stand and the pair stays visibly marked as a known disagreement', async ({ page }) => {
  await openContradiction(page);
  await page.getByTestId('contradiction-pair').getByRole('button', { name: 'keep both' }).click();
  await expect(page.getByTestId('known-disagreement')).toHaveCount(1, { timeout: 8_000 });
  const rows = await members(page);
  expect(rows.map((r) => `${r.value}:${r.status}`).sort()).toEqual(['40:confirmed', '52:confirmed']);
  expect(rows.every((r) => (r.knownDisagreement ?? []).length === 1)).toBe(true);
});
