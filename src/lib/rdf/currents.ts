/**
 * Currents (F29) — graph-level settings and the entity-type gate for streamed
 * ingest ("currents" bring recurring external content into a graph; arrivals
 * surface in the pod view).
 *
 * Settings live IN the graph as meta statements under `urn:reckons:meta/currents/`
 * so they travel with TTL export/import and are visible to MCP tools, exactly like
 * nav:order does for hierarchy. `isMetaPredicate` hides the whole namespace from
 * graph edges.
 *
 * The type gate (decided in kb:currents, roadmap KB) applies ONLY to batches that
 * originate from a current, and ONLY to NEW entity creation: facts attaching to
 * entities already present in the graph always flow through (still pending
 * review). An empty allowlist means all types are allowed.
 */

import type { Statement } from './types';
import { iri, lit, isIRI } from './types';

export const CURRENTS_META_PREFIX = 'urn:reckons:meta/currents/';
/** Subject holding graph-wide currents settings */
export const CURRENTS_SUBJECT = 'urn:reckons:currents';
/** Per-current subjects live under this prefix: urn:reckons:currents/<slug> */
export const CURRENT_SUBJECT_PREFIX = 'urn:reckons:currents/';

export const CUR_ALLOWED_TYPE = `${CURRENTS_META_PREFIX}allowedType`;
export const CUR_LOCATION = `${CURRENTS_META_PREFIX}location`;
export const CUR_SOURCE_URL = `${CURRENTS_META_PREFIX}sourceUrl`;
export const CUR_KIND = `${CURRENTS_META_PREFIX}kind`;
export const CUR_LABEL = `${CURRENTS_META_PREFIX}label`;
export const CUR_CADENCE = `${CURRENTS_META_PREFIX}cadenceMinutes`;
export const CUR_ENABLED = `${CURRENTS_META_PREFIX}enabled`;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const TYPE_PREFIX = 'urn:kbase:type/';

export type CurrentKind = 'rss' | 'url' | 'topic';

export interface CurrentDef {
  slug: string;
  sourceUrl: string;
  kind: CurrentKind;
  label: string;
  cadenceMinutes: number;
  enabled: boolean;
}

export interface CurrentsSettings {
  /** Entity types (full IRIs) a current may CREATE. Empty = all types allowed. */
  allowedTypes: string[];
  /** Optional user location for context blocks (e.g. "Colorado, US") */
  location?: string;
  currents: CurrentDef[];
}

const KINDS = new Set<CurrentKind>(['rss', 'url', 'topic']);

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/** Normalize a type reference: bare local names become full ktype IRIs. */
export function normalizeTypeIri(ref: string): string {
  return ref.includes(':') ? ref : `${TYPE_PREFIX}${ref}`;
}

/** Read the graph's currents settings from its statements. */
export function readCurrentsSettings(stmts: Statement[]): CurrentsSettings {
  const allowedTypes: string[] = [];
  let location: string | undefined;
  const bySlug = new Map<string, Partial<CurrentDef>>();

  for (const st of stmts) {
    if (!isActive(st) || !st.p.value.startsWith(CURRENTS_META_PREFIX)) continue;
    const subj = st.s.value;
    const val = st.o.value;

    if (subj === CURRENTS_SUBJECT) {
      if (st.p.value === CUR_ALLOWED_TYPE) allowedTypes.push(normalizeTypeIri(val));
      else if (st.p.value === CUR_LOCATION) location = val;
      continue;
    }
    if (!subj.startsWith(CURRENT_SUBJECT_PREFIX)) continue;

    const slug = subj.slice(CURRENT_SUBJECT_PREFIX.length);
    const cur = bySlug.get(slug) ?? { slug };
    if (st.p.value === CUR_SOURCE_URL) cur.sourceUrl = val;
    else if (st.p.value === CUR_KIND && KINDS.has(val as CurrentKind)) cur.kind = val as CurrentKind;
    else if (st.p.value === CUR_LABEL) cur.label = val;
    else if (st.p.value === CUR_CADENCE) cur.cadenceMinutes = parseInt(val, 10) || 0;
    else if (st.p.value === CUR_ENABLED) cur.enabled = val === 'true';
    bySlug.set(slug, cur);
  }

  const currents: CurrentDef[] = [...bySlug.values()]
    .filter((c): c is CurrentDef => !!c.slug && !!c.sourceUrl)
    .map((c) => ({
      slug: c.slug!,
      sourceUrl: c.sourceUrl!,
      kind: c.kind ?? 'rss',
      label: c.label ?? c.slug!,
      cadenceMinutes: c.cadenceMinutes ?? 360,
      enabled: c.enabled ?? true
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return { allowedTypes: [...new Set(allowedTypes)].sort(), location, currents };
}

/**
 * Serialize settings back to statements. Deterministic: stable ids derived from
 * (subject, predicate, value), stable ordering — write→read→write is identity.
 */
export function currentsSettingsToStatements(settings: CurrentsSettings): Statement[] {
  const now = Date.now();
  const g = iri('urn:kbase:graph/currents');
  const make = (s: string, p: string, v: string): Statement => ({
    id: `currents|${s}|${p}|${v}`,
    s: iri(s),
    p: iri(p),
    o: lit(v),
    g,
    sourceId: 'currents-settings',
    confidence: 1,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now
  });

  const out: Statement[] = [];
  for (const t of [...new Set(settings.allowedTypes.map(normalizeTypeIri))].sort()) {
    out.push(make(CURRENTS_SUBJECT, CUR_ALLOWED_TYPE, t));
  }
  if (settings.location) out.push(make(CURRENTS_SUBJECT, CUR_LOCATION, settings.location));
  for (const c of [...settings.currents].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const subj = `${CURRENT_SUBJECT_PREFIX}${c.slug}`;
    out.push(make(subj, CUR_SOURCE_URL, c.sourceUrl));
    out.push(make(subj, CUR_KIND, c.kind));
    out.push(make(subj, CUR_LABEL, c.label));
    out.push(make(subj, CUR_CADENCE, String(c.cadenceMinutes)));
    out.push(make(subj, CUR_ENABLED, String(c.enabled)));
  }
  return out;
}

/** Empty allowlist = everything allowed; otherwise exact IRI (or local-name) match. */
export function isTypeAllowed(settings: CurrentsSettings, typeIri: string): boolean {
  if (settings.allowedTypes.length === 0) return true;
  return settings.allowedTypes.includes(normalizeTypeIri(typeIri));
}

export interface TypeGateResult {
  allowed: Statement[];
  /** Entity IRIs whose creation was gated, with the types that caused it */
  gatedEntities: Record<string, string[]>;
  gatedStatementCount: number;
}

/**
 * Apply the entity-type gate to a current-originated batch.
 *
 * A NEW entity (subject not in `existingIris`) whose rdf:type in the batch is
 * disallowed is dropped along with every batch statement that references it as
 * subject or IRI-object (those statements would create the node). New entities
 * with no rdf:type in the batch are allowed — the gate can only judge what it
 * can see. Facts on already-existing entities always pass.
 */
export function applyTypeGate(
  batch: Statement[],
  existingIris: ReadonlySet<string>,
  settings: CurrentsSettings
): TypeGateResult {
  if (settings.allowedTypes.length === 0) {
    return { allowed: batch, gatedEntities: {}, gatedStatementCount: 0 };
  }

  const gatedEntities: Record<string, string[]> = {};
  for (const st of batch) {
    if (st.p.value !== RDF_TYPE || !isIRI(st.o)) continue;
    const subj = st.s.value;
    if (existingIris.has(subj)) continue;
    if (!isTypeAllowed(settings, st.o.value)) {
      (gatedEntities[subj] ??= []).push(st.o.value);
    }
  }

  const gatedSet = new Set(Object.keys(gatedEntities));
  if (gatedSet.size === 0) return { allowed: batch, gatedEntities: {}, gatedStatementCount: 0 };

  const allowed = batch.filter(
    (st) => !gatedSet.has(st.s.value) && !(isIRI(st.o) && gatedSet.has(st.o.value))
  );
  return { allowed, gatedEntities, gatedStatementCount: batch.length - allowed.length };
}

/* ---------- arrivals ---------- */

export const KB_MENTIONED_IN = 'urn:kbase:predicate/mentioned-in';
const KB_URL = 'urn:kbase:predicate/url';
const KB_PUBLISHED_AT = 'urn:kbase:meta/published-at';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DOCUMENT_TYPE = 'urn:kbase:type/Document';

export interface ArrivalInput {
  title: string;
  url: string;
  publishedAt?: string;
  excerpt?: string;
  sourceId: string;
  /** Statements already extracted from the article body (pending) */
  extracted: Statement[];
}

function articleIri(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `urn:kbase:concept/${s || 'article'}`;
}

/**
 * Build the statements for one arrival: the article/document node plus
 * provenance links from every extracted concept back to the article.
 * Everything is status 'pending' — arrivals never bypass review.
 */
export function buildArrivalStatements(input: ArrivalInput): Statement[] {
  const now = Date.now();
  const article = articleIri(input.title);
  const g = iri(`urn:kbase:source/${input.sourceId}`);
  const make = (s: string, p: string, o: Statement['o'], excerpt?: string): Statement => ({
    id: `arrival|${s}|${p}|${o.value}`,
    s: iri(s),
    p: iri(p),
    o,
    g,
    sourceId: input.sourceId,
    confidence: 0.9,
    ...(excerpt ? { excerpt } : {}),
    status: 'pending',
    createdAt: now,
    updatedAt: now
  });

  const out: Statement[] = [
    make(article, RDF_TYPE, iri(DOCUMENT_TYPE)),
    make(article, RDFS_LABEL, lit(input.title)),
    make(article, KB_URL, lit(input.url), input.excerpt)
  ];
  if (input.publishedAt) out.push(make(article, KB_PUBLISHED_AT, lit(input.publishedAt)));

  const linked = new Set<string>();
  for (const st of input.extracted) {
    const subj = st.s.value;
    if (subj === article || linked.has(subj)) continue;
    linked.add(subj);
    out.push(make(subj, KB_MENTIONED_IN, iri(article)));
  }
  return [...out, ...input.extracted];
}
