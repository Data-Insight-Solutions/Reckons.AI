/**
 * Multi-graph query (F91/F94) — one question, several graphs.
 *
 * The tests that earn their place here are the epistemic ones. Merging answers from several
 * graphs is easy; the hard part is not lying about what the merge means — not presenting a
 * partial answer as complete, not calling repetition corroboration, and not resolving a
 * disagreement that is the most valuable thing the query found.
 */
import { describe, it, expect } from 'vitest';
import {
  queryGraphs, describeMultiGraphResult,
  type GraphSource, type MultiGraphResult,
} from '../multi-graph-query';
import type { NamedNode, ReviewStatus, Statement, Term } from '../types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

let n = 0;
const st = (
  s: string, p: string, o: Term,
  opts: { sourceId?: string; status?: ReviewStatus } = {},
): Statement => ({
  id: `s${n++}`,
  s: iri(s), p: iri(p), o,
  g: iri('urn:g'),
  sourceId: opts.sourceId ?? 'src-default',
  confidence: 1,
  status: opts.status ?? 'confirmed',
  createdAt: 0, updatedAt: 0,
});

const graph = (id: string, name: string, statements: Statement[]): GraphSource =>
  ({ id, name, statements });

const ALEX = 'urn:kbase:concept/alex';
const ROLE = 'urn:kbase:predicate/role';

describe('asking several graphs at once', () => {
  it('finds an entity across graphs and says which graphs know it', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, LABEL, lit('Alex'))]),
        graph('home', 'Home', [st(ALEX, LABEL, lit('Alex'))]),
        graph('other', 'Other', [st('urn:kbase:concept/sam', LABEL, lit('Sam'))]),
      ],
      { entities: [ALEX] },
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].graphs).toEqual(['home', 'work']);
    expect(result.searched).toEqual(['home', 'other', 'work']);
  });

  it('matches free text against labels and literal objects', () => {
    const result = queryGraphs(
      [graph('work', 'Work', [
        st(ALEX, LABEL, lit('Alex Rivera')),
        st('urn:kbase:concept/sam', LABEL, lit('Sam Patel')),
      ])],
      { text: 'rivera' },
    );
    expect(result.answers.map((a) => a.label)).toEqual(['Alex Rivera']);
  });

  it('carries the graph on every fact, so no answer is unattributed', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'))]),
        graph('home', 'Home', [st(ALEX, ROLE, lit('Engineer'))]),
      ],
      { entities: [ALEX] },
    );
    expect(result.answers[0].facts.map((f) => f.graphName).sort()).toEqual(['Home', 'Work']);
  });

  it('ignores rejected and superseded facts — a rejected fact is not an answer', () => {
    const result = queryGraphs(
      [graph('work', 'Work', [
        st(ALEX, LABEL, lit('Alex'), { status: 'rejected' }),
        st('urn:kbase:concept/sam', LABEL, lit('Sam'), { status: 'superseded' }),
      ])],
      { text: 'a' },
    );
    expect(result.answers).toEqual([]);
  });

  it('ranks entities known to the most graphs first', () => {
    const shared = st(ALEX, LABEL, lit('shared thing'));
    const result = queryGraphs(
      [
        graph('a', 'A', [shared, st('urn:only-a', LABEL, lit('shared thing'))]),
        graph('b', 'B', [st(ALEX, LABEL, lit('shared thing'))]),
      ],
      { text: 'shared' },
    );
    expect(result.answers[0].iri).toBe(ALEX);
  });
});

describe('a graph that could not be read is named', () => {
  // The classic federation bug: "no results" and "three of your graphs failed to open" are
  // opposite answers that look identical.
  const unavailable = [{ id: 'archive', name: 'Archive', reason: 'database locked' }];

  it('threads unavailable graphs into the result', () => {
    const result = queryGraphs([graph('work', 'Work', [])], { text: 'x' }, unavailable);
    expect(result.unavailable).toEqual(unavailable);
  });

  it('says the answer is incomplete, naming the graphs that failed', () => {
    const result = queryGraphs([graph('work', 'Work', [])], { text: 'x' }, unavailable);
    const text = describeMultiGraphResult(result);
    expect(text).toContain('Archive');
    expect(text).toContain('this answer is incomplete');
  });

  it('claims nothing about completeness when every graph answered', () => {
    const result = queryGraphs([graph('work', 'Work', [])], { text: 'x' });
    expect(describeMultiGraphResult(result)).toBe('0 results from 1 graph.');
  });
});

describe('agreement is not automatically corroboration', () => {
  it('marks agreement INDEPENDENT when the graphs cite different sources', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'), { sourceId: 'hr-export' })]),
        graph('home', 'Home', [st(ALEX, ROLE, lit('Engineer'), { sourceId: 'conversation' })]),
      ],
      { entities: [ALEX] },
    );
    const [agreement] = result.answers[0].agreements;
    expect(agreement.object).toBe('Engineer');
    expect(agreement.independent).toBe(true);
  });

  it('marks agreement NOT independent when both trace to one source', () => {
    // Both graphs are repeating one source, not confirming each other. Counting this as two
    // confirmations is the thesis violated: a source you control yourself is not a source.
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'), { sourceId: 'hr-export' })]),
        graph('copy', 'Copy of Work', [st(ALEX, ROLE, lit('Engineer'), { sourceId: 'hr-export' })]),
      ],
      { entities: [ALEX] },
    );
    expect(result.answers[0].agreements[0].independent).toBe(false);
  });

  it('reports no agreement when only one graph asserts the fact', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'))]),
        graph('home', 'Home', [st(ALEX, LABEL, lit('Alex'))]),
      ],
      { entities: [ALEX] },
    );
    expect(result.answers[0].agreements).toEqual([]);
  });
});

describe('disagreement surfaces and is never merged away', () => {
  it('reports both values when two graphs disagree', () => {
    // The most valuable thing a federated query can find: a contradiction no single graph can see.
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'))]),
        graph('home', 'Home', [st(ALEX, ROLE, lit('Volunteer'))]),
      ],
      { entities: [ALEX] },
    );
    const [conflict] = result.answers[0].conflicts;
    expect(conflict.predicate).toBe(ROLE);
    expect(conflict.values.map((v) => v.object).sort()).toEqual(['Engineer', 'Volunteer']);
    // Both survive — no winner was picked.
    expect(result.answers[0].facts).toHaveLength(2);
  });

  it('does NOT call one graph holding two values a conflict', () => {
    // Within one graph that is a dichotomy, frequently legitimate (two email addresses), and
    // dichotomy.ts already owns it. Across graphs it is a contradiction.
    const result = queryGraphs(
      [graph('work', 'Work', [
        st(ALEX, ROLE, lit('Engineer')),
        st(ALEX, ROLE, lit('Mentor')),
      ])],
      { entities: [ALEX] },
    );
    expect(result.answers[0].conflicts).toEqual([]);
  });

  it('counts disagreements in the summary sentence', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, ROLE, lit('Engineer'))]),
        graph('home', 'Home', [st(ALEX, ROLE, lit('Volunteer'))]),
      ],
      { entities: [ALEX] },
    );
    expect(describeMultiGraphResult(result)).toContain('1 disagreement between graphs');
  });

  it('separates agreement from conflict on the same entity', () => {
    const result = queryGraphs(
      [
        graph('work', 'Work', [st(ALEX, LABEL, lit('Alex')), st(ALEX, ROLE, lit('Engineer'))]),
        graph('home', 'Home', [st(ALEX, LABEL, lit('Alex')), st(ALEX, ROLE, lit('Volunteer'))]),
      ],
      { entities: [ALEX] },
    );
    const answer = result.answers[0];
    expect(answer.agreements.map((a) => a.object)).toEqual(['Alex']);
    expect(answer.conflicts.map((c) => c.predicate)).toEqual([ROLE]);
  });
});

describe('bounded, and honest about the bound', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    st(`urn:kbase:concept/e${i}`, LABEL, lit('match me')));

  it('caps the answers and says it did', () => {
    const result = queryGraphs([graph('g', 'G', many)], { text: 'match', limit: 5 });
    expect(result.answers).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(describeMultiGraphResult(result)).toContain('More matched than were returned');
  });

  it('does not claim truncation when everything fitted', () => {
    const result = queryGraphs([graph('g', 'G', many)], { text: 'match', limit: 50 });
    expect(result.truncated).toBe(false);
    expect(describeMultiGraphResult(result)).not.toContain('More matched');
  });
});
