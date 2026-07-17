/**
 * Prune analysis — the two lenses that answer "what does this graph carry that it does not need?"
 *
 * The danger of a prune is a false positive: flagging a node the user cared about is destroying
 * knowledge, the one thing this app exists to protect. So the tests pin the guard rails — a
 * well-connected node is never pruned however off-theme, an on-theme node is never pruned however
 * lonely, and a fresh or blocking suggestion is never pruned however old the queue around it.
 */
import { describe, it, expect } from 'vitest';
import { analyzeNodePrune, analyzeSuggestionPrune, tokenize } from '../prune';
import type { Statement, Term, NamedNode } from '../types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });
let n = 0;
const st = (s: string, p: string, o: Term, status: Statement['status'] = 'confirmed'): Statement => ({
  id: `s${n++}`, s: iri(s), p: iri(p), o, g: iri('urn:g'), sourceId: 'x',
  confidence: 1, status, createdAt: 0, updatedAt: 0,
});
const label = (s: string, l: string) => st(s, 'http://www.w3.org/2000/01/rdf-schema#label', lit(l));
const edge = (s: string, o: string) => st(s, 'urn:kbase:predicate/relates-to', iri(o));

describe('analyzeNodePrune (main graph)', () => {
  // A hub connected to many nodes, plus a lonely off-theme node and a lonely on-theme node.
  const stmts = [
    label('urn:hub', 'Coffee Roasting'),
    edge('urn:hub', 'urn:beans'), edge('urn:hub', 'urn:grind'), edge('urn:hub', 'urn:water'),
    label('urn:beans', 'Coffee Beans'), label('urn:grind', 'Grind Size'), label('urn:water', 'Water Temperature'),
    label('urn:stray', 'Quarterly Tax Filing'), edge('urn:stray', 'urn:hub'), // 1 edge, off-theme
    label('urn:lonely', 'Espresso'), edge('urn:lonely', 'urn:hub'),           // 1 edge, on-theme
  ];
  const opts = { title: 'Coffee Roasting', description: 'beans grind water espresso brewing' };

  it('flags the weakly-connected, off-theme node as prune', () => {
    const scores = analyzeNodePrune(stmts, opts);
    const stray = scores.find((s) => s.entity === 'urn:stray')!;
    expect(stray.prune).toBe(true);
    expect(stray.reason).toMatch(/off-theme/);
  });

  it('never prunes a well-connected node, however off-theme', () => {
    const scores = analyzeNodePrune(stmts, { title: 'Something Unrelated', description: 'xyz' });
    expect(scores.find((s) => s.entity === 'urn:hub')!.prune).toBe(false);
  });

  it('never prunes a lonely but on-theme node', () => {
    const scores = analyzeNodePrune(stmts, opts);
    expect(scores.find((s) => s.entity === 'urn:lonely')!.prune).toBe(false);
  });

  it('accepts a pluggable relevance scorer (e.g. embeddings)', () => {
    const scores = analyzeNodePrune(stmts, { relevance: () => 1 }); // everything on-theme → nothing pruned
    expect(scores.every((s) => !s.prune)).toBe(true);
  });

  it('ignores rejected/superseded statements when scoring strength', () => {
    const withDead = [...stmts, st('urn:stray', 'urn:kbase:predicate/relates-to', iri('urn:x'), 'rejected')];
    const a = analyzeNodePrune(stmts, opts).find((s) => s.entity === 'urn:stray')!.degree;
    const b = analyzeNodePrune(withDead, opts).find((s) => s.entity === 'urn:stray')!.degree;
    expect(b).toBe(a); // rejected edge didn't raise the degree
  });
});

describe('analyzeSuggestionPrune (review mode)', () => {
  const now = Date.parse('2026-07-16T00:00:00Z');
  const days = (d: number) => new Date(now - d * 86_400_000).toISOString();

  it('prunes re-derivable findings', () => {
    const [r] = analyzeSuggestionPrune([{ subject: 'urn:s', predicate: 'urn:p', question: '[graph-lint/predicate-economy] stat' }], { now });
    expect(r.prune).toBe(true);
    expect(r.reason).toBe('rederivable');
  });

  it('prunes empty/malformed and stale non-blocking suggestions', () => {
    const res = analyzeSuggestionPrune([
      { subject: 'urn:a', predicate: 'urn:p' }, // empty
      { subject: 'urn:b', predicate: 'urn:p', question: 'old FYI', addedAt: days(30), priority: 'medium' }, // stale
    ], { now });
    expect(res[0]).toMatchObject({ prune: true, reason: 'empty' });
    expect(res[1]).toMatchObject({ prune: true, reason: 'stale' });
  });

  it('keeps fresh, blocking, and high-priority suggestions', () => {
    const res = analyzeSuggestionPrune([
      { subject: 'urn:fresh', predicate: 'urn:p', question: 'recent', addedAt: days(1) },
      { subject: 'urn:blk', predicate: 'urn:p', question: 'old but blocks', addedAt: days(90), blocks: 'urn:feature' },
      { subject: 'urn:hi', predicate: 'urn:p', question: 'old but high', addedAt: days(90), priority: 'high' },
    ], { now });
    expect(res.every((r) => !r.prune)).toBe(true);
  });

  it('never prunes a resolved fact (it is not a suggestion)', () => {
    const [r] = analyzeSuggestionPrune([{ subject: 'urn:s', predicate: 'urn:p', object: 'answered', addedAt: days(999) }], { now });
    expect(r.prune).toBe(false);
  });
});

describe('tokenize', () => {
  it('lowercases, splits, drops stopwords and short tokens', () => {
    expect(tokenize('The Coffee Roasting of Beans')).toEqual(['coffee', 'roasting', 'beans']);
  });
});
