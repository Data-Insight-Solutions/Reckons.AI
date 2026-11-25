/**
 * A named comparison of two documents (F306.1, urn:kbase:concept/two-source-ingest).
 *
 * The comparison is RECORDED IN THE KNOWLEDGE BASE as a handful of statements about one comparison
 * entity; it never copies or restates what either document said. Every extracted statement keeps
 * the id of the document it came from, so "only in A / only in B / shared" is later computed from
 * those ids (F306.2), not stored here. What this module owns is only the pairing: a name, the two
 * document ids, when it was made, and — when a document failed — which side failed and why, so a
 * comparison with one missing side says so instead of looking complete.
 *
 * The predicates sit under `urn:kbase:meta/` so the canvas shows them as node metadata, not as
 * edges (isMetaPredicate). The entity lives under `urn:reckons:comparison/`, deliberately not
 * `urn:kbase:concept/`: a comparison is a record of work done, not a thing the space claims to know.
 */
import type { Statement } from './types';
import { META_PREFIX } from './types';

export const COMPARISON_IRI_PREFIX = 'urn:reckons:comparison/';
export const COMPARISON_TYPE = 'urn:reckons:type/SourceComparison';
export const COMPARISON_DOCUMENT_A = `${META_PREFIX}comparison-document-a`;
export const COMPARISON_DOCUMENT_B = `${META_PREFIX}comparison-document-b`;
export const COMPARISON_MADE_AT = `${META_PREFIX}comparison-made-at`;
export const COMPARISON_FAILED_A = `${META_PREFIX}comparison-failed-a`;
export const COMPARISON_FAILED_B = `${META_PREFIX}comparison-failed-b`;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** One side of a comparison: the document that arrived, or the reason it did not. */
export type ComparisonSide = { sourceId: string } | { failed: string };

export type SourceComparison = {
  id: string;
  name: string;
  madeAt: number;
  /** The document id when that side arrived, otherwise null. */
  a: string | null;
  b: string | null;
  /** Why a side did not arrive; null when it did. */
  failedA: string | null;
  failedB: string | null;
};

const iri = (value: string) => ({ kind: 'iri' as const, value });
const lit = (value: string) => ({ kind: 'literal' as const, value });

/** Turn a typed name into a stable id fragment; the caller adds the uniqueness. */
export function comparisonId(name: string, nonce: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'comparison'}-${nonce}`;
}

/**
 * The statements that record one comparison. They are the person's own action, not an extracted
 * claim, so they are written `confirmed` rather than queued for review.
 */
export function buildComparisonStatements(input: {
  id: string;
  name: string;
  a: ComparisonSide;
  b: ComparisonSide;
  makeId: () => string;
  now?: number;
}): Statement[] {
  const now = input.now ?? Date.now();
  const subject = iri(`${COMPARISON_IRI_PREFIX}${input.id}`);
  const g = iri(`urn:kbase:comparison/${input.id}`);
  const row = (p: string, o: Statement['o']): Statement => ({
    id: input.makeId(),
    s: subject,
    p: iri(p),
    o,
    g,
    sourceId: 'comparison',
    confidence: 1,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
  });
  const out = [
    row(RDF_TYPE, iri(COMPARISON_TYPE)),
    row(RDFS_LABEL, lit(input.name.trim())),
    row(COMPARISON_MADE_AT, lit(new Date(now).toISOString())),
  ];
  const side = (s: ComparisonSide, ok: string, failed: string) => {
    if ('failed' in s) out.push(row(failed, lit(s.failed)));
    else out.push(row(ok, lit(s.sourceId)));
  };
  side(input.a, COMPARISON_DOCUMENT_A, COMPARISON_FAILED_A);
  side(input.b, COMPARISON_DOCUMENT_B, COMPARISON_FAILED_B);
  return out;
}

/** Read every recorded comparison back out of the statements, newest first. */
export function readComparisons(statements: Statement[]): SourceComparison[] {
  const by = new Map<string, Statement[]>();
  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    if (st.s.kind !== 'iri' || !st.s.value.startsWith(COMPARISON_IRI_PREFIX)) continue;
    const list = by.get(st.s.value) ?? [];
    list.push(st);
    by.set(st.s.value, list);
  }
  const out: SourceComparison[] = [];
  for (const [subject, rows] of by) {
    const one = (p: string) => rows.find((r) => r.p.value === p)?.o.value ?? null;
    if (!rows.some((r) => r.p.value === RDF_TYPE && r.o.value === COMPARISON_TYPE)) continue;
    const madeAt = Date.parse(one(COMPARISON_MADE_AT) ?? '');
    out.push({
      id: subject.slice(COMPARISON_IRI_PREFIX.length),
      name: one(RDFS_LABEL) ?? '',
      madeAt: Number.isFinite(madeAt) ? madeAt : 0,
      a: one(COMPARISON_DOCUMENT_A),
      b: one(COMPARISON_DOCUMENT_B),
      failedA: one(COMPARISON_FAILED_A),
      failedB: one(COMPARISON_FAILED_B),
    });
  }
  return out.sort((x, y) => y.madeAt - x.madeAt);
}

/**
 * The direct link that opens the main canvas in the comparison layout (F306.2 owns the layout;
 * this URL shape is the agreed contract). A side that did not arrive is left out, so the link
 * still opens with the document that did. Returns null when neither side arrived.
 */
export function comparisonLink(c: Pick<SourceComparison, 'a' | 'b'>): string | null {
  if (!c.a && !c.b) return null;
  const q = new URLSearchParams({ layout: 'compare' });
  if (c.a) q.set('a', c.a);
  if (c.b) q.set('b', c.b);
  return `/?${q.toString()}`;
}

/** "42 s" under a minute, "3 min 05 s" above: honest elapsed time for the progress line. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
