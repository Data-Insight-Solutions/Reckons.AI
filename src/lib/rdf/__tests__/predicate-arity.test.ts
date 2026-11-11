import { describe, it, expect } from 'vitest';
import { predicateArity, isSingleValued, localName, MIN_SUBJECTS_FOR_FUNCTIONAL } from '../predicate-arity';
import { predicateArity as mcpArity, MIN_SUBJECTS_FOR_FUNCTIONAL as MCP_MIN } from '../../../../mcp-server/src/review-session';

const t = (subject: string, predicate: string, object: string) => ({ subject, predicate, object });

describe('predicateArity (app copy of the review procedure rule)', () => {
  const graph = [
    ...Array.from({ length: 8 }, (_, i) => t(`s${i}`, 'urn:kbase:predicate/has-status', 'planned')),
    ...Array.from({ length: 10 }, (_, i) => t(`s${i}`, 'urn:kbase:predicate/has', `a${i}`)),
    t('s0', 'urn:kbase:predicate/has', 'extra'),
    t('s0', 'urn:kbase:predicate/rare', 'x'),
  ];
  it('single-valued over enough subjects is functional; plural, thin and unknown are not', () => {
    const a = predicateArity(graph);
    expect(isSingleValued(a, 'urn:kbase:predicate/has-status')).toBe(true);
    expect(isSingleValued(a, 'urn:kbase:predicate/has')).toBe(false);
    expect(isSingleValued(a, 'urn:kbase:predicate/rare')).toBe(false);
    expect(isSingleValued(a, 'urn:kbase:predicate/never-seen')).toBe(false);
  });
  it('agrees with the MCP server implementation on the same triples', () => {
    expect(MIN_SUBJECTS_FOR_FUNCTIONAL).toBe(MCP_MIN);
    expect([...predicateArity(graph)].sort()).toEqual([...mcpArity(graph)].sort());
  });
  it('compares predicates by local name', () => {
    expect(localName('kpred:has-status')).toBe('has-status');
    expect(localName('urn:kbase:predicate/has-status')).toBe('has-status');
  });
});
