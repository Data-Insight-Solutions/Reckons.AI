/**
 * Pairing archive graphs with the graphs whose history they hold (F97.1, graph settings page).
 *
 * An archive is a SEPARATE graph in the registry — that is what makes the node-count win real
 * (see `kb:auto-archive` scope-decision: archived facts leave the working graph's Dexie store
 * entirely). The cost of that choice is presentational: without grouping, `<name> (archives)`
 * shows up in the gallery as an unexplained sibling of the graph it belongs to, sorted between
 * unrelated graphs by whichever order the user picked. Matt's recorded decision is that it is
 * "shown alongside the parent on the graph settings page, linked back by the parent's stableId".
 *
 * This module is the pure half of that: registry rows in, groups out. It does no localStorage,
 * no Dexie and no sorting of parents — the caller owns ordering, so the gallery's existing
 * recent/name/size sort keeps working and archives simply travel with their parent.
 *
 * The one rule that is not cosmetic: an archive whose parent has left the registry is still
 * shown, at top level, flagged. Hiding it would make retained history unreachable, and
 * "retained-but-unreachable history is only technically preserved" (`kb:archive-search`).
 */
import type { KbEntry } from './kb-registry';

export interface ArchiveGroup {
  /**
   * The working graph this group is about — or, when `orphanArchive` is true, an archive standing
   * in for its own missing parent so its history stays reachable.
   */
  parent: KbEntry;
  /** Archives linked to `parent`, most recently written first. Empty for most graphs. */
  archives: KbEntry[];
  /**
   * True when `parent` is itself an archive whose linked graph is no longer in the registry.
   * The UI must say so rather than presenting it as an ordinary graph: an archive read as a
   * working graph invites edits that belong in the graph it came from.
   */
  orphanArchive: boolean;
}

/**
 * Is this registry row an archive graph?
 *
 * Keyed on `archiveOf`, never on the `(archives)` name suffix — the name is display text a user
 * can type into any graph, while `archiveOf` is written only by `ensureArchiveKb`.
 */
export function isArchiveEntry(kb: KbEntry): boolean {
  return typeof kb.archiveOf === 'string' && kb.archiveOf.trim() !== '';
}

/**
 * Resolve the graph an archive belongs to.
 *
 * `archiveOf` normally holds the parent's `stableId`, but `ensureArchiveKb` also adopts archives
 * created before stable-ID linking was enforced, and those carry the parent's NAME. Both forms
 * are live in existing registries, so both are matched — stable ID first, because a name can be
 * reused by a second graph while a stable ID cannot.
 *
 * A non-archive candidate always wins: an archive must not be adopted as another archive's
 * parent, which would nest history one level deeper every sweep.
 */
function findParent(archive: KbEntry, entries: readonly KbEntry[]): KbEntry | undefined {
  const link = archive.archiveOf?.trim();
  if (!link) return undefined;

  const candidates = entries.filter((kb) => kb.id !== archive.id);
  return (
    candidates.find((kb) => !isArchiveEntry(kb) && kb.stableId === link) ??
    candidates.find((kb) => !isArchiveEntry(kb) && kb.name === link)
  );
}

/**
 * Group registry rows so each archive travels with its parent.
 *
 * Parent order is the caller's input order — this deliberately does not sort, so the gallery's
 * existing sort and filter stay the single source of ordering. Archives within a group are
 * ordered by last write, newest first; a graph with no `lastModified` has never been written to
 * and sorts last rather than pretending to be from 1970.
 */
export function groupGraphsWithArchives(entries: readonly KbEntry[]): ArchiveGroup[] {
  const archives = entries.filter(isArchiveEntry);

  /** parent id → its archives. */
  const byParent = new Map<string, KbEntry[]>();
  /** Archives with no parent left in the registry — promoted to top level below. */
  const orphans: KbEntry[] = [];

  for (const archive of archives) {
    const parent = findParent(archive, entries);
    if (!parent) {
      orphans.push(archive);
      continue;
    }
    const siblings = byParent.get(parent.id);
    if (siblings) siblings.push(archive);
    else byParent.set(parent.id, [archive]);
  }

  const byRecentWrite = (a: KbEntry, b: KbEntry) => (b.lastModified ?? 0) - (a.lastModified ?? 0);
  const orphanIds = new Set(orphans.map((k) => k.id));

  const groups: ArchiveGroup[] = [];
  for (const kb of entries) {
    // A grouped archive is rendered inside its parent's group, not as its own row.
    if (isArchiveEntry(kb) && !orphanIds.has(kb.id)) continue;
    groups.push({
      parent: kb,
      archives: [...(byParent.get(kb.id) ?? [])].sort(byRecentWrite),
      orphanArchive: orphanIds.has(kb.id),
    });
  }
  return groups;
}

/**
 * Every row a group puts on screen, parent first.
 *
 * The gallery needs this for the things that count rows rather than groups — "N hidden by
 * filter", and any check that a graph is reachable at all.
 */
export function groupRows(group: ArchiveGroup): KbEntry[] {
  return [group.parent, ...group.archives];
}
