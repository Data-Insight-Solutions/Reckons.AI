import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * MULTI-SESSION / MULTI-TAB — two tabs, one browser profile, shared storage.
 *
 * Reckons.AI actively invites multi-tab use: the graph list renders an
 * "Open {name} in a new browser tab" button (kb/+page.svelte:749), and KB
 * resolution is deliberately per-tab (sessionStorage → localStorage, db.ts:246).
 * But as of this file there is NO cross-tab coordination anywhere in src/:
 * no `storage` event listener, no BroadcastChannel, no Dexie liveQuery.
 *
 * These tests characterize what that actually costs the user. They are written
 * BEFORE the fix, deliberately (Matt: "test first, then fix"), so the shape of
 * the defect is pinned down by observation rather than assumption.
 *
 * Tests marked `test.fail()` are KNOWN-BROKEN and expected to fail. Playwright
 * reports them as passing while broken, and LOUDLY flags them the moment they
 * start passing — so whoever lands the sync layer gets told which gaps closed.
 * Delete the `test.fail()` line as each one is genuinely fixed.
 *
 * Two pages in ONE BrowserContext = two real tabs of the same browser profile,
 * sharing localStorage and IndexedDB. (Two *contexts* would be two profiles,
 * which is a different and much less interesting scenario.)
 */

const REGISTRY_KEY = 'kbRegistry';

/** Read the raw registry as the app stores it. */
async function readRegistry(page: Page): Promise<Array<{ id: string; name: string }>> {
  return page.evaluate((key) => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]'); }
    catch { return []; }
  }, REGISTRY_KEY);
}

/**
 * Create a graph the way the app does.
 *
 * `createKb()` (kb-registry.ts:132) is a pure read-modify-write of the
 * `kbRegistry` localStorage key, so writing that key IS the operation — no UI
 * coupling, and it still fires the cross-tab `storage` event in the other tab
 * exactly as a real user action would.
 */
async function createGraphInTab(page: Page, name: string): Promise<string> {
  return page.evaluate(({ key, name }) => {
    const id = `kbase_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const reg = JSON.parse(localStorage.getItem(key) ?? '[]');
    reg.push({ id, name, createdAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(reg));
    return id;
  }, { key: REGISTRY_KEY, name });
}

test.describe('multi-tab: graph registry', () => {
  test('CONTROL — a graph created in tab A is persisted and visible to tab B after reload', async ({ context }) => {
    const tabA = await context.newPage();
    await clearStorage(tabA);
    await waitForApp(tabA);

    const tabB = await context.newPage();
    await waitForApp(tabB);
    await tabB.goto('/kb');

    await createGraphInTab(tabA, 'Persistence Check');

    // Storage is genuinely shared — tab B sees it once it re-reads.
    await tabB.reload();
    await expect(tabB.getByText('Persistence Check').first()).toBeVisible({ timeout: 10_000 });

    // ...and it really is in the shared registry, from tab B's own perspective.
    expect((await readRegistry(tabB)).map(k => k.name)).toContain('Persistence Check');

    await tabA.close();
    await tabB.close();
  });

  // KNOWN BROKEN: kb/+page.svelte:114 snapshots getRegistry() into $state at mount
  // and only re-reads on LOCAL actions (lines 176/181/192). No `storage` listener,
  // so tab B never learns that tab A created a graph.
  test('DEFECT — a graph created in tab A appears in tab B WITHOUT a reload', async ({ context }) => {
    test.fail();
    const tabA = await context.newPage();
    await clearStorage(tabA);
    await waitForApp(tabA);

    // Seed a graph FIRST so tab B has something to render, and we can prove the
    // list has actually mounted before tab A mutates. Without this baseline the
    // test races: goto() resolves before Svelte runs `$state(getRegistry())`,
    // so a late initializer picks up tab A's write and fakes a pass.
    await createGraphInTab(tabA, 'Baseline Graph');

    const tabB = await context.newPage();
    await waitForApp(tabB);
    await tabB.goto('/kb');
    await expect(tabB.getByText('Baseline Graph').first()).toBeVisible({ timeout: 10_000 });

    await createGraphInTab(tabA, 'Live Sync Graph');

    // No reload. A user with both tabs open expects the list to be live.
    await expect(tabB.getByText('Live Sync Graph').first()).toBeVisible({ timeout: 5_000 });

    await tabA.close();
    await tabB.close();
  });

  // KNOWN BROKEN: same missing `storage` listener. Worse than staleness — tab B
  // offers the user a graph that no longer exists in the registry.
  test('DEFECT — a graph removed in tab A disappears from tab B WITHOUT a reload', async ({ context }) => {
    test.fail();
    const tabA = await context.newPage();
    await clearStorage(tabA);
    await waitForApp(tabA);
    await createGraphInTab(tabA, 'Doomed Graph');

    const tabB = await context.newPage();
    await waitForApp(tabB);
    await tabB.goto('/kb');
    // Tab B starts out correctly showing it.
    await expect(tabB.getByText('Doomed Graph').first()).toBeVisible({ timeout: 10_000 });

    // Tab A removes it (removeKbFromRegistry — a filtered rewrite of the same key).
    await tabA.evaluate((key) => {
      const reg = JSON.parse(localStorage.getItem(key) ?? '[]');
      localStorage.setItem(key, JSON.stringify(reg.filter((k: { name: string }) => k.name !== 'Doomed Graph')));
    }, REGISTRY_KEY);

    // Tab B should stop offering a graph that is gone.
    await expect(tabB.getByText('Doomed Graph')).toHaveCount(0, { timeout: 5_000 });

    await tabA.close();
    await tabB.close();
  });
});

test.describe('multi-tab: same graph, concurrent facts', () => {
  /**
   * The default case, not an edge case: a new tab inherits
   * localStorage.currentKbId (db.ts:255), so two tabs land on the SAME graph
   * unless the user deliberately switches. Both write the same IndexedDB.
   *
   * KNOWN BROKEN: no Dexie liveQuery / observable anywhere in src/, so neither
   * tab observes the other's writes. For an app whose purpose is accumulating
   * facts, two windows silently diverging is a core-promise failure.
   */
  test('DEFECT — facts ingested in tab A are visible in tab B on the same graph', async ({ context }) => {
    test.fail();
    const tabA = await context.newPage();
    await clearStorage(tabA);
    await waitForApp(tabA);

    const tabB = await context.newPage();
    await waitForApp(tabB);

    // Both tabs are on the same graph (neither switched).
    expect(await tabA.evaluate(() => localStorage.getItem('currentKbId')))
      .toBe(await tabB.evaluate(() => localStorage.getItem('currentKbId')));

    // Tab B parks on /review BEFORE the ingest and stays there. Navigating tab B
    // after the ingest would re-read IndexedDB on mount and pass trivially —
    // that tests persistence, not live sync.
    await tabB.goto('/review');
    await expect(tabB.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });

    // Tab A ingests a distinctive fact through the mock backend.
    await tabA.goto('/ingest');
    await tabA.getByPlaceholder(/what is this about/i).first().fill('Multi Session Co');
    await tabA.locator('textarea').first().fill(
      'Multi Session Co has 42 employees and was founded in 2021 in Bristol.'
    );
    const submit = tabA.getByRole('button', { name: /extract facts/i });
    await expect(submit).not.toBeDisabled({ timeout: 5_000 });
    await submit.click();
    await tabA.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 30_000 });

    // Tab B is ALREADY on /review and does not navigate. The facts should arrive.
    await expect(tabB.getByText(/multi.session.co/i).first()).toBeVisible({ timeout: 5_000 });

    await tabA.close();
    await tabB.close();
  });
});
