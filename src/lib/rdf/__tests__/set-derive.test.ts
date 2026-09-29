/**
 * Set derivation — the deterministic arm.
 *
 * What these guard is mostly the REFUSALS. Finding a grouping is easy and a rule that finds
 * everything is worthless: the bench's best set-forming model fell into the "this is not a group"
 * trap 5 times out of 5, and the two models that never fell into it never formed a set either.
 * So the tests that matter are the ones asserting this rule declines.
 */
import { describe, it, expect } from 'vitest';
import { deriveSets, derivedSetStatements, derivedSetLabel, MIN_MEMBERS } from '../set-derive';
import { readSets, COLLECTION, MEMBER_PREDICATE } from '../sets';
import type { Statement } from '../types';

const G = { id: 'src-1', graph: 'urn:kbase:source/src-1' };
const C = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';

function st(s: string, p: string, o: string, over: Partial<Statement> = {}): Statement {
  return {
    id: `${s}|${p}|${o}`,
    s: { kind: 'iri', value: s.startsWith('urn:') ? s : C + s },
    p: { kind: 'iri', value: p.startsWith('urn:') || p.startsWith('http') ? p : P + p },
    o: { kind: 'iri', value: o.startsWith('urn:') || o.startsWith('http') ? o : C + o },
    g: { kind: 'iri', value: G.graph },
    sourceId: G.id,
    confidence: 0.9,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const shortlist = [
  st('dam-shortlist', 'includes', 'aprimo'),
  st('dam-shortlist', 'includes', 'opentext'),
  st('dam-shortlist', 'includes', 'bynder'),
];

describe('deriveSets — what it finds', () => {
  it('finds a grouping already stated under the graph own word', () => {
    const { derived } = deriveSets(shortlist);
    expect(derived).toHaveLength(1);
    expect(derived[0].iri).toBe(`${C}dam-shortlist`);
    expect(derived[0].via).toBe(`${P}includes`);
    expect(derived[0].members).toHaveLength(3);
  });

  it('ranks the biggest grouping first — that is where a reviewer attention is worth most', () => {
    const { derived } = deriveSets([
      ...shortlist,
      st('deployed', 'runs', 'a'), st('deployed', 'runs', 'b'),
      st('deployed', 'runs', 'c'), st('deployed', 'runs', 'd'),
    ]);
    expect(derived.map((d) => d.members.length)).toEqual([4, 3]);
  });

  /* The capability skos:Collection was CHOSEN for, and the one no model managed in 20 bench runs. */
  it('allows one entity to be a member of two sets', () => {
    const { derived } = deriveSets([
      ...shortlist,
      st('deployed', 'runs', 'opentext'), st('deployed', 'runs', 'vantage'), st('deployed', 'runs', 'legacy'),
    ]);
    const holding = derived.filter((d) => d.members.includes(`${C}opentext`));
    expect(holding).toHaveLength(2);
  });
});

describe('deriveSets — what it refuses, which is the point', () => {
  it(`refuses below ${MIN_MEMBERS} members — two facts sharing a predicate is how predicates work`, () => {
    const { derived, whyNot } = deriveSets(shortlist.slice(0, 2));
    expect(derived).toHaveLength(0);
    // Not even a near miss: it is ordinary, so it is not reported as a refusal either.
    expect(whyNot).toHaveLength(0);
  });

  it('refuses an ACCUMULATING predicate — a feature with many files is not a set of files', () => {
    const { derived, whyNot } = deriveSets([
      st('f187', 'has-file', 'sets-ts'), st('f187', 'has-file', 'set-derive-ts'), st('f187', 'has-file', 'set-score-ts'),
    ]);
    expect(derived).toHaveLength(0);
    expect(whyNot[0].reason).toMatch(/accumulating/);
  });

  it('refuses a STRUCTURAL predicate — rdf:type describes the graph, not the world', () => {
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const { derived, whyNot } = deriveSets([
      st('thing', RDF_TYPE, 'a'), st('thing', RDF_TYPE, 'b'), st('thing', RDF_TYPE, 'c'),
    ]);
    expect(derived).toHaveLength(0);
    expect(whyNot[0].reason).toMatch(/structural/);
  });

  it('refuses literal objects — a set of strings is an attribute with repetition', () => {
    const literals = ['x', 'y', 'z'].map((v, i) => ({
      ...st('thing', 'note', 'placeholder'),
      id: `lit-${i}`,
      o: { kind: 'literal' as const, value: v },
    }));
    expect(deriveSets(literals).derived).toHaveLength(0);
  });

  it('refuses to re-propose a set a reviewer already accepted', () => {
    const { derived, whyNot } = deriveSets(shortlist, new Set([`${C}dam-shortlist`]));
    expect(derived).toHaveLength(0);
    expect(whyNot[0].reason).toBe('already a set');
  });

  it('ignores rejected statements and open questions', () => {
    const withHoles = [
      shortlist[0],
      { ...shortlist[1], status: 'rejected' as const },
      { ...shortlist[2], needsObject: true },
    ];
    expect(deriveSets(withHoles).derived).toHaveLength(0);
  });

  it('counts DISTINCT members — the same fact stated twice is not two members', () => {
    const { derived } = deriveSets([shortlist[0], shortlist[1], { ...shortlist[1], id: 'dup' }]);
    expect(derived).toHaveLength(0);
  });
});

describe('derivedSetStatements', () => {
  it('proposes TWO statements regardless of member count — never N', () => {
    const { derived } = deriveSets([
      ...shortlist, st('dam-shortlist', 'includes', 'd'), st('dam-shortlist', 'includes', 'e'),
    ]);
    const proposed = derivedSetStatements(derived[0], G);
    expect(proposed).toHaveLength(2);
    expect(proposed.every((p) => p.status === 'pending')).toBe(true);
  });

  it('the proposal makes the grouping READABLE as a set once accepted', () => {
    const { derived } = deriveSets(shortlist);
    const all = [...shortlist, ...derivedSetStatements(derived[0], G)];
    const quads = all.map((s) => ({
      subject: { value: s.s.value },
      predicate: { value: s.p.value },
      object: { value: s.o.value, termType: s.o.kind === 'literal' ? 'Literal' : 'NamedNode' },
    }));
    const [set] = readSets(quads);
    expect(set.iri).toBe(`${C}dam-shortlist`);
    expect(set.members.map((m) => m.iri).sort()).toEqual([`${C}aprimo`, `${C}bynder`, `${C}opentext`]);
    // And it records that the grouping was already there under the author's own word.
    expect(set.memberPredicates).toEqual([`${P}includes`]);
  });

  it('states the type and the carrying predicate, and nothing else', () => {
    const { derived } = deriveSets(shortlist);
    const [type, via] = derivedSetStatements(derived[0], G);
    expect(type.o.value).toBe(COLLECTION);
    expect(via.p.value).toBe(MEMBER_PREDICATE);
    expect(via.o.value).toBe(`${P}includes`);
  });

  it('a label is a SEPARATE proposal — it invents a string where the others do not', () => {
    const { derived } = deriveSets(shortlist);
    expect(derivedSetLabel(derived[0], G).o.value).toBe('Dam shortlist');
  });
});

/*
 * LAYER AWARENESS — the refusal that the first real-graph run taught.
 *
 * Derivation was run over reckons-workspace/kbs/personal-notes before these existed and proposed
 * four sets, all wrong; three grouped by `kpred:extracted-from`. "This note was extracted from
 * those four notes" records where text came from — it is not a claim that four things are members
 * of anything. 0% precision, and the fix was one classification rather than one more exclusion.
 */
describe('deriveSets — provenance cannot carry membership', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  it('refuses a predicate that is provenance BY CONSTRUCTION, with no vocabulary loaded', () => {
    const { derived, whyNot } = deriveSets([
      st('note-a', 'extracted-from', 'note-1'),
      st('note-a', 'extracted-from', 'note-2'),
      st('note-a', 'extracted-from', 'note-3'),
    ]);
    expect(derived).toHaveLength(0);
    expect(whyNot[0].reason).toMatch(/provenance/);
  });

  it('refuses a predicate the GRAPH declares as provenance', () => {
    const declared: Statement[] = [
      st(`${P}came-via`, 'layer', 'urn:kbase:type/layer/provenance'),
      st('thing', 'came-via', 'a'), st('thing', 'came-via', 'b'), st('thing', 'came-via', 'c'),
    ];
    const { derived, whyNot } = deriveSets(declared);
    expect(derived).toHaveLength(0);
    expect(whyNot.some((w) => w.reason.match(/provenance/))).toBe(true);
  });

  it('accepts a declaration passed in from another graph — the vocabulary lives elsewhere', () => {
    const facts = [st('thing', 'came-via', 'a'), st('thing', 'came-via', 'b'), st('thing', 'came-via', 'c')];
    expect(deriveSets(facts).derived).toHaveLength(1);
    expect(deriveSets(facts, new Set(), new Set([`${P}came-via`])).derived).toHaveLength(0);
  });

  /*
   * The fail-safe, and it points the safe way: an UNCLASSIFIED predicate stays a claim, so a new
   * predicate is eligible for grouping rather than silently excluded. A rule that excluded by
   * default would go quiet as the vocabulary grew, and silence reads as "there is nothing here".
   */
  it('an unclassified predicate is still eligible — unclassified means claim', () => {
    const { derived } = deriveSets([
      st('roster', 'has-crew', 'a'), st('roster', 'has-crew', 'b'), st('roster', 'has-crew', 'c'),
    ]);
    expect(derived).toHaveLength(1);
  });

  it('refuses presentational namespaces — story highlights describe the view, not the world', () => {
    const { derived } = deriveSets([
      st('step-2', 'urn:reckons:story/highlight', 'a'),
      st('step-2', 'urn:reckons:story/highlight', 'b'),
      st('step-2', 'urn:reckons:story/highlight', 'c'),
    ]);
    expect(derived).toHaveLength(0);
  });
});
