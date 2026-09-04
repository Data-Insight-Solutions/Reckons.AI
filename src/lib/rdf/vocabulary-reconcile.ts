/**
 * DEFERRED GROUNDING — connect extraction to the graph AFTER the fact, as reviewable proposals.
 *
 * Matt, 2026-09-04: "grounding is necessary, but maybe it should come later, and leverage existing
 * merge analysis?" — and then, when this was written up as a roadmap phase instead of built:
 * "We can't save this for later... we need working extraction with local models yesterday."
 *
 * WHY LATER IS BETTER, MEASURED (scripts/offline/extraction-score.ts, context ladder, qwen3:32b):
 *
 *   graph context      recall    predicate reuse
 *   none                53%           0%
 *   sm / md / lg      26-32%       80-89%
 *
 * Prompt-time grounding buys vocabulary agreement and pays for it in RECALL — it roughly halves
 * the facts found. The model adopts offered vocabulary at 75-89%, which sounds like success until
 * you notice it does so even when the offered words come from an unrelated part of the graph. That
 * is not grounding, it is suggestion, and it is ungated: a prompt injection cannot be reviewed.
 *
 * So: extract UNGROUNDED for recall, then reconcile here. Matching twenty extracted predicates
 * against thirty graph predicates is a small CLOSED comparison — a far easier problem than open
 * extraction, and one a deterministic rule can mostly solve.
 *
 * SCRIPT TIER BY CONSTRUCTION (kb:work-tiering). No embeddings, no model, no tokens. That is not
 * frugality, it is a measured decision: `npm run bench:predicates` across five embedding models
 * found the shipped model catches 16.7% of synonym pairs, misses the observed case at 0.803, and
 * EVERY model had negative separation — its worst true synonym scored below its closest
 * distinct-but-different pair. Cosine cannot carry predicate reconciliation. Morphology can carry
 * the easy majority (`is-used-by` ~ `used-by`, plural, punctuation), phonetics carries mis-hearings,
 * and whatever neither settles goes to a human rather than to a guess.
 *
 * IT PROPOSES, IT DOES NOT REWRITE. This is the difference from normalize-entities.ts, which
 * rewrites incoming IRIs onto existing ones "before the user ever sees them" — a silent write that
 * kb:auto-merge exists to forbid. Everything here is classified by the SHARED merge band
 * (merge-band.ts) and only the `auto` tier is applied; `suggest` becomes a review proposal and
 * anything below the floor is left alone, because a forced link is worse than an orphan.
 */
import type { Statement } from './types';
import { classifyMerge, type MergeVerdict } from './merge-band';
import { phoneticKey, editDistance } from './vocabulary-repair';

const PROTECTED_PREFIXES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2004/02/skos/core#',
  'http://www.w3.org/2001/XMLSchema#',
];

const isProtected = (iri: string) => PROTECTED_PREFIXES.some((p) => iri.startsWith(p));

/** The trailing path segment, which is what carries the name in this project's IRIs. */
export function slugOf(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

/** Lowercase, hyphenate, de-pluralize. Short words are left alone so `is` and `gas` stay distinct. */
export function normalizeName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .map((w) => (w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join('-');
}

/**
 * Predicates additionally shed copula prefixes. Models sprinkle these on inconsistently —
 * `is-used-by` one sentence and `used-by` the next — and treating them as different predicates is
 * how one relation ends up in the graph under three names.
 */
export function normalizePredicateName(value: string): string {
  return normalizeName(value).replace(/^(is|are|was|were|has|have|had|been)-/, '');
}

export type ReconcileReason = 'exact' | 'morphological' | 'phonetic' | 'near-spelling';

export interface ReconcileProposal {
  /** IRI as extracted. */
  from: string;
  /** Existing graph IRI it appears to name. */
  to: string;
  kind: 'entity' | 'predicate';
  similarity: number;
  reason: ReconcileReason;
  verdict: MergeVerdict;
}

export interface ReconcileResult {
  /** Statements with `auto`-tier rewrites applied. Everything else is untouched. */
  statements: Statement[];
  /** Applied (auto band, >= MERGE_AUTO_THRESHOLD). Still reviewable downstream, never silent-final. */
  applied: ReconcileProposal[];
  /** Surfaced for a human (suggest band). NOT applied. */
  suggested: ReconcileProposal[];
  /** Extracted names that matched nothing — genuinely new, and that is a valid outcome. */
  unmatched: string[];
}

/**
 * Score two names, deterministically.
 *
 * The bands are chosen so that only things that are the SAME WORD land in auto. A morphological
 * match (`is-used-by` ~ `used-by`) is the same word with different grammar and is safe to apply.
 * A phonetic match ("lumen path" ~ "Lumenpath") is a probable mis-hearing and is NOT safe to apply
 * silently — it is exactly the case where a human should look, so it lands in suggest.
 */
export function scoreNames(a: string, b: string, kind: 'entity' | 'predicate'): { similarity: number; reason: ReconcileReason } | null {
  const norm = kind === 'predicate' ? normalizePredicateName : normalizeName;
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return null;

  if (na === nb) {
    // Identical raw strings are not a "match" worth proposing — there is nothing to change.
    return a === b ? null : { similarity: 1, reason: normalizeName(a) === normalizeName(b) ? 'exact' : 'morphological' };
  }

  // A shared phonetic key with different spelling is the mis-transcription case.
  const pa = phoneticKey(na);
  const pb = phoneticKey(nb);
  if (pa && pa === pb) return { similarity: 0.85, reason: 'phonetic' };

  /*
   * A DROPPED OR ADDED LEADING SYLLABLE — the decoder's signature, not a typo's.
   *
   * "A primo and binder" is how the transcript rendered "Aprimo and Bynder": the boundary moved and
   * a syllable went with it, so one name is wholly CONTAINED in the other. Edit distance sees this
   * as cheap for long names and expensive for short ones, which is backwards — `primo` inside
   * `aprimo` is one missing letter but a completely different kind of evidence than one letter
   * changed. Both sides must be >= 5 characters and the difference at most 3, so `cad` inside
   * `decade` cannot fire.
   */
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 5 && longer.length - shorter.length <= 3 && longer.includes(shorter)) {
    return { similarity: 0.8, reason: 'near-spelling' };
  }

  /*
   * Near-spelling, gated by LENGTH. One edit in a three-letter word is a different word; one edit
   * in a fifteen-letter word is a typo. Without the gate this rule merges `cad` into `dam`, which
   * is the corpus's own homophone trap. Six is the floor because `binder` ~ `bynder` is a real
   * mis-hearing at six characters, and nothing shorter is safe: at five, `owned` ~ `owner`.
   */
  const longest = Math.max(na.length, nb.length);
  if (longest >= 6) {
    const dist = editDistance(na, nb);
    const allowed = longest >= 12 ? 2 : 1;
    if (dist > 0 && dist <= allowed) {
      return { similarity: 0.8 - dist * 0.05, reason: 'near-spelling' };
    }
  }

  return null;
}

/** Every non-protected entity and predicate IRI the graph already holds. */
function graphNames(existing: Statement[]): { entities: Set<string>; predicates: Set<string> } {
  const entities = new Set<string>();
  const predicates = new Set<string>();
  for (const st of existing) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (st.s.kind === 'iri' && !isProtected(st.s.value)) entities.add(st.s.value);
    if (st.o.kind === 'iri' && !isProtected(st.o.value)) entities.add(st.o.value);
    if (!isProtected(st.p.value)) predicates.add(st.p.value);
  }
  return { entities, predicates };
}

function bestMatch(
  incomingIri: string,
  candidates: Set<string>,
  kind: 'entity' | 'predicate',
): ReconcileProposal | null {
  if (candidates.has(incomingIri)) return null; // already exactly the graph's own IRI
  let best: ReconcileProposal | null = null;
  for (const candidate of candidates) {
    const scored = scoreNames(slugOf(incomingIri), slugOf(candidate), kind);
    if (!scored) continue;
    const verdict = classifyMerge(scored.similarity);
    if (verdict === 'none') continue;
    if (!best || scored.similarity > best.similarity) {
      best = { from: incomingIri, to: candidate, kind, similarity: scored.similarity, reason: scored.reason, verdict };
    }
  }
  return best;
}

/**
 * Reconcile freshly extracted statements against the graph.
 *
 * Runs AFTER extraction and BEFORE persistence, in place of steering the extraction prompt.
 * Pure and synchronous — no network, no model — so it works offline, in tests, and on the WASM
 * path, and it does NOT disable itself on a large graph the way normalize-entities does above 500
 * entities. A mature graph is exactly when connection matters most.
 */
export function reconcileVocabulary(incoming: Statement[], existing: Statement[]): ReconcileResult {
  const identity: ReconcileResult = { statements: incoming, applied: [], suggested: [], unmatched: [] };
  if (incoming.length === 0 || existing.length === 0) return identity;

  const { entities, predicates } = graphNames(existing);
  const applied: ReconcileProposal[] = [];
  const suggested: ReconcileProposal[] = [];
  const unmatched = new Set<string>();
  const rewrite = new Map<string, string>();

  // One decision per NAME, not per occurrence. Without this a name appearing in five triples
  // produced five identical proposals, which is exactly the queue-flooding that makes a reviewer
  // stop reading (kb:work-tiering: a job that floods the queue moves cost rather than removing it).
  const decided = new Set<string>();

  const consider = (iri: string, kind: 'entity' | 'predicate', pool: Set<string>, batch: Set<string>) => {
    if (isProtected(iri) || decided.has(iri)) return;
    decided.add(iri);
    // The graph is searched first: connecting to something that already exists beats connecting to
    // something that arrived a moment ago, because the existing name is the one already reviewed.
    const match = bestMatch(iri, pool, kind) ?? bestMatch(iri, batch, kind);
    batch.add(iri);
    if (!match) {
      if (!pool.has(iri)) unmatched.add(iri);
      return;
    }
    if (match.verdict === 'auto') {
      applied.push(match);
      rewrite.set(iri, match.to);
    } else {
      // Suggest band: recorded for review, deliberately NOT applied.
      suggested.push(match);
    }
  };

  /*
   * WITHIN-BATCH TWINS — measured 2026-09-04 and the reason this loop is not just `existing`.
   *
   * The first version compared incoming names only against the graph, so two mis-heard variants of
   * ONE name arriving in the SAME note both landed as new entities and nothing noticed. On the
   * review corpus the chain harness found 8 damaged twins where this had proposed 2: `primo ~
   * aprimo` and `binder ~ bynder` (the decoder splitting "Aprimo and Bynder") are both inside note
   * 02, so neither was ever "incoming vs existing".
   *
   * Names already seen in this batch are therefore candidates too. Order matters and is stable:
   * the FIRST spelling encountered becomes the anchor, so re-running the same input proposes the
   * same direction rather than flip-flopping.
   */
  const batchEntities = new Set<string>();
  const batchPredicates = new Set<string>();

  for (const st of incoming) {
    if (st.s.kind === 'iri') consider(st.s.value, 'entity', entities, batchEntities);
    if (st.o.kind === 'iri') consider(st.o.value, 'entity', entities, batchEntities);
    consider(st.p.value, 'predicate', predicates, batchPredicates);
  }

  if (rewrite.size === 0) return { ...identity, applied, suggested, unmatched: [...unmatched] };

  const statements = incoming.map((st) => {
    const s = st.s.kind === 'iri' && rewrite.has(st.s.value) ? { ...st.s, value: rewrite.get(st.s.value)! } : st.s;
    const o = st.o.kind === 'iri' && rewrite.has(st.o.value) ? { ...st.o, value: rewrite.get(st.o.value)! } : st.o;
    const p = rewrite.has(st.p.value) ? { ...st.p, value: rewrite.get(st.p.value)! } : st.p;
    return s === st.s && o === st.o && p === st.p ? st : ({ ...st, s, p, o } as Statement);
  });

  return { statements, applied, suggested, unmatched: [...unmatched] };
}

/** One line per proposal, for the ingest summary and the offline harness. */
export function reconcileSummary(r: ReconcileResult): string {
  if (r.applied.length === 0 && r.suggested.length === 0) return 'nothing to reconcile';
  const parts: string[] = [];
  if (r.applied.length) parts.push(`${r.applied.length} connected to existing`);
  if (r.suggested.length) parts.push(`${r.suggested.length} to review`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} new`);
  return parts.join(', ');
}
