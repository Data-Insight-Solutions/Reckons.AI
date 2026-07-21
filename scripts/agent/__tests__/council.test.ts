import { describe, it, expect } from 'vitest';
import { tallyFindings, normalizeKey, type MemberResult } from '../lib/council.js';

const ok = (member: string, findings: { file?: string; text: string }[]): MemberResult => ({
  member,
  ok: true,
  findings,
});
const missing = (member: string, reason: string): MemberResult => ({
  member,
  ok: false,
  reason,
  findings: [],
});

describe('normalizeKey', () => {
  it('folds case, collapses whitespace, strips list markers, and keys on file+text', () => {
    expect(normalizeKey({ text: '- Off-by-one   in LOOP' })).toBe(
      normalizeKey({ text: '3. off-by-one in loop' })
    );
    // File participates in the key: same text, different file → different key.
    expect(normalizeKey({ file: 'a.ts', text: 'bug' })).not.toBe(
      normalizeKey({ file: 'b.ts', text: 'bug' })
    );
  });
});

describe('tallyFindings — corroboration is provenance, not a score', () => {
  it('marks a finding both present members raised as agreed (quorum met)', () => {
    const t = tallyFindings([
      ok('claude', [{ file: 'x.ts', text: 'null deref on empty input' }]),
      ok('codex', [{ file: 'x.ts', text: 'Null deref on empty input' }]), // phrasing/case differ
    ]);
    expect(t.quorum).toBe(true);
    expect(t.findings).toHaveLength(1);
    expect(t.findings[0].agreement).toBe('agreed');
    expect(t.findings[0].assertedBy.sort()).toEqual(['claude', 'codex']);
  });

  it('when each member raises a different finding, both are split (single-asserter)', () => {
    const t = tallyFindings([
      ok('claude', [{ text: 'A' }]),
      ok('codex', [{ text: 'B' }]),
    ]);
    expect(t.findings).toHaveLength(2);
    expect(t.findings.every((f) => f.agreement === 'split')).toBe(true);
    expect(t.findings.every((f) => f.assertedBy.length === 1)).toBe(true);
  });
});

describe('tallyFindings — LEAD WITH DISAGREEMENT ordering', () => {
  it('returns split rows first, fewest asserters first, agreed rows last', () => {
    const t = tallyFindings([
      ok('local', [{ text: 'all-agree' }, { text: 'two-of-three' }]),
      ok('claude', [{ text: 'all-agree' }, { text: 'two-of-three' }, { text: 'lone-claude' }]),
      ok('codex', [{ text: 'all-agree' }]),
    ]);
    expect(t.quorum).toBe(true);
    const order = t.findings.map((f) => f.text);
    // lone (1 asserter) before two-of-three (2 asserters) before all-agree (agreed, last).
    expect(order).toEqual(['lone-claude', 'two-of-three', 'all-agree']);
    expect(t.findings[0].agreement).toBe('split');
    expect(t.findings[1].agreement).toBe('split');
    expect(t.findings[2].agreement).toBe('agreed');
  });
});

describe('tallyFindings — honest degradation (no silent single-voice council)', () => {
  it('records a missing member and never claims agreement without quorum', () => {
    const t = tallyFindings([
      ok('claude', [{ text: 'only voice present' }]),
      missing('codex', 'codex not installed'),
    ]);
    expect(t.quorum).toBe(false);
    expect(t.presentMembers).toEqual(['claude']);
    expect(t.missingMembers).toEqual([{ member: 'codex', reason: 'codex not installed' }]);
    // A single present voice cannot corroborate — the row is a split, not 'agreed'.
    expect(t.findings[0].agreement).toBe('split');
    expect(t.findings[0].assertedBy).toEqual(['claude']);
  });
});
