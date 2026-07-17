/**
 * Import annotated Turtle files produced by toTurtleFull().
 * Uses N3.js to parse, then reconstructs Statement[] and Source[]
 * from the reification metadata blocks.
 *
 * Confirmed/refined triples in the clean graph section are ignored —
 * all state is recovered from the reification blocks which carry status.
 */

import type { Statement, Source, Term, ReviewStatus } from './types';

// IRIs used in the annotated format
const RDF   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC    = 'http://purl.org/dc/terms/';
const PROV  = 'http://www.w3.org/ns/prov#';
const KBASE = 'urn:kbase:meta/';
const XSD   = 'http://www.w3.org/2001/XMLSchema#';

const STMT_PREFIX = 'urn:kbase:stmt/';
const SRC_PREFIX  = 'urn:kbase:source/';

/** Shelly persona overrides extracted from a TTL file's shelly: vocabulary. */
export type ShellyPersonaOverrides = {
  // Identity & prompting
  name?: string;
  greeting?: string;
  personality?: string;
  systemPrompt?: string;
  responseStyle?: string;
  maxWords?: number;
  patienceLevel?: number;
  engagement?: string;
  // Voice
  voiceEnabled?: boolean;
  voiceType?: string;
  speechRate?: number;
  volume?: number;
  // Visual
  animationSpeed?: string;
  opacity?: number;
  size?: string;
  glowEffect?: boolean;
  wanderRange?: number;
  // Interaction
  proactiveHelp?: string;
  showTutorialHints?: boolean;
  responseFrequency?: number;
};

export type ImportResult = {
  statements: Statement[];
  sources: Source[];
  /** Statements imported from a clean (non-annotated) Turtle file get this status */
  cleanImportCount: number;
  /** Shelly persona overrides found in the TTL (from shelly: vocabulary) */
  shellyPersona?: ShellyPersonaOverrides;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function n3ToTerm(term: any): Term | null {
  if (!term) return null;
  if (term.termType === 'NamedNode') return { kind: 'iri', value: term.value };
  if (term.termType === 'BlankNode') return { kind: 'bnode', value: term.value };
  if (term.termType === 'Literal') {
    const dt = term.datatype?.value;
    return {
      kind: 'literal',
      value: term.value,
      ...(term.language ? { lang: term.language } : {}),
      ...(dt && dt !== XSD + 'string' ? { datatype: dt } : {})
    };
  }
  return null;
}

/**
 * Parse an annotated .ttl file back into Statement[] + Source[].
 * Falls back to treating plain (non-annotated) Turtle as confirmed statements.
 */
export async function importTurtleFull(turtle: string): Promise<ImportResult> {
  // Dynamic import keeps N3 out of SSR / initial bundle
  const { Parser } = await import('n3');
  // TriG, not Turtle: TriG is a strict superset (every .ttl is legal TriG), so this
  // reads today's default-graph files unchanged while tolerating named graphs (F75).
  const parser = new Parser({ format: 'TriG' });

  // Use synchronous overload — callback version is async in N3 v1.26+
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quads: any[] = parser.parse(turtle);

  // Maps from IRI → property bag
  const stmtData = new Map<string, Record<string, unknown>>();
  const srcData  = new Map<string, Record<string, unknown>>();

  // Direct triples (subject not in stmt/src namespaces) — for plain Turtle import
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const directTriples: Array<{ s: any; p: any; o: any }> = [];

  for (const quad of quads) {
    const sv: string = quad.subject.value;
    const pv: string = quad.predicate.value;
    const ov = quad.object;

    if (sv.startsWith(STMT_PREFIX)) {
      if (!stmtData.has(sv)) stmtData.set(sv, {});
      const d = stmtData.get(sv)!;
      if      (pv === RDF + 'subject')              d.s           = n3ToTerm(ov);
      else if (pv === RDF + 'predicate')            d.p           = n3ToTerm(ov);
      else if (pv === RDF + 'object')               d.o           = n3ToTerm(ov);
      else if (pv === KBASE + 'status')             d.status      = ov.value;
      else if (pv === KBASE + 'confidence')         d.confidence  = parseFloat(ov.value);
      else if (pv === KBASE + 'gloss')              d.gloss       = ov.value;
      else if (pv === KBASE + 'excerpt')            d.excerpt     = ov.value;
      else if (pv === KBASE + 'supersedes')         d.supersedes  = ov.value.replace(STMT_PREFIX, '');
      else if (pv === PROV  + 'wasDerivedFrom')     d.g           = n3ToTerm(ov);
      else if (pv === DC    + 'created')            d.createdAt   = new Date(ov.value).getTime();
    } else if (
      sv.startsWith(SRC_PREFIX) ||
      (pv === RDF + 'type' && ov.value === KBASE + 'Source')
    ) {
      if (!srcData.has(sv)) srcData.set(sv, {});
      const d = srcData.get(sv)!;
      if      (pv === DC    + 'title')              d.title       = ov.value;
      else if (pv === KBASE + 'sourceUri')          d.uri         = ov.value;
      else if (pv === KBASE + 'sourceKind')         d.kind        = ov.value;
      else if (pv === KBASE + 'trustLevel')         d.trustLevel  = ov.value;
      else if (pv === KBASE + 'trustScore')         d.trustScore  = parseFloat(ov.value);
      else if (pv === DC    + 'created')            d.ingestedAt  = new Date(ov.value).getTime();
    } else {
      // Plain triple — for non-annotated Turtle fallback (includes rdf:type)
      directTriples.push({ s: quad.subject, p: quad.predicate, o: quad.object });
    }
  }

  // Extract Shelly persona overrides from shelly: vocabulary
  const SHELLY = 'urn:reckons:shelly/';
  let shellyPersona: ShellyPersonaOverrides | undefined;
  for (const quad of quads) {
    const pv: string = quad.predicate.value;
    if (!pv.startsWith(SHELLY)) continue;
    if (!shellyPersona) shellyPersona = {};
    const prop = pv.slice(SHELLY.length);
    const val = quad.object.value;
    // Identity & prompting
    if      (prop === 'name')              shellyPersona.name = val;
    else if (prop === 'greeting')          shellyPersona.greeting = val;
    else if (prop === 'personality')       shellyPersona.personality = val;
    else if (prop === 'systemPrompt')      shellyPersona.systemPrompt = val;
    else if (prop === 'responseStyle')     shellyPersona.responseStyle = val;
    else if (prop === 'maxWords')          shellyPersona.maxWords = parseInt(val, 10) || 0;
    else if (prop === 'patienceLevel')     shellyPersona.patienceLevel = parseFloat(val) || 0;
    else if (prop === 'engagement')        shellyPersona.engagement = val;
    // Voice
    else if (prop === 'voiceEnabled')      shellyPersona.voiceEnabled = val === 'true';
    else if (prop === 'voiceType')         shellyPersona.voiceType = val;
    else if (prop === 'speechRate')        shellyPersona.speechRate = parseFloat(val) || 1;
    else if (prop === 'volume')            shellyPersona.volume = parseFloat(val) || 1;
    // Visual
    else if (prop === 'animationSpeed')    shellyPersona.animationSpeed = val;
    else if (prop === 'opacity')           shellyPersona.opacity = parseFloat(val) || 1;
    else if (prop === 'size')              shellyPersona.size = val;
    else if (prop === 'glowEffect')        shellyPersona.glowEffect = val === 'true';
    else if (prop === 'wanderRange')       shellyPersona.wanderRange = parseFloat(val) || 0;
    // Interaction
    else if (prop === 'proactiveHelp')     shellyPersona.proactiveHelp = val;
    else if (prop === 'showTutorialHints') shellyPersona.showTutorialHints = val === 'true';
    else if (prop === 'responseFrequency') shellyPersona.responseFrequency = parseFloat(val) || 0;
  }

  // Build Statement objects from reification metadata
  const statements: Statement[] = [];
  for (const [iri, d] of stmtData) {
    const s = d.s as Term | null;
    const p = d.p as Term | null;
    const o = d.o as Term | null;
    if (!s || !p || !o || p.kind !== 'iri') continue;

    const g = (d.g as Term | null) ?? { kind: 'iri' as const, value: 'urn:kbase:source/unknown' };
    const sourceId = g.kind === 'iri' && g.value.startsWith(SRC_PREFIX)
      ? g.value.slice(SRC_PREFIX.length)
      : g.kind === 'iri' ? g.value : 'unknown';

    statements.push({
      id:         iri.slice(STMT_PREFIX.length),
      s,
      p:          { kind: 'iri', value: p.value },
      o,
      g:          { kind: 'iri', value: g.kind === 'iri' ? g.value : 'urn:kbase:source/unknown' },
      sourceId,
      confidence: (d.confidence as number) ?? 0.5,
      status:     ((d.status as ReviewStatus) ?? 'confirmed'),
      gloss:      d.gloss as string | undefined,
      excerpt:    d.excerpt as string | undefined,
      supersedes: d.supersedes as string | undefined,
      createdAt:  (d.createdAt as number) ?? Date.now(),
      updatedAt:  (d.createdAt as number) ?? Date.now()
    });
  }

  // Build Source objects from metadata
  const sources: Source[] = [];
  for (const [iri, d] of srcData) {
    if (!d.title && !d.uri) continue;
    const id = iri.startsWith(SRC_PREFIX) ? iri.slice(SRC_PREFIX.length) : iri;
    sources.push({
      id,
      title:      (d.title as string) ?? id,
      uri:        (d.uri as string)   ?? iri,
      kind:       ((d.kind as Source['kind']) ?? 'document'),
      trustLevel: d.trustLevel as Source['trustLevel'],
      trustScore: d.trustScore as number | undefined,
      ingestedAt: (d.ingestedAt as number) ?? Date.now()
    });
  }

  // Fallback: treat direct triples as confirmed statements (plain Turtle import)
  let cleanImportCount = 0;
  if (statements.length === 0 && directTriples.length > 0) {
    const now = Date.now();
    for (const { s, p, o } of directTriples) {
      const st = n3ToTerm(s);
      const pt = n3ToTerm(p);
      const ot = n3ToTerm(o);
      if (!st || !pt || !ot || pt.kind !== 'iri') continue;
      statements.push({
        id:         crypto.randomUUID(), // Web Crypto API — Chrome 92+, Firefox 95+
        s:          st,
        p:          { kind: 'iri', value: pt.value },
        o:          ot,
        g:          { kind: 'iri', value: 'urn:kbase:source/imported' },
        sourceId:   'imported',
        confidence: 1,
        status:     'pending',
        createdAt:  now,
        updatedAt:  now
      });
      cleanImportCount++;
    }
  }

  return { statements, sources, cleanImportCount, shellyPersona };
}
