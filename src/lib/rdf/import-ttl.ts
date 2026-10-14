import { decodePortableMetadata } from './portable-metadata';
/**
 * Import annotated Turtle files produced by toTurtleFull().
 * Uses N3.js to parse, then reconstructs Statement[] and Source[]
 * from the reification metadata blocks.
 *
 * Confirmed/refined triples in the clean graph section are ignored —
 * all state is recovered from the reification blocks which carry status.
 */

import type { Statement, Source, Term, ReviewStatus, EvidenceSpan } from './types';
import { hasLeakedTermKey } from './types';
import { notifyImportQuarantine } from './cut-notice';
import { isAltitude } from './fact-altitude';

// IRIs used in the annotated format
const RDF   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC    = 'http://purl.org/dc/terms/';
const PROV  = 'http://www.w3.org/ns/prov#';
const KBASE = 'urn:kbase:meta/';
const XSD   = 'http://www.w3.org/2001/XMLSchema#';
const SCHEMA = 'https://schema.org/';
const OA    = 'http://www.w3.org/ns/oa#';

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

/**
 * A document passage read from a saved file (F107.10.1). Evidence, never a claim: it is returned
 * beside the facts and never enters the fact store, the view or a publish.
 */
export type ImportedChunk = {
  /** The chunk's IRI, e.g. urn:kbase:source/<id>/chunk/<n>. */
  iri: string;
  /** The document it is part of (dcterms:isPartOf), as a document id when it is a urn:kbase:source/ IRI. */
  sourceId: string;
  /** 0-based order in the document (schema:position). */
  index: number;
  /** Content range [start, end) in the document text (oa:TextPositionSelector). */
  start: number;
  end: number;
  /** The passage text (rdf:value). */
  text: string;
  /** When it was derived, ISO 8601 (prov:generatedAtTime), if the file says. */
  generatedAt?: string;
};

export type ImportResult = {
  statements: Statement[];
  /** Source passages found in the file. Empty when it holds none. Never facts. */
  chunks: ImportedChunk[];
  /** Chunk-shaped entries that were incomplete or contradictory: reported, never thrown, never imported. */
  chunkProblems?: Array<{ iri: string; reason: string }>;
  /** Fact anchors that were incomplete or contradictory: the fact imported without one (F122.1.2). */
  anchorProblems?: Array<{ statement: string; reason: string }>;
  /** SHA-256 of the document text each document's chunks were cut from, by document id, where the file says (dcterms:hasVersion "sha256:..."). */
  chunkVersions?: Record<string, string>;
  sources: Source[];
  /** Statements imported from a clean (non-annotated) Turtle file get this status */
  cleanImportCount: number;
  /** Shelly persona overrides found in the TTL (from shelly: vocabulary) */
  shellyPersona?: ShellyPersonaOverrides;
  /**
   * Statements dropped because they were written with a graph node key as an IRI
   * (`<l:high||>`) — files exported by a buggy build. The rest of the graph imports normally;
   * callers should show this to the user rather than hide it.
   */
  quarantined?: { count: number; samples: string[] };
};

/** `<l:value|datatype|lang>` — a literal node key written as an IRI, which no Turtle parser accepts. */
const LEAKED_LITERAL_IRI = /(?<=^|[\s;,(\[])<(l:[^<>\n]*\|[^<>\n|]*\|[^<>\n|]*)>/g;
const QUARANTINE_PREFIX = 'urn:kbase:quarantine/';

/**
 * Replace leaked literal-key IRIs with placeholder IRIs the parser accepts, remembering what
 * each one was. Only used after a normal parse FAILED, so well-formed files are never touched.
 */
function quarantineLeakedIris(turtle: string): { text: string; originals: string[] } {
  const originals: string[] = [];
  const text = turtle.replace(LEAKED_LITERAL_IRI, (_m, key: string) => {
    let i = originals.indexOf(key);
    if (i < 0) { i = originals.length; originals.push(key); }
    return `<${QUARANTINE_PREFIX}${i}>`;
  });
  return { text, originals };
}

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
 * Find the chunk entries in a parsed file. A chunk is an entry that is dcterms:isPartOf an IRI AND
 * carries at least one of schema:position, rdf:value, oa:hasSelector; the second condition keeps
 * a file that is isPartOf a set from being mistaken for a passage. Complete chunks are returned;
 * incomplete ones are reported. Either way every triple of the entry, and of its selector blank
 * entry, is marked consumed so none of them can fall into the plain-Turtle fact fallback.
 * `consumed` holds subject values (blank entries as '_:' + label).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readChunkNodes(quads: any[]): { chunks: ImportedChunk[]; chunkProblems: Array<{ iri: string; reason: string }>; chunkVersions: Record<string, string>; consumed: Set<string> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bySubject = new Map<string, any[]>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const list = bySubject.get(q.subject.value);
    if (list) list.push(q); else bySubject.set(q.subject.value, [q]);
  }
  const consumed = new Set<string>();
  const chunks: ImportedChunk[] = [];
  const chunkProblems: Array<{ iri: string; reason: string }> = [];
  const nonNegInt = (v: string) => (/^\d+$/.test(v.trim()) ? parseInt(v, 10) : null);

  for (const [iri, qs] of bySubject) {
    const has = (p: string) => qs.some((q) => q.predicate.value === p);
    const parts = qs.filter((q) => q.predicate.value === DC + 'isPartOf' && q.object.termType === 'NamedNode');
    if (parts.length === 0) continue;
    if (!has(SCHEMA + 'position') && !has(RDF + 'value') && !has(OA + 'hasSelector')) continue;

    consumed.add(iri);
    const selectors = qs.filter((q) => q.predicate.value === OA + 'hasSelector');
    for (const sel of selectors) if (sel.object.termType === 'BlankNode') consumed.add('_:' + sel.object.value);
    const one = (p: string) => qs.filter((q) => q.predicate.value === p);

    const problems: string[] = [];
    const values = one(RDF + 'value');
    const positions = one(SCHEMA + 'position');
    if (parts.length > 1 && new Set(parts.map((q) => q.object.value)).size > 1) problems.push('part of more than one source');
    if (values.length !== 1 || values[0].object.termType !== 'Literal') problems.push(values.length === 0 ? 'no text (rdf:value)' : 'text is not a single literal');
    const index = positions.length === 1 ? nonNegInt(positions[0].object.value) : null;
    if (index === null) problems.push(positions.length === 0 ? 'no position (schema:position)' : 'position is not a single non-negative integer');
    let start: number | null = null;
    let end: number | null = null;
    if (selectors.length !== 1 || selectors[0].object.termType !== 'BlankNode') {
      problems.push(selectors.length === 0 ? 'no text position selector' : 'not exactly one text position selector');
    } else {
      const sq = quads.filter((q) => q.subject.termType === 'BlankNode' && q.subject.value === selectors[0].object.value);
      const sv = (p: string) => sq.filter((q) => q.predicate.value === p);
      if (sv(OA + 'start').length === 1) start = nonNegInt(sv(OA + 'start')[0].object.value);
      if (sv(OA + 'end').length === 1) end = nonNegInt(sv(OA + 'end')[0].object.value);
      if (start === null || end === null) problems.push('selector start/end missing or not integers');
      else if (end < start) problems.push('selector ends before it starts');
    }
    if (problems.length > 0 || index === null || start === null || end === null) {
      chunkProblems.push({ iri, reason: problems.join('; ') });
      continue;
    }
    const generated = one(PROV + 'generatedAtTime')[0]?.object.value;
    const sourceIri = parts[0].object.value;
    chunks.push({
      iri,
      sourceId: sourceIri.startsWith(SRC_PREFIX) ? sourceIri.slice(SRC_PREFIX.length) : sourceIri,
      index, start, end,
      text: values[0].object.value,
      ...(generated ? { generatedAt: generated } : {}),
    });
  }
  // Duplicate (document, index): the first wins, the rest are reported. Order is canonical either way.
  const seen = new Set<string>();
  const kept: ImportedChunk[] = [];
  chunks.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.index - b.index || (a.iri < b.iri ? -1 : 1)));
  for (const c of chunks) {
    const key = `${c.sourceId}\u0000${c.index}`;
    if (seen.has(key)) { chunkProblems.push({ iri: c.iri, reason: `duplicate position ${c.index} in source ${c.sourceId}` }); continue; }
    seen.add(key);
    kept.push(c);
  }
  const chunkVersions: Record<string, string> = {};
  for (const sid of new Set(kept.map((c) => c.sourceId))) {
    const v = (bySubject.get(sid.startsWith('urn:') ? sid : SRC_PREFIX + sid) ?? []).find((q) => q.predicate.value === DC + 'hasVersion');
    const m = v && /^sha256:([0-9a-f]+)$/i.exec(v.object.value);
    if (m) chunkVersions[sid] = m[1];
  }
  return { chunks: kept, chunkProblems, chunkVersions, consumed };
}

/**
 * Read the anchors (F122.1.2): on a fact's annotation, oa:hasTarget [ oa:hasSource <chunk> ;
 * oa:hasSelector [ a oa:TextPositionSelector ; oa:start N ; oa:end M ] ; dcterms:hasVersion "sha256:..." ].
 * A complete one becomes the fact's `anchor`. An incomplete one is reported and the fact imports
 * without it. Every triple of the anchor's blank entries is marked consumed so none of them can reach
 * the plain-Turtle fallback as a claim. An old file with no anchors reads exactly as before.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function readAnchors(quads: any[], consumed: Set<string>): { anchors: Map<string, EvidenceSpan>; problems: Array<{ statement: string; reason: string }> } {
  const anchors = new Map<string, EvidenceSpan>();
  const problems: Array<{ statement: string; reason: string }> = [];
  const ofBnode = (label: string) => quads.filter((q: any) => q.subject.termType === 'BlankNode' && q.subject.value === label);
  const nonNeg = (v: string) => (/^\d+$/.test(v.trim()) ? parseInt(v, 10) : null);
  const pick = (qs: any[], p: string) => qs.filter((x: any) => x.predicate.value === p);
  for (const q of quads) {
    if (!q.subject.value.startsWith(STMT_PREFIX) || q.predicate.value !== OA + 'hasTarget') continue;
    const id = q.subject.value;
    if (q.object.termType !== 'BlankNode') { problems.push({ statement: id, reason: 'anchor is not a node with a source and a selector' }); continue; }
    const target = ofBnode(q.object.value);
    consumed.add('_:' + q.object.value);
    const sources = pick(target, OA + 'hasSource');
    const selectors = pick(target, OA + 'hasSelector');
    const versions = pick(target, DC + 'hasVersion');
    const why: string[] = [];
    if (sources.length !== 1 || sources[0].object.termType !== 'NamedNode') why.push('needs exactly one chunk IRI (oa:hasSource)');
    if (versions.length !== 1) why.push('needs exactly one source version (dcterms:hasVersion)');
    let start: number | null = null;
    let end: number | null = null;
    if (selectors.length !== 1 || selectors[0].object.termType !== 'BlankNode') why.push('needs exactly one text position selector');
    else {
      consumed.add('_:' + selectors[0].object.value);
      const sq = ofBnode(selectors[0].object.value);
      if (pick(sq, OA + 'start').length === 1) start = nonNeg(pick(sq, OA + 'start')[0].object.value);
      if (pick(sq, OA + 'end').length === 1) end = nonNeg(pick(sq, OA + 'end')[0].object.value);
      if (start === null || end === null) why.push('selector start/end missing or not integers');
      else if (end <= start) why.push('selector ends at or before its start');
    }
    if (why.length > 0 || start === null || end === null) { problems.push({ statement: id, reason: why.join('; ') }); continue; }
    const next: EvidenceSpan = { chunk: sources[0].object.value, start, end, sourceHash: versions[0].object.value.replace(/^(sha256|unverified):/, '') };
    const have = anchors.get(id);
    if (!have) anchors.set(id, next);
    // The same anchor written twice is one anchor; two different ones are a contradiction, and the first stands.
    else if (JSON.stringify(have) !== JSON.stringify(next)) problems.push({ statement: id, reason: 'more than one, and they differ' });
  }
  return { anchors, problems };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Parse an annotated .ttl file back into Statement[] + Source[].
 * Falls back to treating plain (non-annotated) Turtle as confirmed statements.
 */
export async function importTurtleFull(turtle: string, opts: { name?: string } = {}): Promise<ImportResult> {
  // Dynamic import keeps N3 out of SSR / initial bundle
  const { Parser } = await import('n3');
  // TriG, not Turtle: TriG is a strict superset (every .ttl is legal TriG), so this
  // reads today's default-graph files unchanged while tolerating named graphs (F75).
  // Use synchronous overload — callback version is async in N3 v1.26+
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let quads: any[];
  let quarantineOriginals: string[] = [];
  try {
    quads = new Parser({ format: 'TriG' }).parse(turtle);
  } catch (err) {
    // A build before the 2026-10 fix could export `<l:high||> skos:altLabel ...` (a literal
    // node id used as a subject), which makes the whole file unparseable. Quarantine those
    // terms and retry, so one bad triple does not cost the user their graph. If the file has no
    // such terms the original error is the right one to report.
    const repaired = quarantineLeakedIris(turtle);
    if (repaired.originals.length === 0) throw err;
    quarantineOriginals = repaired.originals;
    quads = new Parser({ format: 'TriG' }).parse(repaired.text);
  }

  const { chunks, chunkProblems, chunkVersions, consumed: chunkSubjects } = readChunkNodes(quads);
  const { anchors, problems: anchorProblems } = readAnchors(quads, chunkSubjects);

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

    // A passage (or its selector) is evidence: it is read by readChunkNodes, never a claim.
    if (chunkSubjects.has(sv) || (quad.subject.termType === 'BlankNode' && chunkSubjects.has('_:' + sv))) continue;

    if (sv.startsWith(STMT_PREFIX)) {
      if (!stmtData.has(sv)) stmtData.set(sv, {});
      const d = stmtData.get(sv)!;
      if      (pv === RDF + 'subject')              d.s           = n3ToTerm(ov);
      else if (pv === RDF + 'predicate')            d.p           = n3ToTerm(ov);
      else if (pv === RDF + 'object')               d.o           = n3ToTerm(ov);
      else if (pv === KBASE + 'status')             d.status      = ov.value;
      else if (pv === KBASE + 'confidence')         d.confidence  = parseFloat(ov.value);
      else if (pv === KBASE + 'reviewMetadata')     d.portable    = decodePortableMetadata(ov.value, 'statement');
      else if (pv === KBASE + 'proposed-by')        d.proposedBy  = ov.value;
      else if (pv === KBASE + 'asked-by')           d.askedBy     = ov.value;
      else if (pv === KBASE + 'altitude')           d.altitude    = isAltitude(ov.value) ? ov.value : undefined;
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
      else if (pv === KBASE + 'sourceMetadata')     d.portable    = decodePortableMetadata(ov.value, 'source');
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
    if (!s || !p || !o || p.kind !== 'iri') throw new Error('Incomplete annotated statement');
    if (d.status !== undefined && !['pending', 'pending-removal', 'confirmed', 'refined', 'rejected', 'superseded'].includes(String(d.status))) {
      throw new Error('Invalid annotated review status');
    }
    if (d.confidence !== undefined && (!Number.isFinite(d.confidence) || Number(d.confidence) < 0 || Number(d.confidence) > 1)) {
      throw new Error('Invalid annotated confidence');
    }
    if (d.createdAt !== undefined && !Number.isFinite(d.createdAt)) throw new Error('Invalid annotated creation time');

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
      proposedBy: d.proposedBy as string | undefined,
      askedBy:    d.askedBy as string | undefined,
      altitude:   d.altitude as Statement['altitude'],
      gloss:      d.gloss as string | undefined,
      excerpt:    d.excerpt as string | undefined,
      supersedes: d.supersedes as string | undefined,
      createdAt:  (d.createdAt as number) ?? Date.now(),
      updatedAt:  (d.createdAt as number) ?? Date.now(),
      ...(anchors.has(iri) ? { anchor: anchors.get(iri) } : {}),
      ...(d.portable as Partial<Statement> | undefined),
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
      ingestedAt: (d.ingestedAt as number) ?? Date.now(),
      ...(d.portable as Partial<Source> | undefined),
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

  // Quarantine: drop every statement that touches a placeholder (both the plain triple and its
  // reification block carry the same placeholder, so both go).
  let quarantined: ImportResult['quarantined'];
  if (quarantineOriginals.length > 0) {
    const isPlaceholder = (t: Term) => t.kind === 'iri' && t.value.startsWith(QUARANTINE_PREFIX);
    const kept = statements.filter((st) => !isPlaceholder(st.s) && !isPlaceholder(st.o) && !isPlaceholder(st.g) && !hasLeakedTermKey(st));
    quarantined = {
      count: statements.length - kept.length,
      samples: quarantineOriginals.slice(0, 5),
    };
    if (cleanImportCount > 0) cleanImportCount = Math.max(0, cleanImportCount - quarantined.count);
    statements.length = 0;
    statements.push(...kept);
    console.warn(
      `[import] Quarantined ${quarantined.count} statement(s) with a leaked node-key IRI ` +
      `(${quarantineOriginals.length} distinct: ${quarantined.samples.join(', ')}); the rest of the graph was imported.`,
    );
  }

  if (quarantined && quarantined.count > 0) void notifyImportQuarantine(opts.name, quarantined.count);

  return { statements, sources, chunks, ...(chunkProblems.length ? { chunkProblems } : {}), ...(anchorProblems.length ? { anchorProblems } : {}), ...(Object.keys(chunkVersions).length ? { chunkVersions } : {}), cleanImportCount, shellyPersona, ...(quarantined ? { quarantined } : {}) };
}
