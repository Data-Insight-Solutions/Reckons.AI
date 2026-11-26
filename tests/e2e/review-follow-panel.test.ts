import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * In follow mode the right panel follows the group under review (Matt, 2026-11-26: "a bit difficult to see where to
 * approve, even in Follow the review mode ... the follow review queue didn't filter the right side panel at all").
 * Synthetic pending facts about two things; the panel shows one group, its facts, and plain confirm / reject / skip.
 */
async function seed(page: Page) {
  await page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const now = Date.now(); let n = 0;
    const row = (s: string, p: string, o: string) => ({ id: `t-${n++}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
      o: { kind: 'literal', value: o }, g: { kind: 'iri', value: 'urn:test:g' }, sourceId: 'test-src', status: 'pending', confidence: 0.9, createdAt: now, updatedAt: now });
    const L = 'http://www.w3.org/2000/01/rdf-schema#label';
    await db.sources.put({ id: 'test-src', title: 'Test notes', uri: 'test://notes', kind: 'document', trustLevel: 'review', ingestedAt: now });
    await db.statements.bulkPut([
      row('urn:test:garden', L, 'Community garden'), row('urn:test:garden', 'urn:kbase:predicate/opens', 'Saturdays'),
      row('urn:test:library', L, 'Town library'), row('urn:test:library', 'urn:kbase:predicate/opens', 'Weekdays'),
      row('urn:test:library', 'urn:kbase:predicate/hosts', 'Book club'),
    ]);
  });
}
const confirmed = (page: Page) => page.evaluate(async () => {
  const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
  const { db } = await runtimeImport('/src/lib/storage/db.ts');
  return (await db.statements.toArray()).filter((r: { status: string }) => r.status === 'confirmed').length;
});

test('follow mode: one group, its facts, and confirm / skip that move through the groups', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await clearStorage(page);
  await waitForApp(page);
  await seed(page);
  await page.goto('/review');
  const card = page.getByTestId('follow-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('group 1 of 2');
  if (process.env.FOLLOW_SHOT) await page.locator('.review-panel').screenshot({ path: process.env.FOLLOW_SHOT });
  const firstTitle = (await card.locator('.fc-title').textContent())?.trim();
  // only this group's facts are listed; the summary chips are out of the way
  await expect(page.locator('.review-panel .summary')).toBeHidden();
  // skip moves to the other group
  await page.getByTestId('follow-skip').click();
  await expect(card).toContainText('group 2 of 2');
  await expect(card.locator('.fc-title')).not.toHaveText(firstTitle ?? '');
  // confirm all settles this group; the panel moves on to what is left
  const n = Number((await card.getByTestId('follow-confirm-all').textContent())?.match(/\d+/)?.[0]);
  await page.getByTestId('follow-confirm-all').click();
  await expect.poll(() => confirmed(page), { timeout: 10_000 }).toBe(n);
  await expect(card).toContainText('group 1 of 1');
  // the full list is one click away, and back
  await page.getByTestId('follow-show-all').click();
  await expect(page.getByTestId('follow-card')).toHaveCount(0);
  await expect(page.locator('.review-panel .summary')).toBeVisible();
});
