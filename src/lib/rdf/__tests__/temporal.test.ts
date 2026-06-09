import { describe, it, expect } from 'vitest';
import { findTemporalConflicts, buildEntityTimeline } from '../temporal';
import type { Statement } from '../types';
import { iri, lit } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function makeStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `stmt-${++_id}`,
    s: iri('urn:kbase:concept/person'),
    p: iri('urn:kbase:predicate/name'),
    o: lit('Alice'),
    g: iri('urn:kbase:source/src1'),
    sourceId: 'src1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

// ── findTemporalConflicts ─────────────────────────────────────────────────────

describe('findTemporalConflicts', () => {
  it('returns empty for no statements', () => {
    expect(findTemporalConflicts([])).toEqual([]);
  });

  it('returns empty for a single statement', () => {
    expect(findTemporalConflicts([makeStatement()])).toEqual([]);
  });

  it('returns empty when all statements agree (same s+p+o)', () => {
    const s1 = makeStatement({ o: lit('Alice') });
    const s2 = makeStatement({ o: lit('Alice') });
    expect(findTemporalConflicts([s1, s2])).toEqual([]);
  });

  it('detects conflict when same (s, p) has different objects', () => {
    const s1 = makeStatement({ o: lit('Alice') });
    const s2 = makeStatement({ o: lit('Bob') });
    const conflicts = findTemporalConflicts([s1, s2]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].subject).toBe('urn:kbase:concept/person');
    expect(conflicts[0].predicate).toBe('urn:kbase:predicate/name');
    expect(conflicts[0].values).toHaveLength(2);
    expect(conflicts[0].values.map(v => v.value)).toContain('Alice');
    expect(conflicts[0].values.map(v => v.value)).toContain('Bob');
  });

  it('does not conflict across different predicates', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/name'), o: lit('Alice') });
    const s2 = makeStatement({ p: iri('urn:kbase:predicate/nickname'), o: lit('Bob') });
    expect(findTemporalConflicts([s1, s2])).toEqual([]);
  });

  it('does not conflict across different subjects', () => {
    const s1 = makeStatement({ s: iri('urn:kbase:concept/personA'), o: lit('Alice') });
    const s2 = makeStatement({ s: iri('urn:kbase:concept/personB'), o: lit('Bob') });
    expect(findTemporalConflicts([s1, s2])).toEqual([]);
  });

  it('reports high severity when no time info', () => {
    const s1 = makeStatement({ o: lit('Alice') });
    const s2 = makeStatement({ o: lit('Bob') });
    const conflicts = findTemporalConflicts([s1, s2]);
    expect(conflicts[0].severity).toBe('high');
  });

  it('records the sourceId in conflict values', () => {
    const s1 = makeStatement({ o: lit('Alice'), sourceId: 'source-a' });
    const s2 = makeStatement({ o: lit('Bob'), sourceId: 'source-b' });
    const conflicts = findTemporalConflicts([s1, s2]);
    const sourceIds = conflicts[0].values.map(v => v.sourceId);
    expect(sourceIds).toContain('source-a');
    expect(sourceIds).toContain('source-b');
  });

  it('handles IRI objects', () => {
    const s1 = makeStatement({ o: iri('urn:kbase:concept/alice') });
    const s2 = makeStatement({ o: iri('urn:kbase:concept/bob') });
    const conflicts = findTemporalConflicts([s1, s2]);
    expect(conflicts).toHaveLength(1);
  });

  it('produces one conflict per (s, p) pair even with many differing objects', () => {
    const stmts = ['Alice', 'Bob', 'Charlie'].map(n => makeStatement({ o: lit(n) }));
    const conflicts = findTemporalConflicts(stmts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].values).toHaveLength(3);
  });
});

// ── buildEntityTimeline ──────────────────────────────────────────────────────

describe('buildEntityTimeline', () => {
  it('returns empty for no matching statements', () => {
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', []);
    expect(result).toEqual([]);
  });

  it('returns entries for matching (entity, predicate) pairs', () => {
    const s1 = makeStatement({ createdAt: 1000 });
    const s2 = makeStatement({ createdAt: 2000, o: lit('Alicia') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1, s2]);
    expect(result).toHaveLength(2);
  });

  it('excludes statements with different subjects', () => {
    const s1 = makeStatement({ s: iri('urn:kbase:concept/other') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1]);
    expect(result).toEqual([]);
  });

  it('excludes statements with different predicates', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/nickname') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1]);
    expect(result).toEqual([]);
  });

  it('sorts entries by createdAt ascending', () => {
    const s1 = makeStatement({ createdAt: 3000, o: lit('Charlie') });
    const s2 = makeStatement({ createdAt: 1000, o: lit('Alice') });
    const s3 = makeStatement({ createdAt: 2000, o: lit('Bob') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1, s2, s3]);
    expect(result.map(e => e.value)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('extracts the string value from literal objects', () => {
    const s1 = makeStatement({ o: lit('Alice') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1]);
    expect(result[0].value).toBe('Alice');
  });

  it('extracts the IRI value from IRI objects', () => {
    const s1 = makeStatement({ o: iri('urn:kbase:concept/alice') });
    const result = buildEntityTimeline('urn:kbase:concept/person', 'urn:kbase:predicate/name', [s1]);
    expect(result[0].value).toBe('urn:kbase:concept/alice');
  });
});
