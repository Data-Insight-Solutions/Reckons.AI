/**
 * Pending-fact de-duplication — the core of F80.1 (kb:auto-merge).
 *
 * "Facts pile up while the user is away, and many are the same fact said twice by different
 * agents." The user should never triage the same finding twice. So before pending facts reach
 * the review queue, collapse the ones that are confidently identical — and, per Matt's decision
 * (2026-07-15), route them through the ONE merge band (src/lib/rdf/merge-band.ts):
 *
 *   exact same triple (after normalization)  -> similarity 1.0  -> AUTO (fold into one)
 *   same predicate, semantically near         -> [0.5, 0.9)      -> SUGGEST (surface, do not act)
 *   below the floor                           -> < 0.5           -> nothing
 *
 * Everything here is PURE: it classifies, it never writes. An auto-merge is "a suggestion the
 * graph made, not a fact the graph invented" — the caller applies it as a reviewable action, so
 * even the auto tier is undoable. That is the whole point: a destructive action must never be
 * silent (the lesson kb:predicate-manager was cured by).
 *
 * Similarity is injected (F22 entity normalization / embeddings live at the call site) so this
 * module stays deterministic and testable without a model.
 */
import type { Statement, Term } from './types';
import { classifyMerge, MERGE_AUTO_THRESHOLD, MERGE_SUGGEST_FLOOR, type MergeVerdict } from './merge-band';

export interface DuplicateGroup {
  /** 'auto' for exact-identical, 'suggest' for semantically near. */
  verdict: MergeVerdict;
  /** The similarity that produced the verdict (1.0 for an exact triple match). */
  similarity: number;
  /** The statement to keep (highest confidence, then earliest, then id — deterministic). */
  keep: Statement;
  /** The statements that fold into `keep`. */
  duplicates: Statement[];
}

/**
 * Canonicalize a term into a comparison token. Literals are trimmed, whitespace-collapsed and
 * lower-cased, but their datatype and language are KEPT — "5"^^xsd:integer and "5"@en are
 * different assertions and must not silently merge. IRIs compare by value (they are already
 * normalized entities); blank nodes compare by their own id, so two distinct bnodes never merge.
 */
export function canonicalTerm(t: Term): string {
  if (t.kind === 'literal') {
    const v = t.value.trim().replace(/\s+/g, ' ').toLowerCase();
    const dt = t.datatype ? `^^${t.datatype}` : '';
    const lang = t.lang ? `@${t.lang.toLowerCase()}` : '';
    return `lit:${v}${dt}${lang}`;
  }
  if (t.kind === 'bnode') return `bnode:${t.value}`;
  return `iri:${t.value}`;
}

export interface DedupeOptions {
  /** Plug F22 semantic normalization here; defaults to the lexical canonicalizer above. */
  canonicalize?: (t: Term) => string;
}

/** Deterministic canonical-first ordering: highest confidence, then earliest, then id. */
function pickCanonical(members: Statement[]): Statement[] {
  return [...members].sort(
    (a, b) => b.confidence - a.confidence || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * Find EXACT duplicate pending facts — the same (subject, predicate, object) after normalization.
 * These are the auto tier: similarity 1.0, verdict 'auto'. Groups are returned in deterministic
 * order (by kept id); a fact with no duplicate is not returned.
 */
export function findPendingDuplicates(statements: Statement[], opts: DedupeOptions = {}): DuplicateGroup[] {
  const canon = opts.canonicalize ?? canonicalTerm;
  const key = (s: Statement) => `${canon(s.s)}${s.p.value}${canon(s.o)}`;
  const groups = new Map<string, Statement[]>();
  for (const st of statements) {
    const k = key(st);
    const g = groups.get(k);
    if (g) g.push(st);
    else groups.set(k, [st]);
  }
  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const [keep, ...duplicates] = pickCanonical(members);
    out.push({ verdict: classifyMerge(1), similarity: 1, keep, duplicates });
  }
  return out.sort((a, b) => a.keep.id.localeCompare(b.keep.id));
}

/**
 * Find SUGGESTED merges among pending facts: pairs that share a predicate and whose subjects (or,
 * for same-subject pairs, objects) are semantically near — in the [0.5, 0.9) band. `similarity`
 * is supplied by the caller (embeddings), keeping this pure. Pairs at or above the auto threshold
 * are NOT returned here — those are exact/auto business; this tier only surfaces, it never acts.
 *
 * The predicate is the main clue to a valid link (kb:predicate-economy): we only compare facts
 * that already agree on the predicate, so a high subject similarity across different relations is
 * never mistaken for the same fact.
 */
export function findMergeSuggestions(
  statements: Statement[],
  similarity: (a: Statement, b: Statement) => number,
): DuplicateGroup[] {
  const out: DuplicateGroup[] = [];
  for (let i = 0; i < statements.length; i++) {
    for (let j = i + 1; j < statements.length; j++) {
      const a = statements[i];
      const b = statements[j];
      if (a.p.value !== b.p.value) continue; // predicate must agree
      const sim = similarity(a, b);
      if (classifyMerge(sim) !== 'suggest') continue; // only the [floor, auto) band
      const [keep, dup] = pickCanonical([a, b]);
      out.push({ verdict: 'suggest', similarity: sim, keep, duplicates: [dup] });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity || a.keep.id.localeCompare(b.keep.id));
}

/** How many review items the dedupe removes — the "never triage the same finding twice" payoff. */
export function duplicatesRemoved(groups: DuplicateGroup[]): number {
  return groups.reduce((n, g) => n + g.duplicates.length, 0);
}

/**
 * Fold exact-duplicate COMPLETE facts, returning the reduced list. PARTIAL facts (F32 questions,
 * object '?') are deliberately excluded from folding: two questions on the same subject+predicate
 * can carry different `blocks`/`question` metadata, and dropping one would silently lose what the
 * hole costs. This is the one place that rule lives — both the MCP drain and the review pipeline
 * call it, so they cannot disagree about what "duplicate" means.
 */
export function dedupeCompletePending(
  statements: Statement[],
  opts: DedupeOptions = {},
): { kept: Statement[]; folded: number; groups: DuplicateGroup[] } {
  const complete = statements.filter((s) => !s.needsObject);
  const groups = findPendingDuplicates(complete, opts);
  const dropped = new Set(groups.flatMap((g) => g.duplicates.map((d) => d.id)));
  const kept = dropped.size ? statements.filter((s) => !dropped.has(s.id)) : statements;
  return { kept, folded: dropped.size, groups };
}

export { MERGE_AUTO_THRESHOLD, MERGE_SUGGEST_FLOOR };
