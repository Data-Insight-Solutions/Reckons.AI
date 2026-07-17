/**
 * Prune analysis — two lenses, one idea: what does this graph carry that it does not need?
 *
 * MAIN-GRAPH prune (analyzeNodePrune): a node earns its place two ways — by RELATIONAL STRENGTH
 * (how connected it is to the rest of the graph) and by RELEVANCE (how well it fits the graph's
 * stated title + description). A node that is weakly connected AND off-theme is clutter: it dilutes
 * the graph's meaning without adding to it. This scores every node on both axes and flags the
 * clutter — as a REVIEWABLE suggestion, never a silent delete (an agent that prunes a node the user
 * cared about has destroyed knowledge, the one thing this app exists to protect).
 *
 * REVIEW-MODE prune (analyzeSuggestionPrune): the pending queue is also a graph of a kind, and it
 * rots. This scores each pending SUGGESTION for pruning — re-derivable (a check regenerates it),
 * empty/malformed, or stale (old, blocks nothing, low priority) — so the reviewer clears the noise
 * instead of drowning in it. Shares the triage classifier so "re-derivable" means the same thing
 * everywhere.
 *
 * Both cores are DETERMINISTIC and model-free (degree + lexical overlap), so they run in CI and
 * offline. Embedding-based relevance is an optional plug-in (opts.relevance), exactly as
 * current-ranking.ts anchors on the graph's top-degree entities — pass it in at a call site that
 * has embeddings, and the core stays pure.
 */

import type { Statement } from './types';
import { isMetaPredicate } from './types';
import { classify, ageDays, isBlocking, type PendingItem } from './triage';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// ── Main-graph node prune ─────────────────────────────────────────────────────

export interface NodePruneScore {
  entity: string;
  label: string;
  /** Raw relational strength: active, non-meta, non-type edges touching the node. */
  degree: number;
  /** Degree normalized 0..1 against the graph's max degree. */
  strength: number;
  /** 0..1 fit to the graph's title + description. */
  relevance: number;
  /** 0..1 prune score — high means weakly connected AND off-theme. */
  score: number;
  /** True when the node is both weakly connected and off-theme. */
  prune: boolean;
  reason: string;
}

export interface NodePruneOptions {
  title?: string;
  description?: string;
  /** Pluggable relevance (e.g. embedding cosine). Default: lexical overlap with title+description. */
  relevance?: (label: string, entity: string) => number;
  /** strength <= this counts as weakly connected. Default 0.15. */
  strengthFloor?: number;
  /** relevance <= this counts as off-theme. Default 0.2. */
  relevanceFloor?: number;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'with', 'by', 'this', 'that', 'it', 'its', 'as', 'at', 'be', 'from']);

export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Deterministic default relevance: the FRACTION of a node's own label tokens that appear in the
 * graph theme (overlap, not Jaccard). Overlap is right here because label and theme are wildly
 * different lengths — a fully on-theme one-word label ("Espresso" under a long coffee theme) must
 * score high, which Jaccard punishes for the theme being long. Answers "is this node about the
 * theme?", not "do they share vocabulary size".
 */
function lexicalRelevance(themeTokens: Set<string>): (label: string) => number {
  return (label: string) => {
    if (themeTokens.size === 0) return 0;
    const t = new Set(tokenize(label));
    if (t.size === 0) return 0;
    let hits = 0;
    for (const w of t) if (themeTokens.has(w)) hits++;
    return hits / t.size;
  };
}

const localName = (iri: string) => iri.split(/[/#]/).pop() ?? iri;

/**
 * Score every entity for pruning by relational strength and relevance to the graph's title +
 * description. Meta/type edges and inactive statements do not count toward strength. Returns
 * every node scored (sorted most-prunable first); `.prune` marks the clutter.
 */
export function analyzeNodePrune(statements: Statement[], opts: NodePruneOptions = {}): NodePruneScore[] {
  const degree = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (isMetaPredicate(st.p.value)) continue;
    if (st.p.value === RDFS_LABEL && st.s.kind === 'iri' && st.o.kind === 'literal') {
      labels.set(st.s.value, st.o.value);
      continue;
    }
    if (st.p.value === RDF_TYPE) {
      if (st.s.kind === 'iri' && !degree.has(st.s.value)) degree.set(st.s.value, 0);
      continue;
    }
    if (st.s.kind === 'iri') degree.set(st.s.value, (degree.get(st.s.value) ?? 0) + 1);
    if (st.o.kind === 'iri') degree.set(st.o.value, (degree.get(st.o.value) ?? 0) + 1);
  }

  const maxDeg = Math.max(1, ...degree.values());
  const themeTokens = new Set([...tokenize(opts.title ?? ''), ...tokenize(opts.description ?? '')]);
  const lexical = lexicalRelevance(themeTokens);
  const relevanceOf = opts.relevance ?? ((label: string) => lexical(label));
  const strengthFloor = opts.strengthFloor ?? 0.15;
  const relevanceFloor = opts.relevanceFloor ?? 0.2;

  const scores: NodePruneScore[] = [...degree.entries()].map(([entity, deg]) => {
    const label = labels.get(entity) ?? localName(entity);
    const strength = deg / maxDeg;
    const relevance = Math.max(0, Math.min(1, relevanceOf(label, entity)));
    // A degree-0/1 node is a leaf or isolate — weakly connected almost by definition, whatever the
    // graph's scale — so it counts as weak even before the normalized floor (which catches the
    // slightly-higher-degree weak nodes in large graphs).
    const weak = deg <= 1 || strength <= strengthFloor;
    const offTheme = relevance <= relevanceFloor;
    const prune = weak && offTheme;
    const reason = prune
      ? `weakly connected (${deg} edge${deg === 1 ? '' : 's'}) and off-theme (relevance ${relevance.toFixed(2)})`
      : weak
        ? `weakly connected but on-theme — keep`
        : offTheme
          ? `off-theme but well connected — keep`
          : `well connected and on-theme`;
    return { entity, label, degree: deg, strength, relevance, score: (1 - strength) * (1 - relevance), prune, reason };
  });

  return scores.sort((a, b) => b.score - a.score);
}

// ── Review-mode suggestion prune ──────────────────────────────────────────────

export type SuggestionPruneReason = 'rederivable' | 'empty' | 'stale' | 'keep';

export interface SuggestionPruneScore {
  item: PendingItem;
  prune: boolean;
  reason: SuggestionPruneReason;
  detail: string;
}

export interface SuggestionPruneOptions {
  /** Age (days) beyond which a non-blocking, low-priority suggestion is stale. Default 14. */
  staleDays?: number;
  now?: number;
}

/**
 * Score each pending suggestion for pruning. Prunes re-derivable findings (a check regenerates
 * them), empty/malformed entries, and stale suggestions that block nothing and are not high
 * priority. Everything else — decisions, blocking items, fresh or important suggestions — is kept.
 */
export function analyzeSuggestionPrune(pending: PendingItem[], opts: SuggestionPruneOptions = {}): SuggestionPruneScore[] {
  const staleDays = opts.staleDays ?? 14;
  const now = opts.now ?? Date.now();

  return pending.map((item) => {
    // Only open (objectless) items are prunable; a resolved fact is not a suggestion.
    if (item.object != null) return { item, prune: false, reason: 'keep' as const, detail: 'resolved fact' };

    if (classify(item).kind === 'rederivable') {
      return { item, prune: true, reason: 'rederivable' as const, detail: 'a check regenerates this every run — fix the source, do not queue it' };
    }
    if (!(item.question && String(item.question).trim())) {
      return { item, prune: true, reason: 'empty' as const, detail: 'no question text — malformed/empty' };
    }
    const age = ageDays(item, now);
    if (age >= staleDays && !isBlocking(item) && item.priority !== 'high') {
      return { item, prune: true, reason: 'stale' as const, detail: `${age}d old, blocks nothing, not high priority` };
    }
    return { item, prune: false, reason: 'keep' as const, detail: 'live decision or actionable finding' };
  });
}
