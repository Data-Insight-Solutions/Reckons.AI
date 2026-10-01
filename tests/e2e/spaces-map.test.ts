import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * THE SPACES MAP (F218 kb:meta-graph-view, phase 1) IN A REAL BROWSER.
 *
 * Until this file the map had unit tests for its layout (space-graph.test.ts) and one manual
 * screenshot run (2026-09-29). It is a 0.2.5 headline feature, and the bug Matt hit on first use —
 * "no visual of the edges between spaces" — was in the part no unit test reaches: other spaces are
 * only read in the background once the Spaces tab opens.
 *
 * The spaces are written the way the app writes them: a registry entry (createKb) and, for a space
 * that lives on this device, its own IndexedDB database holding its settings and statements. The
 * modules are imported from the dev server, so the schema is the app's own rather than a copy.
 */

const GARDEN = 'Garden plans';
const SEEDS = 'Seed library';
const ELSEWHERE = 'Allotment notes';
// Leaps target a space by its stable id, never by its database name.
const SEEDS_STABLE_ID = '5eed5eed-0000-4000-8000-000000000002';

async function seedSpaces(page: Page): Promise<void> {
  await page.evaluate(async ({ garden, seeds, elsewhere, seedsStableId }) => {
    // A variable path keeps the type checker from resolving a dev-server URL.
    const registryPath = '/src/lib/storage/kb-registry.ts';
    const dbPath = '/src/lib/storage/db.ts';
    const reg = await import(/* @vite-ignore */ registryPath);
    const { KBaseDB, DEFAULT_SETTINGS } = await import(/* @vite-ignore */ dbPath);

    const now = Date.now();
    const iri = (value: string) => ({ kind: 'iri', value });
    const stmt = (id: string, s: string, p: string, o: { kind: string; value: string }) => ({
      id, s: iri(s), p: iri(p), o, g: iri('urn:kbase:source/e2e'),
      sourceId: 'e2e', confidence: 1, status: 'confirmed', createdAt: now,
    });

    async function write(id: string, stableId: string, statements: unknown[]) {
      const db = new KBaseDB(id);
      await db.settings.put({ ...DEFAULT_SETTINGS, kbStableId: stableId });
      await db.statements.bulkPut(statements);
      db.close();
    }

    const a = reg.createKb(garden);
    const b = reg.createKb(seeds);
    await write(a.id, '9a7de000-0000-4000-8000-000000000001', [
      stmt('g1', 'urn:kbase:concept/tomato', 'urn:kbase:predicate/needs', iri('urn:kbase:concept/full-sun')),
      // One jump from the garden to the seed library.
      stmt('g2', 'urn:kbase:concept/tomato', 'urn:reckons:leap', { kind: 'literal', value: seedsStableId }),
    ]);
    await write(b.id, seedsStableId, [
      stmt('s1', 'urn:kbase:concept/tomato-seed', 'urn:kbase:predicate/saved-in', iri('urn:kbase:concept/2026')),
    ]);
    // Registered here but with no database on this device, as a space known only from a synced folder.
    reg.createKb(elsewhere);
  }, { garden: GARDEN, seeds: SEEDS, elsewhere: ELSEWHERE, seedsStableId: SEEDS_STABLE_ID });
}

function starfish(page: Page, name: string) {
  return page.getByRole('group', { name: 'Map of your spaces and the leaps between them' })
    .getByRole('button', { name: new RegExp(`^${name}:`) });
}

test.describe('Spaces map', () => {
  test.beforeEach(async ({ page }) => {
    await clearStorage(page);
    await waitForApp(page);
    await seedSpaces(page);
    await page.goto('/kb');
  });

  test('draws a line between two spaces once it has read them, without being asked', async ({ page }) => {
    await expect(page.getByRole('group', { name: 'Map of your spaces and the leaps between them' })).toBeVisible();
    // Reading happens in the background; no button has to be pressed (Matt, 2026-09-29).
    await expect(starfish(page, GARDEN)).toHaveAccessibleName(/1 connected space(,|$)/, { timeout: 15_000 });
    await expect(starfish(page, SEEDS)).toHaveAccessibleName(/1 connected space(,|$)/);

    const edges = page.locator('.spaces-map line.edge');
    await expect(edges).toHaveCount(1);
    // The line keeps a count per direction: one jump from the garden, none back.
    await expect(edges.locator('title')).toHaveText(
      new RegExp(`${GARDEN} → ${SEEDS}: 1 · ${SEEDS} → ${GARDEN}: 0|${SEEDS} → ${GARDEN}: 0 · ${GARDEN} → ${SEEDS}: 1`),
    );
  });

  test('a space not on this device is drawn as not read, and said to be elsewhere', async ({ page }) => {
    await expect(starfish(page, ELSEWHERE)).toHaveAccessibleName(/not read yet/, { timeout: 15_000 });
    await expect(page.locator('.spaces-map')).toContainText('1 not on this device yet');
    // It is not described as having no connections: unknown is not zero.
    await expect(starfish(page, ELSEWHERE)).not.toHaveAccessibleName(/connected space/);
  });

  test('selecting a space lists its connections, and a connection selects that space', async ({ page }) => {
    await expect(starfish(page, GARDEN)).toHaveAccessibleName(/1 connected space/, { timeout: 15_000 });
    // Click the starfish itself. The node's box also spans its label, so the box's centre can fall on
    // the tide pool behind it; a person aims at the starfish, and so does this.
    await starfish(page, GARDEN).locator('circle.hit').click();
    await expect(starfish(page, GARDEN)).toHaveAttribute('aria-pressed', 'true');

    const detail = page.locator('.map-detail');
    await detail.getByRole('button', { name: SEEDS, exact: true }).click();
    await expect(starfish(page, SEEDS)).toHaveAttribute('aria-pressed', 'true');
    await expect(starfish(page, GARDEN)).toHaveAttribute('aria-pressed', 'false');
  });

  test('a starfish is reachable and selectable from the keyboard', async ({ page }) => {
    const seeds = starfish(page, SEEDS);
    await seeds.focus();
    await page.keyboard.press('Enter');
    await expect(seeds).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(seeds).toHaveAttribute('aria-pressed', 'false');
  });
});
