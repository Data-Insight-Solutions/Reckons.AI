/**
 * Graph sets (F113) — group the graph list by PURPOSE, not by creation order.
 *
 * The graphs page lists every registry row flat. At thirty graphs that is unreadable: the website
 * design graph, the website status graph that observes it, the ten docs sub-graphs they are built
 * from, and the project's own roadmap and codebase graphs all sit in one alphabet-free column,
 * ordered by whenever they happened to be imported. Nothing on screen says which graphs belong
 * together, so the reader has to already know.
 *
 * A set is a PURPOSE, and members carry a ROLE within it — the design/observed/archive shape
 * (kb:design-observed-archive) made visible in the one place a user actually manages graphs.
 *
 * ── WHERE MEMBERSHIP COMES FROM, AND WHY IT IS A FALLBACK ───────────────────────────────────
 * F113's proper answer is a declared dcat:Catalog: a graph states which set it belongs to and
 * what role it plays. That does not exist yet, and waiting for it would leave the list unusable
 * in the meantime. So membership is DERIVED FROM THE NAME, and every group records HOW it was
 * derived — a grouping the user cannot see the basis of is one they cannot correct.
 *
 * Name-derivation is genuinely weaker and this module says so rather than implying otherwise:
 * renaming a graph moves it between sets, and a graph named outside the conventions lands in
 * "Other" with nothing explaining why. Declared membership fixes both, and `declaredSet` on a
 * registry row already takes precedence here so the migration needs no rewrite of this logic.
 *
 * ── ARCHIVES STAY WITH THEIR PARENT ─────────────────────────────────────────────────────────
 * Grouping composes with `archive-gallery.ts` rather than replacing it. An archive is not a peer
 * of its parent and must never be sorted away from it, so sets contain archive GROUPS, not rows.
 *
 * Pure: registry rows in, grouped rows out. No storage, no Svelte.
 */

import { groupGraphsWithArchives, groupRows, type ArchiveGroup } from './archive-gallery';
import type { KbEntry } from './kb-registry';

/** How a graph came to be in its set. Shown to the user, because a guess must look like one. */
export type SetBasis = 'declared' | 'name' | 'ungrouped';

export interface GraphSet {
  id: string;
  /** Display name for the set. */
  title: string;
  /** Why these belong together — shown so the grouping is legible rather than magic. */
  purpose: string;
  /** Archive groups, so an archive is never separated from the graph it belongs to. */
  groups: ArchiveGroup[];
  basis: SetBasis;
  /** Total rows including archives — what the header counts. */
  rowCount: number;
}

/**
 * Name-prefix rules, most specific first.
 *
 * Deliberately few and boring. A clever matcher that guesses well most of the time produces a
 * grouping nobody can predict, and the point is legibility — a user should be able to tell why a
 * graph landed where it did without reading this file.
 */
const NAME_RULES: ReadonlyArray<{ id: string; title: string; purpose: string; match: (n: string) => boolean }> = [
  {
    id: 'website',
    title: 'Website',
    purpose: 'The published site: what it is designed to be, and what it actually contains.',
    match: (n) => n.startsWith('website'),
  },
  {
    id: 'docs',
    title: 'Documentation sources',
    purpose: 'The graphs the documentation pages are composed from.',
    match: (n) => n.startsWith('docs-') || n === 'docs-all',
  },
  {
    id: 'project',
    title: 'This project',
    purpose: 'Reckons.AI describing itself — plan, code, shipped work, and its own records.',
    match: (n) => n.startsWith('reckons-'),
  },
  {
    id: 'starters',
    title: 'Starter graphs',
    purpose: 'Example graphs for trying things out or starting from something.',
    match: (n) => n.startsWith('starter-'),
  },
];

const OTHER = {
  id: 'other',
  title: 'Other graphs',
  purpose: 'Graphs that do not belong to a declared set. Yours, most likely.',
};

/** A registry row may already declare its set; name matching is only the fallback. */
type SettableEntry = KbEntry & { declaredSet?: string };

function setFor(entry: KbEntry): { id: string; title: string; purpose: string; basis: SetBasis } {
  const declared = (entry as SettableEntry).declaredSet?.trim();
  if (declared) {
    const known = NAME_RULES.find((r) => r.id === declared);
    return known
      ? { ...known, basis: 'declared' }
      : { id: declared, title: declared, purpose: 'Declared by the graph.', basis: 'declared' };
  }

  const name = entry.name.trim().toLowerCase();
  const rule = NAME_RULES.find((r) => r.match(name));
  return rule ? { ...rule, basis: 'name' } : { ...OTHER, basis: 'ungrouped' };
}

/**
 * Group the registry into sets, keeping archives with their parents.
 *
 * Sets come back in NAME_RULES order with "Other" last, rather than by size. A stable order means
 * a user's graphs do not rearrange themselves when one set happens to grow — the list is a place
 * they navigate by memory, and reordering it is worse than a long list.
 */
export function groupIntoSets(entries: readonly KbEntry[]): GraphSet[] {
  return bucketIntoSets(groupGraphsWithArchives(entries));
}

/**
 * Bucket archive groups that a caller has ALREADY filtered and sorted.
 *
 * Separate from `groupIntoSets` so the graphs page keeps its own ordering rules — current graph
 * first, then bookmarks, then the chosen sort — and gains set headings without those rules being
 * quietly reimplemented here, where they would drift.
 */
export function bucketIntoSets(archiveGroups: readonly ArchiveGroup[]): GraphSet[] {

  const bySet = new Map<string, GraphSet>();
  for (const group of archiveGroups) {
    // The PARENT decides the set. An archive follows its graph even when its own name would
    // match a different rule, because "<parent> (archives)" inherits whatever the parent is.
    const set = setFor(group.parent);
    let bucket = bySet.get(set.id);
    if (!bucket) {
      bucket = { id: set.id, title: set.title, purpose: set.purpose, groups: [], basis: set.basis, rowCount: 0 };
      bySet.set(set.id, bucket);
    }
    bucket.groups.push(group);
    bucket.rowCount += groupRows(group).length;
    // A set holding even one declared member is a declared set; name-matching is what it fell
    // back to for the rest, and claiming otherwise would overstate the weaker basis.
    if (set.basis === 'declared') bucket.basis = 'declared';
  }

  const order = new Map(NAME_RULES.map((r, i) => [r.id, i]));
  return [...bySet.values()].sort((a, b) => {
    const ai = order.get(a.id) ?? (a.id === OTHER.id ? Number.MAX_SAFE_INTEGER : NAME_RULES.length);
    const bi = order.get(b.id) ?? (b.id === OTHER.id ? Number.MAX_SAFE_INTEGER : NAME_RULES.length);
    return ai - bi || a.title.localeCompare(b.title);
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
 * NEW database, so the list grows a second row holding an independent copy. Two graphs called
 * "reckons-roadmap" will disagree the moment either is edited, and the user has no way to tell
 * which one they are looking at from the name alone.
 *
 * This REPORTS and never removes. Which copy is the real one is a judgement about content, and a
 * heuristic that guessed wrong would delete the only edited version.
 */
export function findDuplicateGraphs(entries: readonly KbEntry[]): DuplicateGraph[] {
  const byName = new Map<string, KbEntry[]>();
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([, list]) => ({
      name: list[0].name,
      entries: [...list].sort((a, b) => (b.statementCount ?? 0) - (a.statementCount ?? 0)),
    }))
    .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}
