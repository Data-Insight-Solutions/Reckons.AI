/**
 * Graph sets (F113) — group the graph list by PURPOSE, for ANY user's graphs.
 *
 * A flat list stops being readable somewhere around a dozen graphs: nothing on screen says which
 * graphs belong together, so the reader has to already know. Sets fix that — and this module's
 * whole job is to do it without knowing anything about a particular person's naming.
 *
 * ── WHY THIS WAS REWRITTEN ──────────────────────────────────────────────────────────────────
 * The first version hardcoded rules for `website`, `docs-`, `reckons-` and `starter-` — this
 * repository's own conventions, baked into the product. It grouped one developer's graphs
 * beautifully and every other user's not at all, and it invented purpose text ("Reckons.AI
 * describing itself") for graphs it had no business describing. That is building the application
 * for one project. Sets are now DATA, and the fallback is derived from whatever the user actually
 * named things.
 *
 * ── THREE SOURCES OF MEMBERSHIP, most authoritative first ───────────────────────────────────
 *
 *   1. DECLARED   the graph says which set it is in (`declaredSet`). F113's eventual
 *                 dcat:Catalog answer lands here and needs no change to this logic.
 *   2. DEFINED    the user made a set and either listed members or gave it a prefix to match.
 *   3. FOLDER     the sub-directory the graph is synced from. A folder the user physically made
 *                 and dragged graphs into is a statement of intent, and a stronger one than a
 *                 coincidence of spelling — so it outranks the name-prefix guess below it.
 *   4. DERIVED    a shared name prefix, found in the names as they are. Generic: "trip-2024" and
 *                 "trip-2025" cluster for the same reason "docs-llm" and "docs-features" do.
 *
 * Anything unmatched lands in one clearly-labelled leftover group, never silently.
 *
 * ── WHAT THIS MODULE WILL NOT DO ────────────────────────────────────────────────────────────
 * It will not write a PURPOSE for a set it derived. A purpose is an editorial claim about what
 * graphs are for, and guessing one is how a tool starts telling users what their own data means.
 * Derived sets get a title from the prefix and nothing else; the user supplies the purpose or it
 * stays empty.
 *
 * Pure: registry rows and set definitions in, grouped rows out. No storage, no Svelte.
 */

import { groupGraphsWithArchives, groupRows, type ArchiveGroup } from './archive-gallery';
import type { KbEntry } from './kb-registry';

/** How a graph came to be in its set. Shown to the user, because a guess must look like one. */
export type SetBasis = 'declared' | 'defined' | 'folder' | 'derived' | 'ungrouped';

/** A set the USER defined. Stored as data, never compiled in. */
export interface GraphSetDefinition {
  id: string;
  title: string;
  /** The user's own words. Empty is fine; invented is not. */
  purpose?: string;
  /** Explicit membership by registry id — beats any pattern. */
  memberIds?: string[];
  /** Case-insensitive name prefix. The simplest rule that covers most real naming. */
  prefix?: string;
}

export interface GraphSet {
  id: string;
  title: string;
  /** Only ever the user's words, or empty. Never generated. */
  purpose: string;
  /** Archive groups, so an archive is never separated from the graph it belongs to. */
  groups: ArchiveGroup[];
  basis: SetBasis;
  /** Total rows including archives — what the header counts. */
  rowCount: number;
}

/** A registry row may declare its own set membership, and may remember where it was synced from. */
type SettableEntry = KbEntry & { declaredSet?: string; folderPath?: string };

const UNGROUPED_ID = '__ungrouped__';

/**
 * The sub-directory a synced graph should be grouped under, or null.
 *
 * A GRAPH'S OWN FOLDER IS NOT A SET; A FOLDER THAT CONTAINS GRAPHS IS. The workspace convention
 * writes `kbs/{name}/{name}.ttl`, so the deepest directory is usually just the graph's own name
 * repeated — grouping on that would give every graph a set of one, which is a flat list wearing
 * headings. So the graph's own folder is dropped, and so is the top-level `kbs/` wrapper that
 * every conventional graph shares and which therefore separates nothing.
 *
 *   kbs/clients/acme/acme.ttl  →  "clients"    a folder the user made to hold client graphs
 *   kbs/acme/acme.ttl          →  null          the convention, not a grouping
 *   research/notes.ttl         →  "research"    a loose file in a folder of the user's own
 *   notes.ttl                  →  null          the workspace root groups nothing
 *
 * @param folderPath  directory segments, joined with "/" — no filename.
 * @param graphName   the graph's folder/file name, so its own folder can be recognised.
 */
export function folderSetOf(folderPath: string | undefined, graphName: string): string | null {
  if (!folderPath) return null;
  const segs = folderPath.split('/').map((x) => x.trim()).filter(Boolean);
  if (!segs.length) return null;
  // The graph's own folder, when the convention put one there.
  if (segs[segs.length - 1] && normalize(segs[segs.length - 1]) === normalize(graphName)) segs.pop();
  // The shared `kbs/` wrapper separates nothing, so it is never a set on its own.
  if (segs.length && normalize(segs[0]) === 'kbs') segs.shift();
  if (!segs.length) return null;
  // The DEEPEST remaining folder is the most specific thing the user expressed.
  return segs[segs.length - 1];
}

const normalize = (s: string) => s.trim().toLowerCase();

/**
 * Split a graph name into its leading token.
 *
 * Separators are the ones people actually use in names — hyphen, underscore, space, slash, colon.
 * A name with no separator has no prefix and will not cluster, which is correct: "Research" and
 * "Recipes" share letters and nothing else, and clustering on that would produce groups whose
 * logic no user could follow.
 */
function namePrefix(name: string): string | null {
  const match = /^([^\s\-_/:]+)[\s\-_/:]/.exec(normalize(name));
  return match ? match[1] : null;
}

/** Title-case a derived prefix for display, without claiming to know what it means. */
function titleFromPrefix(prefix: string): string {
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * Suggest sets from the names as they actually are.
 *
 * Generic by construction: it reads the user's own naming rather than a list this project happens
 * to use. `minMembers` of 2 is the smallest number that means anything — a "set" of one is just a
 * graph with a heading over it, which adds a row of chrome and no information.
 *
 * Exported so a settings screen can OFFER these as sets the user then owns, rather than the
 * grouping being permanently implicit.
 */
export function suggestSetsFromNames(
  entries: readonly KbEntry[],
  minMembers = 2,
): GraphSetDefinition[] {
  const candidates = new Set<string>();
  for (const entry of entries) {
    const prefix = namePrefix(entry.name);
    if (prefix) candidates.add(prefix);
  }

  // A name that IS the prefix counts as a member of its own cluster. Without this, "website" and
  // "website-status" refuse to group: only the second has a separator, so the first never counted
  // toward the prefix it exactly matches — and a design graph sitting apart from the status graph
  // that observes it is precisely the pairing this feature exists to show.
  const counts = new Map<string, number>();
  for (const prefix of candidates) {
    const n = entries.filter((e) => {
      const name = normalize(e.name);
      return name === prefix || namePrefix(name) === prefix;
    }).length;
    counts.set(prefix, n);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minMembers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix]) => ({ id: `derived:${prefix}`, title: titleFromPrefix(prefix), prefix }));
}

function matchDefinition(
  entry: KbEntry,
  definitions: readonly GraphSetDefinition[],
): GraphSetDefinition | null {
  // Explicit membership beats a pattern: a user who listed a graph by id meant that graph, even
  // if some other set's prefix also happens to match its name.
  const byId = definitions.find((d) => d.memberIds?.includes(entry.id));
  if (byId) return byId;

  const name = normalize(entry.name);
  // Longest prefix wins, so a narrower set ("trip-2024") beats a broader one ("trip").
  return definitions
    .filter((d) => d.prefix && name.startsWith(normalize(d.prefix)))
    .sort((a, b) => (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0))[0] ?? null;
}

export interface GroupOptions {
  /** Sets the user defined. Checked before anything is derived. */
  definitions?: readonly GraphSetDefinition[];
  /**
   * Cluster the leftovers by shared name prefix. On by default because it is what makes the list
   * readable out of the box; a user who has defined their own sets can turn it off.
   */
  deriveFromNames?: boolean;
  /**
   * Group synced graphs by the sub-directory they came from. On by default: a folder the user made
   * is a statement of intent, and ignoring it would mean the list disagrees with the filesystem
   * the user just organised.
   */
  groupByFolder?: boolean;
  /** Label for graphs matching nothing. The caller owns the wording. */
  ungroupedTitle?: string;
}

/** Group the registry into sets, keeping archives with their parents. */
export function groupIntoSets(
  entries: readonly KbEntry[],
  options: GroupOptions = {},
): GraphSet[] {
  return bucketIntoSets(groupGraphsWithArchives(entries), options, entries);
}

/**
 * Bucket archive groups a caller has ALREADY filtered and sorted.
 *
 * Separate from `groupIntoSets` so a page keeps its own ordering rules — current graph first,
 * bookmarks, then the chosen sort — and gains set headings without those rules being
 * reimplemented here, where they would drift.
 */
export function bucketIntoSets(
  archiveGroups: readonly ArchiveGroup[],
  options: GroupOptions = {},
  allEntries?: readonly KbEntry[],
): GraphSet[] {
  const defined = options.definitions ?? [];
  const derive = options.deriveFromNames ?? true;

  // Derivation reads the WHOLE registry when available, so a set does not appear and vanish as
  // the user types into the filter box.
  const parents = archiveGroups.map((g) => g.parent);
  const derived = derive ? suggestSetsFromNames(allEntries ?? parents) : [];

  const bySet = new Map<string, GraphSet>();
  const order: string[] = [];

  for (const group of archiveGroups) {
    // The PARENT decides the set. An archive follows its graph even when its own name would match
    // a different rule — "<parent> (archives)" inherits whatever its parent is.
    const entry = group.parent;
    const declared = (entry as SettableEntry).declaredSet?.trim();

    let id: string;
    let title: string;
    let purpose = '';
    let basis: SetBasis;

    const definition = declared
      ? defined.find((d) => d.id === declared) ?? null
      : matchDefinition(entry, defined);

    if (declared) {
      const d = definition;
      id = declared;
      title = d?.title ?? declared;
      purpose = d?.purpose ?? '';
      basis = 'declared';
    } else if (definition) {
      id = definition.id;
      title = definition.title;
      purpose = definition.purpose ?? '';
      basis = 'defined';
    } else if (options.groupByFolder !== false && folderSetOf((entry as SettableEntry).folderPath, entry.name)) {
      const folder = folderSetOf((entry as SettableEntry).folderPath, entry.name)!;
      id = `folder:${normalize(folder)}`;
      title = folder;
      // No purpose, for the same reason a derived set gets none: a folder name is not a statement
      // about what the graphs inside it MEAN, and inventing one would be the tool talking over
      // the user about their own data.
      basis = 'folder';
    } else {
      const match = matchDefinition(entry, derived);
      if (match) {
        id = match.id;
        title = match.title;
        // Deliberately no purpose. Guessing what someone's graphs are FOR is how a tool starts
        // telling users what their own data means.
        basis = 'derived';
      } else {
        id = UNGROUPED_ID;
        title = options.ungroupedTitle ?? 'Ungrouped';
        basis = 'ungrouped';
      }
    }

    let bucket = bySet.get(id);
    if (!bucket) {
      bucket = { id, title, purpose, groups: [], basis, rowCount: 0 };
      bySet.set(id, bucket);
      order.push(id);
    }
    bucket.groups.push(group);
    bucket.rowCount += groupRows(group).length;
    // A set holding a declared or user-defined member is reported at that stronger basis;
    // claiming the reverse would overstate a guess.
    if (basis === 'declared') bucket.basis = 'declared';
    else if (basis === 'defined' && bucket.basis === 'derived') bucket.basis = 'defined';
    if (purpose && !bucket.purpose) bucket.purpose = purpose;
  }

  // User-defined sets keep the order the user put them in; derived ones follow alphabetically;
  // the leftovers are always last. Stable, so the list does not rearrange as sets grow.
  const definedOrder = new Map(defined.map((d, i) => [d.id, i]));
  return [...bySet.values()].sort((a, b) => {
    if (a.id === UNGROUPED_ID) return 1;
    if (b.id === UNGROUPED_ID) return -1;
    const ai = definedOrder.get(a.id);
    const bi = definedOrder.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.title.localeCompare(b.title);
  });
}

export interface DuplicateGraph {
  name: string;
  entries: KbEntry[];
}

/**
 * Graphs sharing a name but not an id.
 *
 * Worth surfacing rather than silently rendering twice: importing the same source again mints a
 * NEW database, so the list grows a second row holding an independent copy. Two graphs with one
 * name will disagree the moment either is edited, and the name alone cannot tell you which you
 * are looking at.
 *
 * REPORTS, never removes. Which copy is the real one is a judgement about content, and a
 * heuristic that guessed wrong would delete the only edited version.
 */
export function findDuplicateGraphs(entries: readonly KbEntry[]): DuplicateGraph[] {
  const byName = new Map<string, KbEntry[]>();
  for (const entry of entries) {
    byName.set(normalize(entry.name), [...(byName.get(normalize(entry.name)) ?? []), entry]);
  }
  return [...byName.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({
      name: list[0].name,
      entries: [...list].sort((a, b) => (b.statementCount ?? 0) - (a.statementCount ?? 0)),
    }))
    .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}
