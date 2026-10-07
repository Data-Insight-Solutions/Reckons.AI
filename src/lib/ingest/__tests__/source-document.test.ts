import { describe, it, expect } from 'vitest';
import { iri, lit, type ReviewStatus, type Statement } from '../../rdf/types';
import {
  deriveSourceDocument, statusSummary, groupByStatus, sourceDocumentNotice, EMPTY_PASSAGE_NOTE,
} from '../source-document';
import { deriveEvidence } from '../statement-evidence';

// Synthetic text only (no personal captures): ten distinct paragraphs, cut small so there are
// several passages to place statements into.
const para = (n: number) => `Paragraph ${n} says something distinct about topic ${n}. `.repeat(8).trim();
const text = Array.from({ length: 10 }, (_, i) => para(i + 1)).join('\n\n');
const opts = { size: 400, overlap: 50 };

let n = 0;
function st(excerpt: string | undefined, status: ReviewStatus = 'pending', grounded?: boolean): Statement {
  n += 1;
  return {
    id: `st-${n}`,
    s: iri(`urn:kbase:entity/e${n}`),
    p: iri('urn:kbase:predicate/mentions'),
    o: lit(`object ${n}`),
    g: iri('urn:kbase:source/synthetic'),
    sourceId: 'synthetic', confidence: 0.9, excerpt, grounded, status,
    createdAt: 0, updatedAt: 0,
  };
}

describe('deriveSourceDocument', () => {
  it('places each statement in the passage its excerpt anchors to, and counts by status', () => {
    const a = st('Paragraph 7 says something distinct about topic 7.', 'confirmed');
    const b = st('Paragraph 7 says something distinct about topic 7.', 'pending');
    const c = st('Paragraph 1 says something distinct about topic 1.', 'rejected');
    const doc = deriveSourceDocument(text, [a, b, c], opts);
    expect(doc.kind).toBe('document');
    if (doc.kind !== 'document') return;
    const holding = doc.passages.filter((p) => p.statements.length);
    expect(holding).toHaveLength(2);
    const seven = doc.passages.find((p) => p.statements.includes(a))!;
    expect(seven.statements).toEqual([a, b]);
    expect(seven.counts).toEqual({ confirmed: 1, pending: 1 });
    expect(doc.passages.find((p) => p.statements.includes(c))!.counts).toEqual({ rejected: 1 });
    expect(doc.unplaced).toEqual([]);
  });

  it('agrees with the statement side about which passage a statement is in', () => {
    const s = st('Paragraph 5 says something distinct about topic 5.');
    const doc = deriveSourceDocument(text, [s], opts);
    const ev = deriveEvidence({ sourceTitle: 'S', excerpt: s.excerpt, sourceText: text }, opts);
    expect(doc.kind === 'document' && ev.kind === 'anchored').toBe(true);
    if (doc.kind !== 'document' || ev.kind !== 'anchored') return;
    expect(doc.passages[ev.chunkIndex].statements).toEqual([s]);
  });

  it('covers the whole text, in order, with nothing duplicated', () => {
    const doc = deriveSourceDocument(text, [], opts);
    if (doc.kind !== 'document') throw new Error('expected a document');
    expect(doc.passages.length).toBeGreaterThan(2);
    expect(doc.passages.map((p) => p.text).join('')).toBe(text);
    expect(doc.passages.map((p) => p.number)).toEqual(doc.passages.map((_, i) => i + 1));
  });

  it('never guesses a passage: unplaced statements carry their reason', () => {
    const none = st(undefined);
    const absent = st('a sentence that is nowhere in the text');
    const dropped = st('Paragraph 2 says something distinct', 'pending', false);
    const doc = deriveSourceDocument(text, [none, absent, dropped], opts);
    if (doc.kind !== 'document') throw new Error('expected a document');
    expect(doc.passages.every((p) => p.statements.length === 0)).toBe(true);
    expect(doc.unplaced).toEqual([
      { statement: none, reason: 'no-excerpt' },
      { statement: absent, reason: 'not-found' },
      // grounded=false is respected even though the quote does occur in this text.
      { statement: dropped, reason: 'not-in-source' },
    ]);
  });

  it('says the text was not kept when there is none, rather than drawing an empty document', () => {
    const doc = deriveSourceDocument(null, [st('x'), st('y')]);
    expect(doc).toEqual({ kind: 'no-text', statementCount: 2 });
    expect(sourceDocumentNotice(doc)).toMatch(/not kept/);
  });

  it('does not call an empty passage unread', () => {
    expect(EMPTY_PASSAGE_NOTE).not.toMatch(/not read yet/i);
    expect(EMPTY_PASSAGE_NOTE).toMatch(/not recorded/);
  });
});

describe('status helpers', () => {
  it('summarizes counts in a fixed order and omits zeroes', () => {
    expect(statusSummary({ pending: 2, confirmed: 1, 'pending-removal': 1 })).toBe('1 confirmed · 2 pending · 1 pending removal');
    expect(statusSummary({})).toBeNull();
  });

  it('groups statements by status in the same order', () => {
    const p = st('q', 'pending'), c = st('q', 'confirmed'), r = st('q', 'rejected');
    expect(groupByStatus([p, r, c]).map((g) => g.status)).toEqual(['confirmed', 'pending', 'rejected']);
  });
});
