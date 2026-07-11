/**
 * User Story: Local Folder Sync — two-way graph sync + the graph-package menu
 *
 * Folder sync used to be one-way (app → disk). It now also PULLS: it discovers
 * any `.ttl` anywhere under the linked folder and imports new graphs / updates
 * changed ones. The controls live in the graph menu's "graph package" section.
 *
 * The native showDirectoryPicker can't be driven headless, so this test links a
 * real OPFS (Origin Private File System) directory handle via the DEV-only
 * window hook (`__reckonsWorkspace`), seeds a nested `.ttl` into it, and asserts
 * pullFromWorkspace() imports it — a genuine in-browser round-trip.
 *
 * Flow:
 *   1. Load a graph so the graph menu renders; screenshot the package panel
 *      (folder sync in its "link a folder" state).
 *   2. Link an OPFS dir, seed kbs/synced-graph/synced-graph.ttl, pull.
 *   3. Assert the graph was imported; screenshot the connected/synced panel.
 *   4. Loop guard: a second pull with no disk change imports nothing.
 *
 * Screenshots: tests/visual/screenshots/graph-sync/
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAllKbs, screenshotTo } from '../kb-seed';

const APP = 'http://localhost:5174';

/** Seed a rendered graph the robust way: the landing page's "Getting started"
 *  button loads the everyday starter graph as confirmed facts and navigates to
 *  the graph view (no dependency on the ingest-page tab helper). */
async function seedStarterGraph(page: Page) {
  await page.goto(APP);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /getting started/i }).first().click();
  await page.waitForTimeout(3000);
  await page.goto(APP);
  await page.waitForTimeout(2500);
}

// Reach the DEV-only workspace hook exposed by src/lib/stores/workspace.svelte.ts
type WsHook = {
  __linkHandleForTest: (h: FileSystemDirectoryHandle) => void;
  pullFromWorkspace: () => Promise<{ imported: string[]; updated: string[] }>;
  workspaceState: () => string;
  syncedKbCount: () => number;
};

async function waitForHook(page: Page) {
  await page.waitForFunction(() => !!(window as any).__reckonsWorkspace, undefined, { timeout: 10_000 });
}

test.describe('Local Folder Sync', () => {
  test('graph-package menu shows folder-sync controls', async ({ page }) => {
    await clearAllKbs(page);
    await seedStarterGraph(page);

    await test.step('graph menu renders the package panel', async () => {
      // The graph-package section is part of the always-on "Filters & layout" panel.
      await expect(page.getByText('folder sync', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/graph package/i).first()).toBeVisible();
      await screenshotTo(page, 'graph-sync', '01-package-panel-unlinked');
    });
  });

  test('links an OPFS folder and pulls a new graph from disk', async ({ page }) => {
    await clearAllKbs(page);
    await seedStarterGraph(page);
    await waitForHook(page);

    const result = await test.step('seed an OPFS .ttl and pull', async () => {
      return page.evaluate(async () => {
        const ws = (window as any).__reckonsWorkspace as WsHook;
        // Fresh OPFS root scoped to this test run.
        const root = await (navigator.storage as any).getDirectory();
        // Clean any prior run.
        try { await (root as any).removeEntry('kbs', { recursive: true }); } catch { /* none */ }
        const kbs = await root.getDirectoryHandle('kbs', { create: true });
        const dir = await kbs.getDirectoryHandle('synced-graph', { create: true });
        const fh = await dir.getFileHandle('synced-graph.ttl', { create: true });
        const w = await fh.createWritable();
        await w.write(
          '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n' +
          '<urn:kbase:concept/opfs-node> rdfs:label "OPFS Synced Node" .\n'
        );
        await w.close();

        ws.__linkHandleForTest(root);
        const first = await ws.pullFromWorkspace();
        const second = await ws.pullFromWorkspace(); // loop guard: no change
        return { first, second, state: ws.workspaceState(), count: ws.syncedKbCount() };
      });
    });

    expect(result.first.imported).toContain('synced-graph');
    expect(result.state).toBe('connected');
    // Loop guard: nothing new on the second pass.
    expect(result.second.imported).toHaveLength(0);
    expect(result.second.updated).toHaveLength(0);

    await test.step('panel reflects the connected/synced state', async () => {
      await page.waitForTimeout(500);
      await expect(page.getByText(/resync now/i).first()).toBeVisible({ timeout: 10_000 });
      await screenshotTo(page, 'graph-sync', '02-package-panel-connected');
    });
  });
});
