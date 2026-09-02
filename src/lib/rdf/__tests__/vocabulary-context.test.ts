/**
 * Tests for vocabulary grounding (F136).
 *
 * Two properties matter more than the rest and are tested hardest:
 *   1. The generic and one-off predicates never get offered — offering them would teach the model
 *      the exact habits graph-lint spends its time warning about.
 *   2. The section is a PREFERENCE, not a cage. A prompt that enumerates forty predicates and
 *      implies "pick one" would suppress genuinely new relations, and a well-formed absence is the
 *      most valuable node in the graph.
 */

import { describe, it, expect } from 'vitest';
import { selectVocabulary, buildVocabularySection, slugFromIRI } from '../vocabulary-context';
import { iri, lit } from '../types';
import type { Statement } from '../types';

let n = 0;
function stmt(s: string, p: string, o: string, objectIsLiteral = false): Statement {
  return {
    id: `t${n++}`,
    s: iri(`urn:kbase:concept/${s}`),
    p: iri(`urn:kbase:predicate/${p}`),
    o: objectIsLiteral ? lit(o) : iri(`urn:kbase:concept/${o}`),
    g: iri('urn:kbase:source/test'),
    sourceId: 'test',
  } as Statement;
}

/** Repeat a fact `count` times so a predicate clears the min-uses floor. */
function repeated(count: number, s: string, p: string, o: string): Statement[] {
  return Array.from({ length: count }, (_, i) => stmt(`${s}-${i}`, p, `${o}-${i}`));
}

describe('slugFromIRI', () => {
  it('keeps the kebab-case slug the extractor is asked to emit', () => {
    // NOT labelFromIRI's space-separated form — the model is being shown a string to copy.
    expect(slugFromIRI('urn:kbase:predicate/has-heart-count')).toBe('has-heart-count');
  });

  it('handles hash IRIs from standard vocabularies', () => {
    expect(slugFromIRI('http://www.w3.org/2000/01/rdf-schema#label')).toBe('label');
  });
});

describe('selectVocabulary', () => {
  it('offers predicates the graph actually uses', () => {
    const existing = [...repeated(3, 'octopus', 'has-heart-count', 'three')];
    const ctx = selectVocabulary(existing, 'some text');
    expect(ctx.predicates.map((p) => p.slug)).toContain('has-heart-count');
  });

  it('never offers a predicate used only once', () => {
    // 24% of this graph's predicate types are used exactly once (graph-lint). Offering the long
    // tail teaches the model that minting one-offs is the house style.
    const existing = [stmt('a', 'used-once', 'b'), ...repeated(2, 'c', 'used-twice', 'd')];
    const slugs = selectVocabulary(existing, 'text').predicates.map((p) => p.slug);
    expect(slugs).toContain('used-twice');
    expect(slugs).not.toContain('used-once');
  });

  it('never offers the generic relations graph-lint warns about', () => {
    // relates-to alone is 3.2% of the graph. Listing it as vocabulary would hand the model the
    // emptiest edge available and call it guidance.
    const existing = [
      ...repeated(50, 'a', 'relates-to', 'b'),
      ...repeated(2, 'c', 'is-found-in', 'd'),
    ];
    const slugs = selectVocabulary(existing, 'text').predicates.map((p) => p.slug);
    expect(slugs).not.toContain('relates-to');
    expect(slugs).toContain('is-found-in');
  });

  it('never offers standard-vocabulary predicates as "our words"', () => {
    const rdfType: Statement = {
      id: 'x', s: iri('urn:kbase:concept/a'),
      p: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      o: iri('urn:kbase:type/Thing'), g: iri('urn:kbase:source/test'), sourceId: 'test',
    } as Statement;
    const existing = [rdfType, rdfType, ...repeated(2, 'c', 'is-found-in', 'd')];
    const slugs = selectVocabulary(existing, 'text').predicates.map((p) => p.slug);
    expect(slugs).not.toContain('type');
  });

  it('ranks a predicate the source text is about above a commoner irrelevant one', () => {
    const existing = [
      ...repeated(50, 'a', 'has-weight-range', 'b'),
      ...repeated(2, 'c', 'has-heart-count', 'd'),
    ];
    const ctx = selectVocabulary(existing, 'Octopuses have three hearts and a heart count of three.');
    expect(ctx.predicates[0].slug).toBe('has-heart-count');
    expect(ctx.predicates[0].mentioned).toBe(true);
  });

  it('requires EVERY topical word, not merely one of them', () => {
    // "blood" appears and "color" does not. A one-word hit is not evidence the text is about this
    // relation — `has-blood-color` and `has-blood-protein` share a word and mean different things,
    // which is exactly the confusion the predicate benchmark measured.
    const existing = [...repeated(2, 'a', 'has-blood-color', 'b')];
    const ctx = selectVocabulary(existing, 'Their blood carries oxygen through the gills.');
    expect(ctx.predicates[0].mentioned).toBe(false);
  });

  it('a shared structural word alone is never relevance', () => {
    const existing = [...repeated(2, 'a', 'has-blood-color', 'b')];
    const ctx = selectVocabulary(existing, 'The creature has three hearts.');
    expect(ctx.predicates[0].mentioned).toBe(false);
  });

  it('ignores structural slug words, which prose states differently anyway', () => {
    // Found by a failing test: "have three hearts and a heart count" never contains the bare token
    // "has", so requiring it matched nothing and relevance ranking silently never fired.
    const existing = [...repeated(2, 'a', 'has-heart-count', 'b')];
    const ctx = selectVocabulary(existing, 'Octopuses have three hearts; the heart count is three.');
    expect(ctx.predicates[0].mentioned).toBe(true);
  });

  it('a slug made only of structural words can never be "mentioned"', () => {
    const existing = [...repeated(2, 'a', 'has-the', 'b')];
    expect(selectVocabulary(existing, 'has the has the').predicates[0].mentioned).toBe(false);
  });

  it('orders deterministically, so the prompt prefix is cacheable', () => {
    // An unstable list would change the prompt on every call for no reason and defeat caching.
    const existing = [
      ...repeated(2, 'a', 'zebra-relation', 'b'),
      ...repeated(2, 'c', 'alpha-relation', 'd'),
    ];
    const first = selectVocabulary(existing, 'text').predicates.map((p) => p.slug);
    const second = selectVocabulary([...existing].reverse(), 'text').predicates.map((p) => p.slug);
    expect(first).toEqual(second);
    expect(first).toEqual(['alpha-relation', 'zebra-relation']);
  });

  it('reports truncation honestly so the prompt can call the list a sample', () => {
    const existing = Array.from({ length: 60 }, (_, i) => repeated(2, `s${i}`, `pred-${i}`, `o${i}`)).flat();
    const ctx = selectVocabulary(existing, 'text', { predicateBudget: 10 });
    expect(ctx.predicates).toHaveLength(10);
    expect(ctx.truncated).toBe(true);
    expect(ctx.totalPredicates).toBe(60);
  });

  it('does not claim truncation when everything fitted', () => {
    const ctx = selectVocabulary(repeated(2, 'a', 'only-one', 'b'), 'text', { predicateBudget: 10 });
    expect(ctx.truncated).toBe(false);
  });

  it('offers entities from object position too, not just subjects', () => {
    // A thing referred to only as an object is still a thing a new fact should reuse.
    const ctx = selectVocabulary([stmt('octopus-0', 'feeds-on', 'crab')], 'text');
    expect(ctx.entities.map((e) => e.slug)).toContain('crab');
  });

  it('does not offer literals as entities', () => {
    const ctx = selectVocabulary([stmt('octopus', 'has-weight', '5kg', true)], 'text');
    expect(ctx.entities.map((e) => e.slug)).not.toContain('5kg');
  });

  it('an empty graph yields nothing to say', () => {
    const ctx = selectVocabulary([], 'text');
    expect(ctx.predicates).toHaveLength(0);
    expect(ctx.entities).toHaveLength(0);
  });
});

describe('buildVocabularySection', () => {
  const graph = [
    ...repeated(3, 'octopus', 'has-heart-count', 'three'),
    ...repeated(2, 'octopus', 'is-found-in', 'sea'),
  ];

  it('names the exact slug the model should copy', () => {
    const section = buildVocabularySection(selectVocabulary(graph, 'hearts and heart count'));
    expect(section).toContain('has-heart-count');
    expect(section).not.toContain('has heart count');
  });

  it('IS NOT A CAGE — it explicitly permits minting a new predicate', () => {
    // The load-bearing property. A closed list would suppress genuinely new relations, and the
    // shape of what is missing is the thing this product exists to hold.
    const section = buildVocabularySection(selectVocabulary(graph, 'text'));
    expect(section).toMatch(/mint a new predicate/i);
    expect(section).toMatch(/if none of them fits/i);
  });

  it('forbids forcing a fact into a listed predicate that does not fit', () => {
    // Without this, a list of plausible predicates is an invitation to jam every fact into one.
    const section = buildVocabularySection(selectVocabulary(graph, 'text'));
    expect(section).toMatch(/do not force/i);
  });

  it('says the list is a sample when it was truncated', () => {
    const many = Array.from({ length: 60 }, (_, i) => repeated(2, `s${i}`, `pred-${i}`, `o${i}`)).flat();
    const section = buildVocabularySection(selectVocabulary(many, 'text', { predicateBudget: 5 }));
    expect(section).toContain('5 of 60');
  });

  it('costs an empty graph nothing at all', () => {
    // A first ingest must read exactly as it did before this feature existed.
    expect(buildVocabularySection(selectVocabulary([], 'text'))).toBe('');
  });
});
