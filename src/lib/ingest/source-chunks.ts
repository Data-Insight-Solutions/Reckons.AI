/**
 * Source chunks (F221 / F78) — the shared, pure half of the source corpus.
 *
 * Matt, 2026-09-29: chunk text is stored as Turtle, one corpus file per source
 * (sources/<slug>-<hash8>/chunks.ttl), beside the original and never inside the knowledge graph
 * file; and the browser and the CLI use the SAME code so neither drifts into its own format. So
 * this module touches no DOM, no filesystem and no Node API: it turns text into chunks, chunks into
 * Turtle, and an excerpt into a chunk reference. The IO half writes the file.
 *
 * THREE RULES THIS MODULE HOLDS:
 *
 *  1. A CUT IS NEVER SILENT. Extraction reads at most EXTRACTION_TEXT_LIMIT characters of a source,
 *     and until 2026-09-30 it sliced the rest off without a word (extractor.ts, extract-critic.ts).
 *     `extractionCoverage` states what was read, and callers show it.
 *  2. OVERLAP IS CONTEXT, NOT CONTENT (kb:text-chunking). Chunk CONTENT ranges are disjoint and
 *     cover the text exactly, so coverage adds up and a span belongs to one chunk. The overlap a
 *     reader or an extractor needs for continuity is carried separately as `contextStart`.
 *  3. EXISTING VOCABULARY, NOT NEW PREDICATES (F221's decision): a chunk is dcterms:isPartOf its
 *     source, ordered by schema:position, its text is rdf:value, and its place in the document is a
 *     W3C Web Annotation oa:TextPositionSelector — the same selector a statement's evidence anchor
 *     uses (F122.1), so chunk and anchor speak one language.
 */

/** Characters of a source the extractor reads in one call. The single source of truth. */
export const EXTRACTION_TEXT_LIMIT = 12_000;

export type ExtractionCoverage = {
  /** Characters in the source. */
  total: number;
  /** Characters the extractor was given. */
  read: number;
  truncated: boolean;
  /** read / total, 0–100, rounded down so a cut never reads as 100%. */
  percent: number;
};

export function extractionCoverage(textLength: number, limit = EXTRACTION_TEXT_LIMIT): ExtractionCoverage {
  const read = Math.min(textLength, limit);
  return { total: textLength, read, truncated: textLength > limit, percent: textLength === 0 ? 100 : Math.floor((100 * read) / textLength) };
}

/** The sentence a person sees when a source was cut. */
export function coverageNotice(title: string, c: ExtractionCoverage): string | null {
  if (!c.truncated) return null;
  return `Only the first ${c.read.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')} characters of "${title}" were read (${c.percent}%). Facts from the rest are not in your space.`;
}

export type Chunk = {
  /** 0-based order in the source. */
  index: number;
  /** Content range [start, end) in the source text. Disjoint across chunks; together they cover it. */
  start: number;
  end: number;
  /** Where this chunk's reading context begins: `start` minus the overlap carried from before. */
  contextStart: number;
  /** The content text, source.slice(start, end). */
  text: string;
};

export type ChunkOptions = { size?: number; overlap?: number };

/**
 * The best boundary at or before `limit` and after `floor`: a paragraph break, then a sentence
 * end, then any whitespace; failing all three, `limit` itself (a hard cut inside a very long word).
 */
function boundaryBefore(text: string, floor: number, limit: number): number {
  const window = text.slice(floor, limit);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > 0) return floor + paragraph + 2;
  let sentence = -1;
  for (const m of window.matchAll(/[.!?]["')\]]?\s+/g)) sentence = (m.index ?? 0) + m[0].length;
  if (sentence > 0) return floor + sentence;
  const space = window.search(/\s\S*$/);
  if (space > 0) return floor + space + 1;
  return limit;
}

/**
 * Split a source into chunks of about `size` characters, breaking at paragraph, then sentence,
 * boundaries, never going below half the target unless the text runs out. Deterministic: the same
 * text always yields the same chunks, so a chunk index is a stable reference for one version of a
 * source (its hash names the version).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const size = Math.max(200, opts.size ?? 4000);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 400, Math.floor(size / 2)));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.length;
    if (text.length - start > size) end = boundaryBefore(text, start + Math.floor(size / 2), start + size);
    chunks.push({ index: chunks.length, start, end, contextStart: Math.max(0, start - overlap), text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

export const sourceIri = (sourceId: string) => `urn:kbase:source/${sourceId}`;
export const chunkIri = (sourceId: string, index: number) => `urn:kbase:source/${sourceId}/chunk/${index}`;

/** Turtle string literal: escape backslash, quote and control characters; long form for newlines. */
export function turtleLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (!escaped.includes('\n')) return `"${escaped}"`;
  // Long form keeps a chunk readable in the file; a run of quotes at the end would close it early.
  return `"""${escaped.replace(/"""/g, '\\"\\"\\"')}"""`;
}

export type ChunkCorpus = {
  sourceId: string;
  title: string;
  /** SHA-256 of the text the chunks were cut from — names the version they belong to. */
  sha256: string;
  chunks: Chunk[];
  /** Derivation time, ISO 8601. */
  generatedAt: string;
};

/** chunks.ttl for one source. Everything in it is derived and rebuildable from the original. */
export function chunksToTurtle(corpus: ChunkCorpus): string {
  const src = `<${sourceIri(corpus.sourceId)}>`;
  const lines = [
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix oa:      <http://www.w3.org/ns/oa#> .',
    '@prefix prov:    <http://www.w3.org/ns/prov#> .',
    '@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix schema:  <https://schema.org/> .',
    '@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '# Derived from the source text: rebuildable, never loaded into the statement store,',
    '# never part of an exported or published space (F221).',
    `${src} dcterms:title ${turtleLiteral(corpus.title)} ;`,
    `    dcterms:hasVersion ${turtleLiteral(`sha256:${corpus.sha256}`)} ;`,
    `    schema:numberOfItems ${corpus.chunks.length} .`,
    '',
  ];
  for (const c of corpus.chunks) {
    lines.push(
      `<${chunkIri(corpus.sourceId, c.index)}> dcterms:isPartOf ${src} ;`,
      `    schema:position ${c.index} ;`,
      `    prov:wasDerivedFrom ${src} ;`,
      `    prov:generatedAtTime "${corpus.generatedAt}"^^xsd:dateTime ;`,
      `    oa:hasSelector [ a oa:TextPositionSelector ; oa:start ${c.start} ; oa:end ${c.end} ] ;`,
      `    rdf:value ${turtleLiteral(c.text)} .`,
      '',
    );
  }
  return lines.join('\n');
}

export type ChunkAnchor = {
  chunkIndex: number;
  /** Span of the excerpt in the source text, [start, end). */
  start: number;
  end: number;
  /** 'exact' when the excerpt occurs verbatim; 'normalized' when only whitespace differed. */
  match: 'exact' | 'normalized';
};

/**
 * Where a statement's verbatim excerpt sits: which chunk, and the exact span. Null when the excerpt
 * is not in the text — an ungrounded quote gets no anchor rather than a guessed one. Whitespace-only
 * differences (a PDF line break inside the quote) still match, and say so.
 */
export function anchorExcerpt(text: string, excerpt: string, chunks: Chunk[]): ChunkAnchor | null {
  const needle = excerpt.trim();
  if (!needle) return null;
  let start = text.indexOf(needle);
  let end = start + needle.length;
  let match: ChunkAnchor['match'] = 'exact';
  if (start < 0) {
    const pattern = needle.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const m = new RegExp(pattern).exec(text);
    if (!m) return null;
    start = m.index;
    end = m.index + m[0].length;
    match = 'normalized';
  }
  const chunk = chunks.find((c) => start >= c.start && start < c.end);
  return chunk ? { chunkIndex: chunk.index, start, end, match } : null;
}
