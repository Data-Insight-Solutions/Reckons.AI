/**
 * F122.1.1 — a fact records the span of the retained text its quote came from, at extraction time.
 * Text spans only, optional fields on the fact; a fact whose quote is not verified has none.
 */
import { describe, it, expect } from 'vitest';
import { anchorFor, attachAnchors, chunkIri, chunkText, anchorExcerpt } from '../source-chunks';
import { triplesToStatements, type ExtractedTriple } from '../../integrations/llm/extractor';
import type { Source, EvidenceSpan } from '../../rdf/types';

const TEXT = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}. The harbor handled grain and timber, and "ferries" ran daily — mostly. ${'Filler words sit here. '.repeat(8)}`).join('\n\n');
const SOURCE: Source = { id: 'doc1', title: 'Harbor', uri: 'file://h', kind: 'document', ingestedAt: 1, hash: 'ab'.repeat(32) } as Source;
const triple = (excerpt: string | undefined, subject = 'harbor'): ExtractedTriple => ({ subject, predicate: 'handled', object: 'grain', excerpt });

describe('anchorFor / attachAnchors', () => {
  it('a grounded quote gets a span that slices back to the quote, in the chunk that holds it', () => {
    const quote = 'Paragraph 60. The harbor handled grain and timber';
    const [st] = triplesToStatements([triple(quote)], SOURCE, TEXT);
    expect(st.grounded).toBe(true);
    expect(st.anchor).toBeDefined();
    expect(TEXT.slice(st.anchor!.start, st.anchor!.end)).toBe(quote);
    expect(st.anchor!.sourceHash).toBe(SOURCE.hash);
    const chunks = chunkText(TEXT);
    const holder = chunks.find((c) => st.anchor!.start >= c.start && st.anchor!.start < c.end)!;
    expect(st.anchor!.chunk).toBe(chunkIri('doc1', holder.index));
    expect(holder.index).toBeGreaterThan(0);
  });

  it('re-chunking the same text yields the same chunk IRI', () => {
    const a = anchorFor(SOURCE, TEXT, 'Paragraph 60. The harbor')!;
    const b = anchorFor(SOURCE, `${TEXT}`, 'Paragraph 60. The harbor')!;
    expect(a).toEqual(b);
  });

  it('an ungrounded quote has no anchor (and loses its excerpt, as before)', () => {
    const [st] = triplesToStatements([triple('A sentence the document never contains.')], SOURCE, TEXT);
    expect(st.grounded).toBe(false);
    expect(st.anchor).toBeUndefined();
  });

  it('no quote, no source text, or no hash: no anchor, and nothing is invented', () => {
    expect(triplesToStatements([triple(undefined)], SOURCE, TEXT)[0].anchor).toBeUndefined();
    expect(triplesToStatements([triple('Paragraph 3.')], SOURCE)[0].anchor).toBeUndefined();
    expect(triplesToStatements([triple('Paragraph 3.')], { ...SOURCE, hash: undefined }, TEXT)[0].anchor).toBeUndefined();
  });

  it('an anchor already on a fact is never overwritten', () => {
    const keep = { chunk: 'urn:kbase:source/doc1/chunk/0', start: 0, end: 5, sourceHash: 'x' };
    const out = attachAnchors([{ excerpt: 'Paragraph 3.', grounded: true, anchor: keep }], SOURCE, TEXT);
    expect(out[0].anchor).toBe(keep);
  });

  it('only grounded facts are anchored, in a mixed batch, and the order is kept', () => {
    const out = attachAnchors(
      [{ excerpt: 'Paragraph 3.', grounded: true }, { excerpt: 'Paragraph 4.', grounded: false }, { excerpt: 'Paragraph 5.' }] as Array<{ excerpt: string; grounded?: boolean; anchor?: EvidenceSpan }>,
      SOURCE, TEXT,
    );
    expect(out.map((s) => !!s.anchor)).toEqual([true, false, false]);
  });

  describe('placement cases grounding accepts must be placeable (found by the local panel run)', () => {
    const at = (quote: string) => anchorFor(SOURCE, TEXT, quote);
    it('a quote that differs by case', () => {
      const a = at('paragraph 7. the HARBOR handled grain')!;
      expect(TEXT.slice(a.start, a.end).toLowerCase()).toBe('paragraph 7. the harbor handled grain');
    });
    it('straight quotes against curly quotes, and a dash variant', () => {
      const text = 'He said “ferries” ran daily – mostly.';
      const a = anchorFor(SOURCE, text, 'said "ferries" ran daily - mostly')!;
      expect(text.slice(a.start, a.end)).toBe('said “ferries” ran daily – mostly');
    });
    it('a newline in the text where the quote has a space', () => {
      const text = 'First part of\nthe sentence that wraps.';
      const a = anchorFor(SOURCE, text, 'part of the sentence')!;
      expect(text.slice(a.start, a.end)).toBe('part of\nthe sentence');
    });
    it('regex metacharacters in the quote are literal', () => {
      const text = 'Path is C:\\path\\to\\file.txt (see [1]) costing $5.00?';
      const a = anchorFor(SOURCE, text, 'C:\\path\\to\\file.TXT (see [1]) costing $5.00?')!;
      expect(text.slice(a.start, a.end)).toBe('C:\\path\\to\\file.txt (see [1]) costing $5.00?');
    });
    it('leading and trailing whitespace in the quote is not part of the span', () => {
      const a = at('   Paragraph 2. The harbor   ')!;
      expect(TEXT.slice(a.start, a.end)).toBe('Paragraph 2. The harbor');
    });
    it('a quote at offset 0 and one ending the text', () => {
      expect(at('Paragraph 0.')!.start).toBe(0);
      const tail = 'Filler words sit here.';
      const a = at(tail + ' ')!;
      expect(a.end).toBeLessThanOrEqual(TEXT.length);
    });
    it('astral characters are counted in UTF-16 units, as the chunker counts them', () => {
      const text = `Before 🙂 emoji. ${'x '.repeat(10)} Then 🙂 smile here.`;
      const a = anchorFor(SOURCE, text, 'Then 🙂 smile')!;
      expect(text.slice(a.start, a.end)).toBe('Then 🙂 smile');
    });
    it('a quote that occurs twice is placed at its FIRST occurrence (a known limit, not a guess at the second)', () => {
      const text = 'The ferry ran. Later, the ferry ran again.';
      const a = anchorFor(SOURCE, text, 'ferry ran')!;
      expect(a.start).toBe(4);
    });
    it('a quote that is only part of a longer sentence is placed inside it', () => {
      const a = at('harbor handled grain')!;
      expect(TEXT.slice(a.start, a.end)).toBe('harbor handled grain');
    });
    it('a quote across a chunk boundary is placed in the chunk where it STARTS', () => {
      const chunks = chunkText(TEXT);
      const edge = chunks[1];
      const quote = TEXT.slice(edge.start - 15, edge.start + 15);
      const a = anchorFor(SOURCE, TEXT, quote)!;
      expect(a.chunk).toBe(chunkIri('doc1', 0));
      expect(a.end).toBeGreaterThan(edge.start);
    });
    it('empty text or empty quote places nothing', () => {
      expect(anchorFor(SOURCE, '', 'x')).toBeNull();
      expect(anchorFor(SOURCE, TEXT, '   ')).toBeNull();
    });
    it('the view-time derivation and the stored anchor agree (same function)', () => {
      const quote = 'Paragraph 33. The harbor';
      const chunks = chunkText(TEXT);
      const view = anchorExcerpt(TEXT, quote, chunks)!;
      const stored = anchorFor(SOURCE, TEXT, quote)!;
      expect([stored.start, stored.end, stored.chunk]).toEqual([view.start, view.end, chunkIri('doc1', view.chunkIndex)]);
    });
  });

  it('the stored span has the shape the passage jump reads ({start, end})', () => {
    // locatePassageJump (#456) takes a StoredSpan = { start, end }; an EvidenceSpan must satisfy it as is.
    const span: { start: number; end: number } = anchorFor(SOURCE, TEXT, 'Paragraph 9.')!;
    expect(TEXT.slice(span.start, span.end)).toBe('Paragraph 9.');
  });
});
