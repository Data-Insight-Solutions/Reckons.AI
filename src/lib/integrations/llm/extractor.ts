import type { Statement, Source } from '../../rdf/types';
import { iri, lit } from '../../rdf/types';
import { v4 as uuid } from 'uuid';
import { ETHICS_PREAMBLE } from '../../safety/content-policy';

/**
 * Both the Claude backend and the local WASM backend produce the same
 * intermediate JSON shape, then this module converts it to Statement[].
 * Keeping the shape minimal makes prompting and parsing reliable.
 */
export type ExtractedTriple = {
  /** Subject — a short canonical concept slug or full sentence reference */
  subject: string;
  /** Predicate — a verb phrase or canonical predicate slug */
  predicate: string;
  /** Object — concept slug or literal value */
  object: string;
  /** Whether `object` should be encoded as a literal (string/number/date) */
  objectIsLiteral?: boolean;
  /** Optional datatype hint for the literal: "string"|"number"|"date"|"boolean" */
  datatype?: 'string' | 'number' | 'date' | 'boolean';
  /** Human-readable rendering of the fact for display */
  gloss?: string;
  /** Extractor's self-reported confidence in [0,1] */
  confidence?: number;
  /** Verbatim source sentence the triple was derived from */
  excerpt?: string;
};

export const EXTRACTION_SYSTEM_PROMPT = ETHICS_PREAMBLE + `You are an information extraction system that converts text into RDF-style triples.

Your job is to read the source text and output a JSON array of triples that capture the factual content.

Rules:
1. Each triple is {subject, predicate, object, objectIsLiteral, datatype?, gloss, confidence, excerpt}.
2. Use kebab-case slugs for concept references: "coffee-bean", "morning-routine".
3. Predicates should be verb phrases in kebab-case: "has-property", "is-located-in", "occurred-on".
4. Mark dates/numbers/strings as objectIsLiteral=true with the appropriate datatype.
5. The gloss is one short human-readable sentence describing the fact.
6. confidence reflects how clearly the source supports the fact (0.0-1.0).
7. Decompose complex sentences into atomic triples — one fact per triple.
8. Do not invent facts not present in the source.
9. Output ONLY a JSON array. No prose, no markdown fence.
10. excerpt is the verbatim sentence or phrase from the source text that this triple was derived from. Copy it exactly — do not paraphrase.
11. Consolidate similar facts: if multiple sentences state the same relationship with minor wording differences, emit ONE triple capturing the core fact. Prefer fewer, well-formed triples over many near-duplicates. A 500-word text should typically produce 8–20 triples, not 40.`;

export function buildExtractionUserPrompt(text: string, sourceTitle: string): string {
  return `Source: "${sourceTitle}"

Text:
"""
${text.slice(0, 12_000)}
"""

Extract triples now. Respond with a JSON array only.`;
}

/** Slugify a concept reference into a stable IRI under urn:kbase:concept/ */
function slugIRI(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `urn:kbase:concept/${s || 'anon-' + uuid().slice(0, 8)}`;
}

function predicateIRI(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `urn:kbase:predicate/${s || 'related-to'}`;
}

const XSD: Record<NonNullable<ExtractedTriple['datatype']>, string> = {
  string: 'http://www.w3.org/2001/XMLSchema#string',
  number: 'http://www.w3.org/2001/XMLSchema#decimal',
  date: 'http://www.w3.org/2001/XMLSchema#dateTime',
  boolean: 'http://www.w3.org/2001/XMLSchema#boolean'
};

/** Convert raw LLM output into typed Statements bound to a Source */
export function triplesToStatements(triples: ExtractedTriple[], source: Source): Statement[] {
  const graph = iri(`urn:kbase:source/${source.id}`);
  const now = Date.now();
  return triples.map((t) => {
    const s = iri(slugIRI(t.subject));
    const p = iri(predicateIRI(t.predicate));
    const o = t.objectIsLiteral
      ? lit(String(t.object), t.datatype ? XSD[t.datatype] : undefined)
      : iri(slugIRI(t.object));
    return {
      id: uuid(),
      s,
      p,
      o,
      g: graph,
      sourceId: source.id,
      confidence: typeof t.confidence === 'number' ? t.confidence : 0.7,
      gloss: t.gloss,
      excerpt: t.excerpt,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };
  });
}

/**
 * Attempt to repair a truncated JSON array by walking backwards through `}`
 * positions until a valid parse is found. Handles `}` chars inside strings
 * by trying each candidate.
 */
function repairTruncatedArray(slice: string): unknown[] {
  let pos = slice.length;
  for (let attempts = 0; attempts < 50; attempts++) {
    pos = slice.lastIndexOf('}', pos - 1);
    if (pos === -1) break;
    const candidate = slice.slice(0, pos + 1).replace(/,\s*$/, '') + ']';
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try next position */ }
  }
  throw new Error('No JSON array found in LLM output');
}

/** Robust JSON extraction: strips fences, trailing text, repairs truncated arrays. */
export function parseTriplesJSON(raw: string): ExtractedTriple[] {
  let text = raw.trim();
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Find the first array bracket
  const start = text.indexOf('[');
  if (start === -1) throw new Error('No JSON array found in LLM output');

  const end = text.lastIndexOf(']');
  let slice = end > start ? text.slice(start, end + 1) : text.slice(start);

  let arr: unknown[];
  try {
    arr = JSON.parse(slice);
  } catch {
    // Repair truncated JSON: small models often hit the token limit mid-array.
    // Try progressively shorter slices ending at each `}` until one parses.
    arr = repairTruncatedArray(slice);
  }

  if (!Array.isArray(arr)) throw new Error('LLM output is not a JSON array');
  return arr.filter(
    (t): t is ExtractedTriple =>
      t && typeof t.subject === 'string' && typeof t.predicate === 'string' && t.object != null
  );
}

/** Mock extractor for UI testing - returns sample triples */
export function extractMock(text: string, sourceTitle: string): ExtractedTriple[] {
  // Generate some sample triples based on source title
  const triples: ExtractedTriple[] = [
    {
      subject: 'test-source',
      predicate: 'has-title',
      object: sourceTitle,
      objectIsLiteral: true,
      datatype: 'string',
      gloss: `The source is titled "${sourceTitle}".`,
      confidence: 0.95
    },
    {
      subject: 'test-source',
      predicate: 'contains-text',
      object: text.slice(0, 50).replace(/\s+/g, '-').toLowerCase(),
      objectIsLiteral: true,
      datatype: 'string',
      gloss: `The source contains information about ${text.slice(0, 30)}.`,
      confidence: 0.85
    },
    {
      subject: 'knowledge-base',
      predicate: 'includes',
      object: 'test-source',
      gloss: 'The knowledge base now includes this test source.',
      confidence: 0.9
    }
  ];
  return triples;
}
