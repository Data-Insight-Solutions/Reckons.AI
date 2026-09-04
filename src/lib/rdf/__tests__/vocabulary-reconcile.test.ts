/**
 * DEFERRED GROUNDING — the tests that keep it from becoming the thing it replaces.
 *
 * normalize-entities.ts rewrites incoming IRIs onto existing ones "before the user ever sees them".
 * This module exists because that is a silent write, so the assertions that matter most here are
 * the ones about what it REFUSES to do: never merge on a weak signal, never touch the suggest band,
 * never quietly turn a genuinely new thing into an old one.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileVocabulary,
  scoreNames,
  normalizeName,
  normalizePredicateName,
  slugOf,
} from '../vocabulary-reconcile';
import { MERGE_AUTO_THRESHOLD, MERGE_SUGGEST_FLOOR } from '../merge-band';
import type { Statement } from '../types';

const C = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';

let seq = 0;
/** A bare slug gets the project prefix; anything already absolute is left exactly as given. */
const abs = (v: string) => /^[a-z][a-z0-9+.-]*:/i.test(v);
const st = (s: string, p: string, o: string, oIsLiteral = false): Statement =>
  ({
    id: `t${seq++}`,
    s: { kind: 'iri', value: abs(s) ? s : C + s },
    p: { kind: 'iri', value: abs(p) ? p : P + p },
    o: oIsLiteral ? { kind: 'literal', value: o } : { kind: 'iri', value: abs(o) ? o : C + o },
    g: { kind: 'iri', value: 'urn:kbase:source/x' },
    sourceId: 'x',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  }) as Statement;

describe('name normalization', () => {
  it('folds case, punctuation and plurals', () => {
    expect(normalizeName('Enterprise CAD Platforms')).toBe(normalizeName('enterprise-cad-platform'));
  });

  it('sheds copula prefixes on predicates only', () => {
    expect(normalizePredicateName('is-used-by')).toBe(normalizePredicateName('used-by'));
    expect(normalizePredicateName('has-interoperability-with')).toBe(normalizePredicateName('interoperability-with'));
    expect(normalizeName('is-used-by')).toBe('is-used-by');
  });

  it('reads the trailing segment as the name', () => {
    expect(slugOf('urn:kbase:concept/lumenpath')).toBe('lumenpath');
    expect(slugOf('http://example.org/ns#thing')).toBe('thing');
  });
});

describe('scoreNames — it must refuse more than it accepts', () => {
  it('scores a morphological variant into the AUTO band', () => {
    const r = scoreNames('is-used-by', 'used-by', 'predicate');
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeGreaterThanOrEqual(MERGE_AUTO_THRESHOLD);
  });

  it('scores a mis-hearing into SUGGEST, never auto', () => {
    // "lumen path" -> "Lumenpath" is a probable transcription error, not a certainty. Applying it
    // silently would rename an entity on a guess.
    const r = scoreNames('lumen-path', 'lumenpath', 'entity');
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeGreaterThanOrEqual(MERGE_SUGGEST_FLOOR);
    expect(r!.similarity).toBeLessThan(MERGE_AUTO_THRESHOLD);
  });

  it('REFUSES two short words that differ by one letter', () => {
    // `cad` vs `dam` — and more importantly the corpus's own trap, where a homophone must NOT be
    // resolved by spelling distance. The length gate is what prevents it.
    expect(scoreNames('cad', 'dam', 'entity')).toBeNull();
    expect(scoreNames('cat', 'cad', 'entity')).toBeNull();
  });

  it('REFUSES two unrelated names', () => {
    expect(scoreNames('lumenpath', 'vantage-suite', 'entity')).toBeNull();
    expect(scoreNames('owns', 'competes-with', 'predicate')).toBeNull();
  });

  it('proposes nothing when the strings are already identical', () => {
    expect(scoreNames('lumenpath', 'lumenpath', 'entity')).toBeNull();
  });
});

describe('reconcileVocabulary', () => {
  const existing = [
    st('lumenpath', 'used-by', 'architecture-studio'),
    st('northwind-analytics', 'is-a', 'systems-integrator'),
  ];

  it('APPLIES an auto-band predicate match, connecting the new fact to the graph vocabulary', () => {
    const incoming = [st('vantage-suite', 'is-used-by', 'engineering-team')];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].kind).toBe('predicate');
    expect(r.statements[0].p.value).toBe(`${P}used-by`);
  });

  it('DOES NOT APPLY a suggest-band match — it proposes it', () => {
    const incoming = [st('lumen-path', 'owns', 'thing')];
    const r = reconcileVocabulary(incoming, existing);
    const sug = r.suggested.find((x) => x.from.endsWith('lumen-path'));
    expect(sug).toBeDefined();
    expect(sug!.verdict).toBe('suggest');
    // The statement is untouched: the human decides.
    expect(r.statements[0].s.value).toBe(`${C}lumen-path`);
  });

  it('leaves a genuinely new entity alone and reports it as new', () => {
    // A well-formed new thing is the most valuable node in the graph (kb:mission). Grounding that
    // talked it into an existing entity would be the cage structural-context.ts warns about.
    const incoming = [st('quarry-systems', 'owns', 'thing')];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.applied).toHaveLength(0);
    expect(r.unmatched.some((u) => u.endsWith('quarry-systems'))).toBe(true);
    expect(r.statements[0].s.value).toBe(`${C}quarry-systems`);
  });

  it('is a no-op against an empty graph, which is the first-ingest case', () => {
    const incoming = [st('a', 'p', 'b')];
    const r = reconcileVocabulary(incoming, []);
    expect(r.statements).toBe(incoming);
    expect(r.applied).toHaveLength(0);
  });

  it('does NOT disable itself on a large graph — the defect that made this module necessary', () => {
    // normalize-entities returns unchanged above 500 entities with only a console.info, so on a
    // mature graph the only connection mechanism silently does nothing.
    const big: Statement[] = [];
    for (let i = 0; i < 900; i++) big.push(st(`entity-${i}`, 'used-by', `other-${i}`));
    const r = reconcileVocabulary([st('vantage-suite', 'is-used-by', 'team')], big);
    expect(r.applied.length + r.suggested.length).toBeGreaterThan(0);
  });

  it('never touches protected vocabularies', () => {
    const incoming = [st('a', 'http://www.w3.org/2000/01/rdf-schema#label', 'x', true)];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.applied.every((p) => !p.from.includes('rdf-schema'))).toBe(true);
    expect(r.statements[0].p.value).toBe('http://www.w3.org/2000/01/rdf-schema#label');
  });

  it('rewrites objects as well as subjects, so both ends of an edge connect', () => {
    const incoming = [st('thing', 'owns', 'northwind-analytic')];
    const r = reconcileVocabulary(incoming, existing);
    // "northwind-analytic" ~ "northwind-analytics" is a plural fold: same word, auto band.
    expect(r.statements[0].o.value).toBe(`${C}northwind-analytics`);
  });

  it('preserves statement identity when nothing changes', () => {
    const incoming = [st('brand-new', 'totally-different', 'also-new')];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.statements[0]).toBe(incoming[0]);
  });
});

describe('one decision per name, not per occurrence', () => {
  const existing = [st('lumenpath', 'used-by', 'architecture-studio')];

  it('proposes a repeated name ONCE', () => {
    // The first live run emitted "lumenpath ~ lumen-path" three times from one note, because the
    // name appeared in three triples. Five identical rows is how a reviewer learns to stop reading.
    const incoming = [
      st('lumen-path', 'owns', 'a'),
      st('lumen-path', 'owns', 'b'),
      st('lumen-path', 'owns', 'c'),
    ];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.suggested.filter((p) => p.from.endsWith('lumen-path'))).toHaveLength(1);
  });

  it('still rewrites EVERY occurrence when the decision is auto', () => {
    // Deduplicating the DECISION must not deduplicate the APPLICATION.
    const incoming = [st('a', 'is-used-by', 'b'), st('c', 'is-used-by', 'd')];
    const r = reconcileVocabulary(incoming, existing);
    expect(r.applied).toHaveLength(1);
    expect(r.statements.every((x) => x.p.value === `${P}used-by`)).toBe(true);
  });
});

describe('within-batch twins — two mis-hearings of one name in the SAME note', () => {
  it('proposes a link between two variants that both arrive together', () => {
    // "A primo and binder" — the decoder split "Aprimo and Bynder" before extraction saw it, so
    // both variants are INCOMING and neither is in the graph. Comparing only against the existing
    // graph missed 6 of 8 twins the chain harness found on the review corpus.
    const r = reconcileVocabulary([st('aprimo', 'is-a', 'vendor'), st('primo', 'is-a', 'vendor')], [
      st('lumenpath', 'used-by', 'studio'),
    ]);
    expect(r.applied.length + r.suggested.length).toBeGreaterThan(0);
  });

  it('prefers an EXISTING graph name over a batch sibling', () => {
    // The existing name has already been reviewed; a name that arrived a moment ago has not.
    const existing = [st('lumenpath', 'used-by', 'studio')];
    const r = reconcileVocabulary([st('lumen-path', 'owns', 'a'), st('lumenpaths', 'owns', 'b')], existing);
    const forLumenPath = r.suggested.concat(r.applied).find((p) => p.from.endsWith('lumen-path'));
    expect(forLumenPath?.to).toBe(`${C}lumenpath`);
  });

  it('does not propose a name against itself', () => {
    const r = reconcileVocabulary([st('acme', 'p', 'b'), st('acme', 'q', 'c')], [st('x', 'y', 'z')]);
    expect(r.applied.concat(r.suggested).every((p) => p.from !== p.to)).toBe(true);
  });
});

describe('the two damage signatures the review corpus actually produced', () => {
  it('catches a dropped leading syllable: primo ~ aprimo', () => {
    const r = scoreNames('primo', 'aprimo', 'entity');
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeLessThan(MERGE_AUTO_THRESHOLD); // suggest, never silent
  });

  it('catches a one-letter mis-hearing at six characters: binder ~ bynder', () => {
    const r = scoreNames('binder', 'bynder', 'entity');
    expect(r).not.toBeNull();
    expect(r!.similarity).toBeLessThan(MERGE_AUTO_THRESHOLD);
  });

  it('STILL refuses the short-word cases the length gate exists for', () => {
    expect(scoreNames('cad', 'dam', 'entity')).toBeNull();
    expect(scoreNames('cat', 'cad', 'entity')).toBeNull();
    // Five letters, one edit — real English words that are not each other.
    expect(scoreNames('owned', 'owner', 'entity')).toBeNull();
  });

  it('does not let containment fire on a short word inside a long one', () => {
    expect(scoreNames('cad', 'decade', 'entity')).toBeNull();
    expect(scoreNames('use', 'warehouse', 'entity')).toBeNull();
  });
});
