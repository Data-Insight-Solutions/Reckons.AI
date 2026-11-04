/**
 * F122.1.3 — a changed document marks its anchors stale instead of misplacing them. The evidence
 * section prefers the stored anchor and verifies it; a fact with no anchor keeps the view-time
 * derivation, so nothing already ingested regresses.
 */
import { describe, it, expect } from 'vitest';
import { checkAnchor, deriveEvidence, evidenceNotice } from '../statement-evidence';
import { anchorFor } from '../source-chunks';

const TEXT = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. The harbor handled grain and timber. ${'Filler words sit here. '.repeat(10)}`).join('\n\n');
const SRC = { id: 'doc1', hash: 'ab'.repeat(32) };
const QUOTE = 'Paragraph 20. The harbor handled grain';
const anchor = anchorFor(SRC, TEXT, QUOTE)!;
const input = (over: Partial<Parameters<typeof deriveEvidence>[0]> = {}) => ({
  sourceTitle: 'Harbor', excerpt: QUOTE, sourceText: TEXT, anchor, retainedHash: SRC.hash, ...over,
});

describe('a stored anchor is preferred and verified (F122.1.3)', () => {
  it('a valid anchor yields the anchored view from the STORED span, marked exact', () => {
    const e = deriveEvidence(input());
    expect(e.kind).toBe('anchored');
    if (e.kind !== 'anchored') return;
    expect(e.highlight).toBe(QUOTE);
    expect(e.match).toBe('exact');
    expect(e.before + e.highlight + e.after).toContain(QUOTE);
  });

  it('editing one character BEFORE the anchor makes the evidence stale (the span has moved)', () => {
    const edited = 'X' + TEXT;
    const e = deriveEvidence(input({ sourceText: edited, retainedHash: undefined }));
    expect(e.kind).toBe('stale');
    if (e.kind === 'stale') { expect(e.reason).toBe('span-moved'); expect(e.excerpt).toBe(QUOTE); }
  });

  it('a different document revision is stale as source-changed, even if the span still reads the same', () => {
    const e = deriveEvidence(input({ retainedHash: 'cd'.repeat(32) }));
    expect(e.kind).toBe('stale');
    if (e.kind === 'stale') expect(e.reason).toBe('source-changed');
  });

  it('editing one character INSIDE the span is stale', () => {
    const at = anchor.start + 5;
    const e = deriveEvidence(input({ sourceText: TEXT.slice(0, at) + '#' + TEXT.slice(at + 1) }));
    expect(e.kind).toBe('stale');
  });

  it('text added AFTER the span leaves the anchor valid', () => {
    expect(deriveEvidence(input({ sourceText: TEXT + '\n\nAn appended paragraph.' })).kind).toBe('anchored');
  });

  it('text cut off before the span ends is stale', () => {
    expect(deriveEvidence(input({ sourceText: TEXT.slice(0, anchor.end - 3) })).kind).toBe('stale');
  });

  it('a stale anchor is NOT silently re-located, even though the quote still occurs in the text', () => {
    const shifted = 'X' + TEXT;
    expect(shifted.includes(QUOTE)).toBe(true);
    expect(deriveEvidence(input({ sourceText: shifted, retainedHash: undefined })).kind).toBe('stale');
  });

  it('a missing hash on either side falls back to the span check alone', () => {
    expect(deriveEvidence(input({ retainedHash: undefined })).kind).toBe('anchored');
    expect(checkAnchor({ ...anchor, sourceHash: '' }, TEXT, QUOTE, undefined).ok).toBe(true);
  });

  it('a quote that differs only by case or spacing from the span is still valid, marked normalized', () => {
    const e = deriveEvidence(input({ excerpt: '  paragraph 20.   THE harbor handled grain ' }));
    expect(e.kind).toBe('anchored');
    if (e.kind === 'anchored') expect(e.match).toBe('normalized');
  });

  it('a whole-document CRLF conversion is stale (offsets shift)', () => {
    expect(deriveEvidence(input({ sourceText: TEXT.replace(/\n/g, '\r\n'), retainedHash: undefined })).kind).toBe('stale');
  });

  it('an anchor that falls outside the text is stale, never a thrown error', () => {
    expect(deriveEvidence(input({ anchor: { ...anchor, start: 10_000_000, end: 10_000_010 } })).kind).toBe('stale');
    expect(deriveEvidence(input({ anchor: { ...anchor, start: -3, end: 4 } })).kind).toBe('stale');
    expect(deriveEvidence(input({ anchor: { ...anchor, start: 9, end: 9 } })).kind).toBe('stale');
  });

  it('an ungrounded fact never shows an anchor, and no text means nothing to verify against', () => {
    expect(deriveEvidence(input({ grounded: false })).kind).toBe('excerpt-only');
    expect(deriveEvidence(input({ sourceText: null })).kind).toBe('excerpt-only');
  });

  it('says plainly what happened, and does not mark a passage', () => {
    const moved = evidenceNotice(deriveEvidence(input({ sourceText: 'X' + TEXT, retainedHash: undefined })));
    const changed = evidenceNotice(deriveEvidence(input({ retainedHash: 'cd'.repeat(32) })));
    expect(moved).toMatch(/moved or changed/);
    expect(changed).toMatch(/source changed since this was extracted/);
    expect(changed).toMatch(/saved with the statement/);
  });
});

describe('a fact with no stored anchor keeps today\'s derivation (nothing regresses)', () => {
  it('still resolves as anchored from the quote alone', () => {
    const e = deriveEvidence({ sourceTitle: 'Harbor', excerpt: QUOTE, sourceText: TEXT });
    expect(e.kind).toBe('anchored');
  });
  it('a retained hash alone cannot make an unanchored fact stale', () => {
    expect(deriveEvidence({ sourceTitle: 'Harbor', excerpt: QUOTE, sourceText: TEXT, retainedHash: 'cd'.repeat(32) }).kind).toBe('anchored');
  });
  it('and a moved quote is still found by the old search', () => {
    expect(deriveEvidence({ sourceTitle: 'Harbor', excerpt: QUOTE, sourceText: 'X' + TEXT }).kind).toBe('anchored');
  });
});
