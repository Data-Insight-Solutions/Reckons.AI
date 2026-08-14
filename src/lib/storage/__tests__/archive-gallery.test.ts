/**
 * Archive/parent pairing for the graph settings gallery (F97.1).
 *
 * The interesting cases are not "an archive sits under its parent" — that is one line of code.
 * They are the ones where the link is imperfect: a legacy archive linked by NAME instead of
 * stable ID, an archive whose parent has been removed from the registry, and a name collision
 * between two graphs. Each of those can either lose history from the screen or attach it to the
 * wrong graph, so each has a test.
 */
import { describe, it, expect } from 'vitest';
import {
  groupGraphsWithArchives,
  groupRows,
  isArchiveEntry,
  type ArchiveGroup,
} from '../archive-gallery';
import type { KbEntry } from '../kb-registry';

const kb = (over: Partial<KbEntry> & { id: string }): KbEntry => ({
  name: over.id,
  createdAt: 0,
  ...over,
});

const groupFor = (groups: ArchiveGroup[], id: string) =>
  groups.find((g) => g.parent.id === id);

describe('isArchiveEntry', () => {
  it('identifies an archive by its archiveOf link', () => {
    expect(isArchiveEntry(kb({ id: 'a', archiveOf: 'stable-1' }))).toBe(true);
    expect(isArchiveEntry(kb({ id: 'b' }))).toBe(false);
  });

  it('does not treat a blank link as an archive', () => {
    // An empty string is a broken write, not a claim of parentage.
    expect(isArchiveEntry(kb({ id: 'a', archiveOf: '   ' }))).toBe(false);
  });

  it('ignores the (archives) name suffix', () => {
    // The name is display text any user can type; only archiveOf is written by ensureArchiveKb.
    expect(isArchiveEntry(kb({ id: 'a', name: 'Research (archives)' }))).toBe(false);
  });
});

describe('groupGraphsWithArchives', () => {
  it('nests an archive under the parent it is linked to', () => {
    const groups = groupGraphsWithArchives([
      kb({ id: 'work', name: 'Research', stableId: 'stable-1' }),
      kb({ id: 'arch', name: 'Research (archives)', archiveOf: 'stable-1' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parent.id).toBe('work');
    expect(groups[0].archives.map((k) => k.id)).toEqual(['arch']);
    expect(groups[0].orphanArchive).toBe(false);
  });

  it('leaves ordinary graphs in the caller-supplied order', () => {
    // Ordering belongs to the gallery's recent/name/size sort. If this module sorted too, the
    // user's chosen order would silently lose to ours.
    const groups = groupGraphsWithArchives([
      kb({ id: 'c', lastModified: 1 }),
      kb({ id: 'a', lastModified: 999 }),
      kb({ id: 'b' }),
    ]);
    expect(groups.map((g) => g.parent.id)).toEqual(['c', 'a', 'b']);
  });

  it('adopts a legacy archive linked by parent NAME', () => {
    // ensureArchiveKb upgrades pre-stable-ID archives, which carry the parent's name.
    const groups = groupGraphsWithArchives([
      kb({ id: 'work', name: 'Research', stableId: 'stable-1' }),
      kb({ id: 'arch', name: 'Research (archives)', archiveOf: 'Research' }),
    ]);

    expect(groupFor(groups, 'work')?.archives.map((k) => k.id)).toEqual(['arch']);
  });

  it('prefers the stable-ID match over a same-named graph', () => {
    // Two graphs can share a display name; only one can hold the stable ID the archive names.
    const groups = groupGraphsWithArchives([
      kb({ id: 'impostor', name: 'stable-1' }),
      kb({ id: 'work', name: 'Research', stableId: 'stable-1' }),
      kb({ id: 'arch', name: 'Research (archives)', archiveOf: 'stable-1' }),
    ]);

    expect(groupFor(groups, 'work')?.archives.map((k) => k.id)).toEqual(['arch']);
    expect(groupFor(groups, 'impostor')?.archives).toEqual([]);
  });

  it('keeps an archive visible at top level when its parent is gone', () => {
    // The parent was removed from the registry. Hiding the archive would make its history
    // unreachable from the only page that lists graphs.
    const groups = groupGraphsWithArchives([
      kb({ id: 'arch', name: 'Research (archives)', archiveOf: 'stable-gone' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parent.id).toBe('arch');
    expect(groups[0].orphanArchive).toBe(true);
  });

  it('does not nest an archive under another archive', () => {
    // Both rows carry archiveOf. Adopting one as the other's parent would bury history a level
    // deeper on every sweep.
    const groups = groupGraphsWithArchives([
      kb({ id: 'outer', name: 'Research (archives)', stableId: 'stable-a', archiveOf: 'stable-1' }),
      kb({ id: 'inner', name: 'Research (archives) (archives)', archiveOf: 'stable-a' }),
    ]);

    expect(groups.map((g) => g.parent.id).sort()).toEqual(['inner', 'outer']);
    expect(groups.every((g) => g.archives.length === 0)).toBe(true);
    expect(groups.every((g) => g.orphanArchive)).toBe(true);
  });

  it('never treats an archive as its own parent', () => {
    // A self-referential link (archiveOf === own stableId) must orphan, not self-nest.
    const groups = groupGraphsWithArchives([
      kb({ id: 'arch', name: 'Research (archives)', stableId: 'stable-1', archiveOf: 'stable-1' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].parent.id).toBe('arch');
    expect(groups[0].orphanArchive).toBe(true);
  });

  it('orders multiple archives of one parent by most recent write', () => {
    const groups = groupGraphsWithArchives([
      kb({ id: 'work', name: 'Research', stableId: 'stable-1' }),
      kb({ id: 'old', archiveOf: 'stable-1', lastModified: 100 }),
      kb({ id: 'never' , archiveOf: 'stable-1' }),
      kb({ id: 'new', archiveOf: 'stable-1', lastModified: 900 }),
    ]);

    // A graph with no lastModified has never been written to, so it sorts last rather than
    // pretending to be from 1970 and jumping to the top.
    expect(groupFor(groups, 'work')?.archives.map((k) => k.id)).toEqual(['new', 'old', 'never']);
  });

  it('loses no registry row', () => {
    // The property that matters most: every graph reaches the screen exactly once, whether as a
    // parent, a nested archive, or a flagged orphan.
    const entries = [
      kb({ id: 'work', stableId: 'stable-1' }),
      kb({ id: 'arch', archiveOf: 'stable-1' }),
      kb({ id: 'solo' }),
      kb({ id: 'orphan', archiveOf: 'stable-gone' }),
    ];

    const seen = groupGraphsWithArchives(entries).flatMap(groupRows).map((k) => k.id);
    expect(seen.sort()).toEqual(['arch', 'orphan', 'solo', 'work']);
  });

  it('returns nothing for an empty registry', () => {
    expect(groupGraphsWithArchives([])).toEqual([]);
  });
});
