/**
 * F53 review-at-scale — spotlight the decisions.
 * Conflicts and decisions get the spotlight; uncontested facts flow quietly; the spotlight is
 * capped to a manageable few, and an over-cap contested item is HELD BACK, never quieted.
 */
import { describe, it, expect } from 'vitest';
import {
  attentionScore,
  spotlightUserQueue,
  attentionSummary,
  SPOTLIGHT_THRESHOLD,
  DEFAULT_MAX_SPOTLIGHT,
} from '../review-attention';
import type { RoutedItem } from '../review-routing';
import type { Statement } from '../types';

let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'pending',
    createdAt: extra.createdAt ?? n,
    updatedAt: n,
    ...extra,
  } as Statement;
}
const item = (s: Statement, impact = 0): RoutedItem => ({ statement: s, gate: 'user', impact });

describe('attentionScore', () => {
  it('conflict dominates; a plain fact scores ~0', () => {
    expect(attentionScore({ conflict: true, impact: 0, decision: false }, 10)).toBeGreaterThanOrEqual(0.6);
    expect(attentionScore({ conflict: false, impact: 0, decision: false }, 10)).toBe(0);
  });
  it('a decision earns the spotlight threshold on its own signal', () => {
    // decision alone = 0.3 (< threshold) but spotlightUserQueue promotes decisions explicitly;
    // here we just check the weight contributes.
    expect(attentionScore({ conflict: false, impact: 0, decision: true }, 10)).toBeCloseTo(0.3);
  });
  it('blast radius nudges, normalized to the loudest item', () => {
    const full = attentionScore({ conflict: false, impact: 10, decision: false }, 10);
    const half = attentionScore({ conflict: false, impact: 5, decision: false }, 10);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeLessThanOrEqual(0.3);
  });
  it('never exceeds 1', () => {
    expect(attentionScore({ conflict: true, impact: 100, decision: true }, 10)).toBeLessThanOrEqual(1);
  });
});

const E = 'urn:kbase:concept/feature-x';
const P = 'urn:kbase:predicate/has-status'; // SINGLE_VALUED -> divergence is a CONFLICT

describe('spotlightUserQueue', () => {
  it('a CONFLICT is spotlighted; an uncontested fact flows quietly', () => {
    // feature-x: two incompatible statuses on a well-identified entity -> conflict.
    const all = [
      st(E, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:kbase:type/Feature', { id: 't' }),
      st(E, 'http://www.w3.org/2000/01/rdf-schema#label', 'Feature X', { id: 'l' }),
      st(E, P, 'planned', { id: 'c1' }),
      st(E, P, 'functional', { id: 'c2' }),
      st('urn:kbase:concept/other', P, 'planned', { id: 'plain' }),
    ];
    const lane = [item(all[2]), item(all[3]), item(all[4])];
    const q = spotlightUserQueue(lane, all);
    const spotIds = q.spotlight.map((i) => i.statement.id);
    expect(spotIds).toContain('c1');
    expect(spotIds).toContain('c2');
    expect(q.quiet.map((i) => i.statement.id)).toContain('plain'); // uncontested earth fact
  });

  it('a partial fact (open decision) is always spotlighted', () => {
    const decision = st('urn:kbase:concept/x', 'urn:kbase:predicate/owner', '?', { id: 'd', needsObject: true });
    const plain = st('urn:kbase:concept/y', 'urn:kbase:predicate/color', 'blue', { id: 'p' });
    const q = spotlightUserQueue([item(decision), item(plain)], [decision, plain]);
    expect(q.spotlight.map((i) => i.statement.id)).toContain('d');
    expect(q.quiet.map((i) => i.statement.id)).toContain('p');
  });

  it('caps the spotlight to a manageable few and HOLDS BACK the rest (never quiets them)', () => {
    // 10 decisions, all spotlight-worthy; cap at 3.
    const decisions = Array.from({ length: 10 }, (_, i) =>
      st(`urn:kbase:concept/e${i}`, 'urn:kbase:predicate/owner', '?', { id: `d${i}`, needsObject: true }),
    );
    const q = spotlightUserQueue(decisions.map((d) => item(d)), decisions, { maxSpotlight: 3 });
    expect(q.spotlight).toHaveLength(3);
    expect(q.heldBack).toBe(7);
    expect(q.quiet).toHaveLength(0); // contested items are NEVER dumped into quiet
  });

  it('is deterministic regardless of input order', () => {
    const a = st('urn:kbase:concept/a', 'urn:kbase:predicate/owner', '?', { id: 'a', needsObject: true, createdAt: 1 });
    const b = st('urn:kbase:concept/b', 'urn:kbase:predicate/owner', '?', { id: 'b', needsObject: true, createdAt: 2 });
    const q1 = spotlightUserQueue([item(a), item(b)], [a, b]);
    const q2 = spotlightUserQueue([item(b), item(a)], [a, b]);
    expect(q1.spotlight.map((i) => i.statement.id)).toEqual(q2.spotlight.map((i) => i.statement.id));
  });

  it('empty lane yields an honest summary', () => {
    const q = spotlightUserQueue([], []);
    expect(attentionSummary(q)).toMatch(/nothing/i);
  });
});

describe('constants are sane', () => {
  it('threshold and cap have sensible defaults', () => {
    expect(SPOTLIGHT_THRESHOLD).toBeGreaterThan(0);
    expect(SPOTLIGHT_THRESHOLD).toBeLessThan(1);
    expect(DEFAULT_MAX_SPOTLIGHT).toBeGreaterThan(0);
  });
});
