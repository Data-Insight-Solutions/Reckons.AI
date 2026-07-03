/**
 * Currents ranking (F29.2) — personalization is the graph itself. Items
 * fetched by a current (RSS/Atom entry or watched-URL snapshot) are ranked
 * by embedding affinity to the graph's own top-degree entities, near-duplicate
 * items are collapsed, and anything the content policy blocks is dropped
 * before it ever reaches the review queue.
 *
 * `CurrentItem` is the canonical shape synced down from the n8n Currents
 * Monitor (see src/lib/integrations/n8n/currents-sync.ts) — defined here so
 * rdf/ stays the dependency root and integrations/ imports the type, not the
 * other way around.
 */

import type { Statement } from './types';
import { isMetaPredicate } from './types';
import { embedMany, cosine, cluster } from '../embed';
import { classifyText } from '../safety/content-policy';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** One fetched item from a current, as synced down from the n8n monitor. */
export interface CurrentItem {
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  sourceLabel?: string;
  currentSlug: string;
  graphStableId: string;
  fetchedAt: string;
}

export interface RankedItem extends CurrentItem {
  /** Cosine affinity (0-1) to the graph's top-degree entities. 0 when the graph has no entities yet. */
  affinity: number;
}

export interface RankOptions {
  /** Max items to return after ranking + dedupe. Default 20. */
  limit?: number;
  /** How many top-degree graph entities to use as the affinity anchor. Default 12. */
  topEntities?: number;
  /** Cosine similarity above which two items are considered near-duplicates. Default 0.92. */
  duplicateThreshold?: number;
}

function entityDisplayLabel(iriValue: string, labels: Map<string, string>): string {
  return labels.get(iriValue) ?? iriValue.split(/[/#]/).pop() ?? iriValue;
}

/**
 * Top-degree entities in the graph (by triple count, meta predicates and
 * inactive statements excluded) — used as the affinity anchor. Returns
 * display labels (rdfs:label when present, else the IRI's local name).
 */
export function topEntityLabels(graphStmts: Statement[], count: number): string[] {
  const degree = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const st of graphStmts) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (isMetaPredicate(st.p.value)) continue;
    if (st.p.value === RDFS_LABEL && st.s.kind === 'iri' && st.o.kind === 'literal') {
      labels.set(st.s.value, st.o.value);
      continue;
    }
    // rdf:type edges don't contribute to degree — otherwise category nodes
    // (Concept, Tool, ...) would dominate rankings as the "top" entities —
    // but the typed subject still counts as a candidate entity.
    if (st.p.value === RDF_TYPE) {
      if (st.s.kind === 'iri' && !degree.has(st.s.value)) degree.set(st.s.value, 0);
      continue;
    }
    if (st.s.kind === 'iri') degree.set(st.s.value, (degree.get(st.s.value) ?? 0) + 1);
    if (st.o.kind === 'iri') degree.set(st.o.value, (degree.get(st.o.value) ?? 0) + 1);
  }
  return [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([iriValue]) => entityDisplayLabel(iriValue, labels));
}

function itemText(item: CurrentItem): string {
  return [item.title, item.summary].filter(Boolean).join(' — ').slice(0, 600);
}

/**
 * Rank current items by embedding affinity to the graph's top-degree
 * entities, collapse near-duplicates (keeping the highest-affinity
 * representative), and drop anything the content policy blocks outright.
 * Never throws on an empty graph or empty item list — just returns [].
 */
export async function rankItems(
  items: CurrentItem[],
  graphStmts: Statement[],
  opts: RankOptions = {}
): Promise<RankedItem[]> {
  const limit = opts.limit ?? 20;
  const topN = opts.topEntities ?? 12;
  const dupThreshold = opts.duplicateThreshold ?? 0.92;

  const safe = items.filter((it) => classifyText(itemText(it)).rating !== 'blocked');
  if (safe.length === 0) return [];

  const itemVecs = await embedMany(safe.map(itemText));

  const entityLabels = topEntityLabels(graphStmts, topN);
  let ranked: RankedItem[];
  if (entityLabels.length === 0) {
    // No graph entities to anchor on yet — everything ties at zero affinity.
    ranked = safe.map((it) => ({ ...it, affinity: 0 }));
  } else {
    const entityVecs = await embedMany(entityLabels);
    ranked = safe.map((it, i) => {
      let best = 0;
      for (const ev of entityVecs) best = Math.max(best, cosine(itemVecs[i], ev));
      return { ...it, affinity: best };
    });
  }

  // Near-duplicate collapse: cluster by embedding similarity (single-link),
  // keep the highest-affinity representative from each cluster.
  const indices = safe.map((_, i) => i);
  const groups = cluster(indices, itemVecs, dupThreshold);
  const deduped: RankedItem[] = groups.map((group) => {
    let best = group[0];
    for (const idx of group) if (ranked[idx].affinity > ranked[best].affinity) best = idx;
    return ranked[best];
  });

  return deduped.sort((a, b) => b.affinity - a.affinity).slice(0, limit);
}
