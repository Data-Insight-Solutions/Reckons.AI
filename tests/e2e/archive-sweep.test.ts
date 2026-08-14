/**
 * The archive age sweep, end to end (F97 entry point, /kb).
 *
 * The unit tests prove the planner picks the right entities and the adapter writes in the safe
 * order. Neither can make the claim that matters here: that a real user can REACH any of it. For
 * most of F97's life the storage layer, the retention policy, the restore path and the gallery
 * were all built, tested and green — while nothing in `src/` called `runArchive`, so the feature
 * was unreachable and every suite still passed. That is exactly the failure this file exists to
 * catch, so it drives the real control in a real browser and then checks the working graph
 * actually shrank.
 *
 * The LOOK at this panel lives in `tests/visual/user-stories/archive-sweep.test.ts`, which
 * screenshots it at desktop and phone width. That split is deliberate: two bugs in the sibling
 * gallery work (a caution rendered in brand teal because `--warn` does not exist, and a button
 * spanning a whole mobile row) passed every assertion here and were caught only by looking.
 */
import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

const OLD_EVENT = 'urn:kbase:concept/last-years-summit';
const RECENT_EVENT = 'urn:kbase:concept/this-weeks-standup';
const SCHEDULED_AT = 'urn:kbase:predicate/scheduled-at';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** Seed the working graph with one clearly-old event and one clearly-current one. */
async function seedDatedEvents(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    return !!registry.find(
      (entry: { id: string; stableId?: string }) => entry.id === 'kbase' && entry.stableId,
    );
  });

  await page.evaluate(async ({ oldEntity, recentEntity, scheduledAt, label }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');

    const DAY = 86_400_000;
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const fact = (id: string, s: string, p: string, o: string, isIri = false) => ({
      id,
      s: { kind: 'iri' as const, value: s },
      p: { kind: 'iri' as const, value: p },
      o: isIri ? { kind: 'iri' as const, value: o } : { kind: 'literal' as const, value: o },
      g: { kind: 'iri' as const, value: 'urn:kbase:source/sweep-seed' },
      sourceId: 'sweep-seed',
      confidence: 1,
      status: 'confirmed' as const,
      createdAt: 1,
      updatedAt: 1,
    });

    const db = new KBaseDB('kbase');
    await db.sources.put({
      id: 'sweep-seed',
      title: 'Sweep seed',
      uri: 'test://archive-sweep',
      kind: 'note',
      ingestedAt: 1,
      trustLevel: 'review',
    });
    await db.statements.bulkPut([
      // 400 days old — well past any threshold this test uses.
      fact('sweep-old-when', oldEntity, scheduledAt, iso(400)),
      fact('sweep-old-label', oldEntity, label, "Last year's summit"),
      // Two days old — must survive.
      fact('sweep-new-when', recentEntity, scheduledAt, iso(2)),
      fact('sweep-new-label', recentEntity, label, "This week's standup"),
    ]);
    db.close();
  }, { oldEntity: OLD_EVENT, recentEntity: RECENT_EVENT, scheduledAt: SCHEDULED_AT, label: LABEL });
}

/** Statement ids surviving in the working graph — the only proof the move really happened. */
async function workingGraphIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const db = new KBaseDB('kbase');
    const rows = await db.statements.toArray();
    db.close();
    return rows.map((r) => r.id).filter((id) => id.startsWith('sweep-')).sort();
  });
}

test.describe('archive age sweep', () => {
  test.beforeEach(async ({ page }) => {
    await clearStorage(page);
    await waitForApp(page);
    await seedDatedEvents(page);
    await page.goto('/kb');
    await page.locator('.kb-list').waitFor({ timeout: 15_000 });
  });

  test('the control exists and is reachable on the current graph', async ({ page }) => {
    // The whole point: an entry point a user can find. For months there was none.
    const toggle = page.locator('.kb-sweep-toggle');
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.kb-sweep-body')).toBeVisible();
  });

  test('previews what would move before anything moves', async ({ page }) => {
    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('90');

    const plan = page.getByTestId('sweep-plan');
    await expect(plan).toContainText('2 facts across 1 entity would move');

    // Preview only — the working graph is untouched until the button is pressed.
    expect(await workingGraphIds(page)).toEqual([
      'sweep-new-label', 'sweep-new-when', 'sweep-old-label', 'sweep-old-when',
    ]);
  });

  test('archives the old event and leaves the current one', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('90');
    await page.locator('.kb-sweep-run').click();

    await expect(page.getByTestId('sweep-done')).toContainText('Archived 2 fact');

    // The claim that matters: the facts LEFT the working database, not just the view.
    expect(await workingGraphIds(page)).toEqual(['sweep-new-label', 'sweep-new-when']);
  });

  test('the archive it creates appears in the gallery beside its parent', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('90');
    await page.locator('.kb-sweep-run').click();
    await expect(page.getByTestId('sweep-done')).toBeVisible();

    // Closes the loop with the gallery work: a sweep now produces something to look at, which
    // until this landed no user action could do.
    const group = page.locator('.kb-group.has-archives');
    await expect(group).toHaveCount(1);
    await expect(group.locator('.kb-archive-row')).toContainText('(archives)');
  });

  test('a threshold that spares everything offers no destructive button', async ({ page }) => {
    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('3650'); // ten years

    await expect(page.getByTestId('sweep-plan')).toContainText('Nothing to archive');
    await expect(page.locator('.kb-sweep-run')).toHaveCount(0);
  });

  test('says why it would sweep nothing rather than going quiet', async ({ page }) => {
    // An undated entity is never swept — the plan must SAY so, not silently report zero.
    await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
      const db = new KBaseDB('kbase');
      await db.statements.bulkPut([{
        id: 'sweep-undated',
        s: { kind: 'iri' as const, value: 'urn:kbase:concept/undated-thing' },
        p: { kind: 'iri' as const, value: 'http://www.w3.org/2000/01/rdf-schema#label' },
        o: { kind: 'literal' as const, value: 'No date at all' },
        g: { kind: 'iri' as const, value: 'urn:kbase:source/sweep-seed' },
        sourceId: 'sweep-seed',
        confidence: 1,
        status: 'confirmed' as const,
        createdAt: 1,
        updatedAt: 1,
      }]);
      db.close();
    });
    await page.reload();
    await page.locator('.kb-list').waitFor({ timeout: 15_000 });

    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('3650');
    await expect(page.getByTestId('sweep-plan')).toContainText('undated');
  });

  test('refuses a threshold of zero instead of sweeping the graph', async ({ page }) => {
    await page.locator('.kb-sweep-toggle').click();
    await page.locator('.kb-sweep-field input').fill('0');

    await expect(page.getByTestId('sweep-plan')).toContainText('positive number of days');
    await expect(page.locator('.kb-sweep-run')).toHaveCount(0);
    expect(await workingGraphIds(page)).toHaveLength(4);
  });
});
