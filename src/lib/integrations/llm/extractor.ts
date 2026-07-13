import type { Statement, Source } from '../../rdf/types';
import { iri, lit } from '../../rdf/types';
import { groundStatements } from '../../rdf/grounding';
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

/**
 * Compact extraction prompt for small local models (roughly ≤4B parameters).
 * Small models follow the full 11-rule prompt inconsistently — they do better
 * with the output schema restated explicitly and a handful of worked examples
 * rather than a long rule list. Keeps the same field names/semantics as
 * EXTRACTION_SYSTEM_PROMPT (including `excerpt`) so downstream parsing is
 * identical either way.
 */
/**
 * Few-shot extraction prompt for SMALL local models (see `isSmallOllamaModel`).
 *
 * Renamed from ..._COMPACT (2026-07-12) because that name was actively misleading: it
 * is the LARGEST prompt in the app (~301 body tokens vs ~257 for the full one), and
 * the name invited exactly the wrong "optimization". The extra tokens are three
 * worked examples, and they are the whole point — few-shot examples take llama3.2:3b
 * from F1 0.238 to 0.500 on ingest (tests/bench). They are not bloat; they are the
 * cheapest quality we buy anywhere.
 *
 * "Compact" was only ever true of the OUTPUT it asks for, never of the prompt itself.
 * Do not shrink this without re-running the ingest bench.
 */
export const EXTRACTION_SYSTEM_PROMPT_FEWSHOT = ETHICS_PREAMBLE + `Extract facts from text as a JSON array of triples.

Output schema — each array item is an object with these fields:
{"subject": "kebab-case-slug", "predicate": "kebab-case-verb-phrase", "object": "kebab-case-slug-or-literal", "objectIsLiteral": true|false, "datatype": "string|number|date|boolean", "gloss": "one short sentence", "confidence": 0.0-1.0, "excerpt": "verbatim source sentence"}

Rules:
- One fact per triple. Split compound sentences into separate triples.
- objectIsLiteral=true for dates/numbers/plain strings; false when object refers to another concept.
- excerpt must be copied exactly from the source text — do not paraphrase.
- Only include facts stated in the text. Never invent facts.
- Output ONLY the JSON array. No prose, no markdown fences, no explanation.

Examples:

Input: "Marie Curie was born in Warsaw in 1867. She won two Nobel Prizes."
Output: [{"subject":"marie-curie","predicate":"was-born-in","object":"warsaw","objectIsLiteral":false,"gloss":"Marie Curie was born in Warsaw.","confidence":0.95,"excerpt":"Marie Curie was born in Warsaw in 1867."},{"subject":"marie-curie","predicate":"has-birth-year","object":"1867","objectIsLiteral":true,"datatype":"number","gloss":"Marie Curie was born in 1867.","confidence":0.95,"excerpt":"Marie Curie was born in Warsaw in 1867."},{"subject":"marie-curie","predicate":"has-nobel-prize-count","object":"2","objectIsLiteral":true,"datatype":"number","gloss":"Marie Curie won two Nobel Prizes.","confidence":0.9,"excerpt":"She won two Nobel Prizes."}]

Input: "The octopus has three hearts and blue blood."
Output: [{"subject":"octopus","predicate":"has-heart-count","object":"3","objectIsLiteral":true,"datatype":"number","gloss":"The octopus has three hearts.","confidence":0.95,"excerpt":"The octopus has three hearts and blue blood."},{"subject":"octopus","predicate":"has-blood-color","object":"blue","objectIsLiteral":true,"datatype":"string","gloss":"The octopus has blue blood.","confidence":0.95,"excerpt":"The octopus has three hearts and blue blood."}]

Input: "Reckons.AI is built with SvelteKit and stores data in IndexedDB."
Output: [{"subject":"reckons-ai","predicate":"is-built-with","object":"sveltekit","objectIsLiteral":false,"gloss":"Reckons.AI is built with SvelteKit.","confidence":0.95,"excerpt":"Reckons.AI is built with SvelteKit and stores data in IndexedDB."},{"subject":"reckons-ai","predicate":"stores-data-in","object":"indexeddb","objectIsLiteral":false,"gloss":"Reckons.AI stores data in IndexedDB.","confidence":0.9,"excerpt":"Reckons.AI is built with SvelteKit and stores data in IndexedDB."}]`;

/**
 * Rough heuristic for picking the compact prompt variant: models whose name
 * encodes a parameter count of 4B or fewer (e.g. "llama3.2:3b", "qwen3:4b")
 * are treated as small. Falls back to a known-name allowlist for tags without
 * an explicit size suffix (e.g. the default "llama3.2" tag, which resolves
 * to a 3B model). Intentionally simple — callers can always override via
 * settings rather than rely on this alone.
 */
export function isSmallOllamaModel(model: string): boolean {
  const name = model.toLowerCase();
  const sizeMatch = name.match(/(\d+(?:\.\d+)?)\s*b(?:\b|[^a-z])/);
  if (sizeMatch) {
    const size = parseFloat(sizeMatch[1]);
    if (!Number.isNaN(size)) return size <= 4;
  }
  const KNOWN_SMALL = ['llama3.2', 'phi3', 'smollm', 'gemma2:2b', 'gemma3:1b', 'qwen2.5:0.5b'];
  return KNOWN_SMALL.some((k) => name.includes(k));
}

/**
 * JSON Schema for the ExtractedTriple[] shape, used with Ollama's native
 * `/api/chat` `format` parameter to constrain decoding (see providers.ts
 * `chatOllamaStructured`). Mirrors the fields documented on ExtractedTriple
 * above, including `excerpt` (rule 10 of EXTRACTION_SYSTEM_PROMPT).
 */
export function buildExtractedTripleSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Kebab-case concept slug, e.g. "coffee-bean"' },
        predicate: { type: 'string', description: 'Kebab-case verb phrase, e.g. "has-property"' },
        object: { type: 'string', description: 'Kebab-case concept slug, or the literal value when objectIsLiteral is true' },
        objectIsLiteral: { type: 'boolean', description: 'True when object is a literal string/number/date/boolean rather than a concept reference' },
        datatype: { type: 'string', enum: ['string', 'number', 'date', 'boolean'] },
        gloss: { type: 'string', description: 'One short human-readable sentence describing the fact' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        excerpt: { type: 'string', description: 'Verbatim sentence or phrase from the source text this triple was derived from' }
      },
      required: ['subject', 'predicate', 'object']
    }
  };
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

/**
 * Convert raw LLM output into typed Statements bound to a Source.
 *
 * Pass `sourceText` to VERIFY each excerpt against it (kb:passage-grounding). The prompt
 * tells the model to quote the source verbatim, but until now nothing ever checked that
 * it did — so a paraphrased or invented quote was stored and shown to the user as
 * provenance. When an excerpt cannot be found in the source it is DROPPED and the
 * statement's confidence is penalised: a missing citation is honest, a forged one is not.
 *
 * Omitting `sourceText` leaves excerpts unverified (verdict 'unverifiable') — used where
 * the original text genuinely isn't available. It never fabricates a pass.
 */
export function triplesToStatements(
  triples: ExtractedTriple[],
  source: Source,
  sourceText?: string,
): Statement[] {
  const graph = iri(`urn:kbase:source/${source.id}`);
  const now = Date.now();
  const statements = triples.map((t) => {
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
    } as Statement;
  });

  return sourceText === undefined ? statements : groundStatements(statements, sourceText);
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
    (t: unknown): t is ExtractedTriple => {
      const r = t as Record<string, unknown>;
      return !!r && typeof r.subject === 'string' && typeof r.predicate === 'string' && r.object != null;
    }
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
