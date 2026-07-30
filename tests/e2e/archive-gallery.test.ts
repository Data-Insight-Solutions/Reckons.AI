/**
 * Archive graphs are shown beside the graph whose history they hold (F97.1, /kb gallery).
 *
 * The pure grouping is unit-tested in `src/lib/storage/__tests__/archive-gallery.test.ts`. What
 * needs a browser is the claim the unit tests cannot make: that a seeded archive registry row
 * actually RENDERS nested under its parent instead of as a peer card, and that an orphaned
 * archive still reaches the screen. A grouping function that is right while the page shows
 * something else would satisfy the unit tests and fail the user.
 */
import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

const ARCHIVE_ID = 'kbase_archive_gallery_e2e';
const ORPHAN_ID = 'kbase_orphan_gallery_e2e';
const PEER_ID = 'kbase_peer_gallery_e2e';

/**
 * Seed the registry with: an archive of the default graph, an unrelated peer graph, and an
 * archive whose parent stable ID matches nothing.
 */
async function seedRegistry(page: Page): Promise<void> {
  // The default graph's stableId is written on first boot; without it the archive link has
  // nothing to point at and the test would prove nothing.
  await page.waitForFunction(() => {
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    return !!registry.find(
      (entry: { id: string; stableId?: string }) => entry.id === 'kbase' && entry.stableId,
    );
  });

  await page.evaluate(
    ({ archiveId, orphanId, peerId }) => {
      const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
      const parent = registry.find((entry: { id: string }) => entry.id === 'kbase');
      if (!parent?.stableId) throw new Error('Default graph stable ID was not registered');

      registry.push(
        {
          id: archiveId,
          name: `${parent.name} (archives)`,
          createdAt: Date.now(),
          lastModified: Date.now(),
          statementCount: 42,
          archiveOf: parent.stableId,
        },
        // A plain graph that must keep sorting as a top-level card.
        { id: peerId, name: 'Unrelated Peer Graph', createdAt: Date.now(), statementCount: 7 },
        // Its parent is not in the registry at all.
        {
          id: orphanId,
          name: 'Deleted Project (archives)',
          createdAt: Date.now(),
          archiveOf: 'stable-id-that-does-not-exist',
        },
      );
      localStorage.setItem('kbRegistry', JSON.stringify(registry));
    },
    { archiveId: ARCHIVE_ID, orphanId: ORPHAN_ID, peerId: PEER_ID },
  );
}

test.describe('archive gallery grouping', () => {
  test.beforeEach(async ({ page }) => {
    await clearStorage(page);
    await waitForApp(page);
    await seedRegistry(page);
    await page.goto('/kb');
    await page.locator('.kb-list').waitFor({ timeout: 15_000 });
  });

  test('renders the archive nested inside its parent group, not as a peer card', async ({ page }) => {
    const parentGroup = page.locator('.kb-group.has-archives');
    await expect(parentGroup).toHaveCount(1);

    // The archive row lives INSIDE the group that owns the parent card.
    const archiveRow = parentGroup.locator('.kb-archive-row');
    await expect(archiveRow).toHaveCount(1);
    await expect(archiveRow).toContainText('(archives)');
    await expect(archiveRow.locator('.archive-badge')).toHaveText('archive');

    // …and it is NOT rendered as its own top-level card.
    const topLevelNames = await page.locator('.kb-group > .kb-entry .kb-entry-name').allTextContents();
    expect(topLevelNames.some((n) => n.includes('(archives)') && !n.includes('Deleted Project'))).toBe(false);

    // The parent's own card is still there, with the archive attached below it.
    await expect(parentGroup.locator('.kb-entry .kb-entry-name')).not.toContainText('(archives)');
  });

  test('shows how much history the archive holds', async ({ page }) => {
    // A row that only said "archive" would tell the user nothing about whether it is worth opening.
    const archiveRow = page.locator('.kb-group.has-archives .kb-archive-row');
    await expect(archiveRow.locator('.kb-entry-size')).toContainText('42 facts');
    await expect(archiveRow.getByRole('button', { name: 'open' })).toBeVisible();
  });

  test('keeps an orphaned archive visible and says its parent is missing', async ({ page }) => {
    // Retained-but-unreachable history is only technically preserved, so the orphan must still
    // be listed — and labelled, so it is not mistaken for a working graph.
    const orphanCard = page
      .locator('.kb-group > .kb-entry')
      .filter({ hasText: 'Deleted Project (archives)' });

    await expect(orphanCard).toHaveCount(1);
    await expect(orphanCard.locator('.archive-badge.orphan')).toContainText('parent missing');
    await expect(orphanCard).toHaveClass(/orphan-archive/);
  });

  test('leaves an unrelated graph as a top-level card with no archives', async ({ page }) => {
    const peer = page.locator('.kb-group').filter({ hasText: 'Unrelated Peer Graph' });
    await expect(peer).toHaveCount(1);
    await expect(peer).not.toHaveClass(/has-archives/);
    await expect(peer.locator('.kb-archive-row')).toHaveCount(0);
  });

  test('archive row controls meet the 44px touch minimum on a narrow viewport', async ({ page }) => {
    // The app already carries a backlog of sub-44px targets (F36). A nested row is not an excuse
    // for a smaller target, and this pins it so the new controls cannot join that backlog. The
    // 44px rule is a TOUCH rule, so it is asserted at a phone viewport, not on desktop.
    await page.setViewportSize({ width: 412, height: 915 });
    const controls = page.locator('.kb-group.has-archives .kb-archive-actions > *');
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(box, `control ${i} has no box`).not.toBeNull();
      expect(box!.height, `control ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('search finds a parent by its archive, and the group stays intact', async ({ page }) => {
    // Searching the archive's own name must not strand it: the row renders inside its parent's
    // group, so hiding the parent would hide the archive too.
    await page.locator(".kb-search").fill('Deleted Project');
    await expect(page.locator('.kb-group')).toHaveCount(1);
    await expect(page.locator('.kb-group')).toContainText('Deleted Project (archives)');

    await page.locator(".kb-search").fill('Unrelated Peer');
    await expect(page.locator('.kb-group')).toHaveCount(1);
    await expect(page.locator('.kb-group')).toContainText('Unrelated Peer Graph');
  });
});
