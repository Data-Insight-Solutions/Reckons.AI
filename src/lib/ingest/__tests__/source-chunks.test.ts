/**
 * Source chunks (F221 / F78). The module's promises are arithmetic, so they are pinned exactly:
 * chunk content covers the text with no gap and no double count, a cut is always reported, the
 * Turtle parses with the decided vocabulary, and an anchor is exact or absent — never guessed.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { anchorExcerpt, chunkIri, chunksToTurtle, chunkText, coverageNotice, extractionCoverage, EXTRACTION_TEXT_LIMIT, turtleLiteral } from '../source-chunks';

const para = (n: number, words = 60) => Array.from({ length: words }, (_, i) => `word${n}_${i}`).join(' ') + '.';
const doc = Array.from({ length: 40 }, (_, i) => para(i)).join('\n\n');

describe('extractionCoverage — a cut is never silent', () => {
  it('reports a truncation with what was read', () => {
    const c = extractionCoverage(30_000);
    expect(c).toEqual({ total: 30_000, read: EXTRACTION_TEXT_LIMIT, truncated: true, percent: 40 });
    expect(coverageNotice('Big report', c)).toBe('Only the first 12,000 of 30,000 characters of "Big report" were read (40%). Facts from the rest are not in your space.');
  });

  it('says nothing when the whole source was read', () => {
    expect(coverageNotice('Short', extractionCoverage(500))).toBeNull();
  });

  it('rounds down, so a cut can never display as 100%', () => {
    expect(extractionCoverage(12_001).percent).toBe(99);
  });
});

describe('chunkText — content is disjoint and covers the text exactly', () => {
  const chunks = chunkText(doc, { size: 2000, overlap: 200 });

  it('covers every character once: no gap, no overlap in content', () => {
    expect(chunks[0].start).toBe(0);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
    expect(chunks.at(-1)!.end).toBe(doc.length);
    expect(chunks.map((c) => c.text).join('')).toBe(doc);
  });

  it('breaks at paragraph boundaries when it can', () => {
    for (const c of chunks.slice(0, -1)) expect(doc.slice(c.end - 2, c.end)).toBe('\n\n');
  });

  it('carries overlap as context before the content, never inside it', () => {
    expect(chunks[0].contextStart).toBe(0);
    expect(chunks[1].contextStart).toBe(chunks[1].start - 200);
  });

  it('is deterministic', () => {
    expect(chunkText(doc, { size: 2000 })).toEqual(chunkText(doc, { size: 2000 }));
  });

  it('hard-cuts a text with no boundaries rather than looping', () => {
    const blob = 'x'.repeat(5000);
    const c = chunkText(blob, { size: 1000 });
    expect(c.map((x) => x.text).join('')).toBe(blob);
    expect(c.length).toBe(5);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });
});

describe('chunksToTurtle — the decided vocabulary, and it parses', () => {
  const text = 'First para with a "quote" and a back\\slash.\n\nSecond """ para.';
  const chunks = chunkText(text, { size: 200 });
  const ttl = chunksToTurtle({ sourceId: 'abc', title: 'A "titled" doc', sha256: 'f'.repeat(64), chunks, generatedAt: '2026-09-30T12:00:00Z' });
  type Q = { subject: { value: string }; predicate: { value: string }; object: { value: string } };
  const quads = new Parser().parse(ttl) as Q[];
  const value = (s: string, p: string) => quads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);

  it('parses, and each chunk is part of its source with its exact text', () => {
    expect(value(chunkIri('abc', 0), 'http://purl.org/dc/terms/isPartOf')).toEqual(['urn:kbase:source/abc']);
    expect(value(chunkIri('abc', 0), 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value')).toEqual([chunks[0].text]);
  });

  it('places each chunk with a W3C Web Annotation text-position selector', () => {
    const selector = quads.find((q) => q.subject.value === chunkIri('abc', 0) && q.predicate.value === 'http://www.w3.org/ns/oa#hasSelector')!.object;
    expect(value(selector.value, 'http://www.w3.org/ns/oa#start')).toEqual([String(chunks[0].start)]);
    expect(value(selector.value, 'http://www.w3.org/ns/oa#end')).toEqual([String(chunks[0].end)]);
  });

  it('round-trips quotes, backslashes and triple quotes in text', () => {
    const all = quads.filter((q) => q.predicate.value.endsWith('#value')).map((q) => q.object.value).join('');
    expect(all).toBe(text);
    expect(value('urn:kbase:source/abc', 'http://purl.org/dc/terms/title')).toEqual(['A "titled" doc']);
  });

  it('escapes a single-line literal without the long form', () => {
    expect(turtleLiteral('a "b" c')).toBe('"a \\"b\\" c"');
  });
});

describe('anchorExcerpt — chunk referencing is exact or absent', () => {
  const chunks = chunkText(doc, { size: 2000 });

  it('finds a verbatim excerpt and the chunk that holds it', () => {
    const excerpt = 'word25_3 word25_4 word25_5';
    const a = anchorExcerpt(doc, excerpt, chunks)!;
    expect(doc.slice(a.start, a.end)).toBe(excerpt);
    expect(a.match).toBe('exact');
    expect(a.start >= chunks[a.chunkIndex].start && a.start < chunks[a.chunkIndex].end).toBe(true);
  });

  it('matches across a line break inside the quote, and says it was normalized', () => {
    const text = 'The board approved\nthe budget in March.';
    const a = anchorExcerpt(text, 'approved the budget', chunkText(text))!;
    expect(a).toMatchObject({ match: 'normalized', chunkIndex: 0 });
    expect(text.slice(a.start, a.end)).toBe('approved\nthe budget');
  });

  it('returns null for a quote that is not in the source — no guessed anchor', () => {
    expect(anchorExcerpt(doc, 'this sentence was never written', chunks)).toBeNull();
  });
});
