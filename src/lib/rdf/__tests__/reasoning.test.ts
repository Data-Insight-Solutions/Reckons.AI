import { describe, it, expect } from 'vitest';
import { closure, merge, splitByConcept } from '../reasoning';
import type { Statement } from '../types';
import { iri, lit } from '../types';
import { v4 as uuid } from 'uuid';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function stmt(overrides: Partial<Statement> & Pick<Statement, 's' | 'p' | 'o'>): Statement {
  return {
    id: uuid(),
    g: iri('urn:test:graph'),
    sourceId: 'test-source',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// Common IRIs
const ALICE     = iri('urn:test:alice');
const BOB       = iri('urn:test:bob');
const CAROL     = iri('urn:test:carol');
const DAVE      = iri('urn:test:dave');

const MAMMAL    = iri('urn:test:Mammal');
const ANIMAL    = iri('urn:test:Animal');
const ORGANISM  = iri('urn:test:Organism');
const DOG       = iri('urn:test:Dog');

const KNOWS     = iri('urn:test:knows');
const LIKES     = iri('urn:test:likes');
const FOLLOWS   = iri('urn:test:follows');

// RDF/RDFS/OWL vocabulary IRIs
const RDF_TYPE      = iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const RDFS_SUBCLASS = iri('http://www.w3.org/2000/01/rdf-schema#subClassOf');
const RDFS_SUBPROP  = iri('http://www.w3.org/2000/01/rdf-schema#subPropertyOf');
const OWL_INVERSE   = iri('http://www.w3.org/2002/07/owl#inverseOf');

// ── closure() ─────────────────────────────────────────────────────────────────

describe('closure — no schema triples present', () => {
  it('returns the original statements unchanged when there are no schema triples', () => {
    const facts = [
      stmt({ s: ALICE, p: KNOWS, o: BOB }),
      stmt({ s: BOB,   p: KNOWS, o: CAROL }),
    ];
    const result = closure(facts);
    // No subClassOf/subPropertyOf/inverseOf — nothing to infer; original facts still present
    const ids = new Set(result.map(s => s.id));
    for (const f of facts) expect(ids.has(f.id)).toBe(true);
    // No additional statements inferred
    expect(result.length).toBe(facts.length);
  });

  it('returns all statements when no entailments fire', () => {
    const facts = [
      stmt({ s: ALICE, p: KNOWS,   o: BOB }),
      stmt({ s: BOB,   p: LIKES,   o: CAROL }),
      stmt({ s: CAROL, p: FOLLOWS, o: DAVE }),
    ];
    expect(closure(facts).length).toBe(3);
  });
});

describe('closure — rejected and superseded statements are skipped', () => {
  it('does not include a rejected statement in the closed set', () => {
    const rejected = stmt({ s: ALICE, p: KNOWS, o: BOB, status: 'rejected' });
    const result = closure([rejected]);
    // rejected statements are excluded
    expect(result.find(s => s.id === rejected.id)).toBeUndefined();
  });

  it('does not include a superseded statement in the closed set', () => {
    const superseded = stmt({ s: ALICE, p: KNOWS, o: BOB, status: 'superseded' });
    const result = closure([superseded]);
    expect(result.find(s => s.id === superseded.id)).toBeUndefined();
  });

  it('still processes confirmed statements alongside rejected ones', () => {
    const confirmed  = stmt({ s: ALICE, p: KNOWS, o: BOB, status: 'confirmed' });
    const rejected   = stmt({ s: ALICE, p: LIKES, o: BOB, status: 'rejected' });
    const result = closure([confirmed, rejected]);
    expect(result.find(s => s.id === confirmed.id)).toBeDefined();
    expect(result.find(s => s.id === rejected.id)).toBeUndefined();
  });
});

describe('closure — rdfs9: subClassOf materializes rdf:type', () => {
  it('infers (?x rdf:type ?b) from (?x rdf:type ?a) + (?a subClassOf ?b)', () => {
    const typeFact = stmt({ s: ALICE, p: RDF_TYPE, o: MAMMAL });
    const subClass  = stmt({ s: MAMMAL, p: RDFS_SUBCLASS, o: ANIMAL });
    const result = closure([typeFact, subClass]);

    // The inferred triple: ALICE rdf:type ANIMAL
    const inferred = result.find(
      s => s.s.value === ALICE.value &&
           s.p.value === RDF_TYPE.value &&
           s.o.kind === 'iri' && s.o.value === ANIMAL.value
    );
    expect(inferred).toBeDefined();
    expect(inferred!.g.value).toBe('urn:kbase:graph/inferred');
  });

  it('does not infer when the type object does not match the subClassOf subject', () => {
    const typeFact = stmt({ s: ALICE, p: RDF_TYPE, o: DOG });
    const subClass  = stmt({ s: MAMMAL, p: RDFS_SUBCLASS, o: ANIMAL }); // DOG is not MAMMAL
    const result = closure([typeFact, subClass]);

    const inferred = result.find(
      s => s.p.value === RDF_TYPE.value && s.o.kind === 'iri' && s.o.value === ANIMAL.value
    );
    expect(inferred).toBeUndefined();
  });
});

describe('closure — rdfs7: subPropertyOf materializes new predicate', () => {
  it('infers (?x ?q ?y) from (?x ?p ?y) + (?p subPropertyOf ?q)', () => {
    const fact    = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const subProp = stmt({ s: KNOWS, p: RDFS_SUBPROP, o: FOLLOWS });
    const result = closure([fact, subProp]);

    const inferred = result.find(
      s => s.s.value === ALICE.value &&
           s.p.value === FOLLOWS.value &&
           s.o.kind === 'iri' && s.o.value === BOB.value
    );
    expect(inferred).toBeDefined();
    expect(inferred!.g.value).toBe('urn:kbase:graph/inferred');
  });

  it('preserves the original statement alongside the inferred one', () => {
    const fact    = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const subProp = stmt({ s: KNOWS, p: RDFS_SUBPROP, o: FOLLOWS });
    const result = closure([fact, subProp]);

    // Original must still be present
    expect(result.find(s => s.id === fact.id)).toBeDefined();
  });
});

describe('closure — owl:inverseOf materializes inverse triple', () => {
  it('infers (?y ?q ?x) from (?x ?p ?y) when (?p inverseOf ?q)', () => {
    const KNOWS_BY = iri('urn:test:knownBy');
    const fact    = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const inverse = stmt({ s: KNOWS, p: OWL_INVERSE, o: KNOWS_BY });
    const result = closure([fact, inverse]);

    // Inverse: BOB knownBy ALICE
    const inferred = result.find(
      s => s.s.kind === 'iri' && s.s.value === BOB.value &&
           s.p.value === KNOWS_BY.value &&
           s.o.kind === 'iri' && s.o.value === ALICE.value
    );
    expect(inferred).toBeDefined();
    expect(inferred!.g.value).toBe('urn:kbase:graph/inferred');
  });

  it('does not infer inverse when predicate does not match', () => {
    const KNOWS_BY = iri('urn:test:knownBy');
    const fact    = stmt({ s: ALICE, p: LIKES, o: BOB }); // LIKES, not KNOWS
    const inverse = stmt({ s: KNOWS, p: OWL_INVERSE, o: KNOWS_BY });
    const result = closure([fact, inverse]);

    const bogus = result.find(s => s.p.value === KNOWS_BY.value);
    expect(bogus).toBeUndefined();
  });
});

describe('closure — transitive subClassOf chain', () => {
  it('follows a two-hop chain: Dog → Mammal → Animal → Organism', () => {
    const dogIsMammal    = stmt({ s: DOG,    p: RDFS_SUBCLASS, o: MAMMAL   });
    const mammalIsAnimal = stmt({ s: MAMMAL, p: RDFS_SUBCLASS, o: ANIMAL   });
    const animalIsOrg    = stmt({ s: ANIMAL, p: RDFS_SUBCLASS, o: ORGANISM });
    const aliceIsDog     = stmt({ s: ALICE,  p: RDF_TYPE,      o: DOG      });

    const result = closure([dogIsMammal, mammalIsAnimal, animalIsOrg, aliceIsDog]);

    const check = (target: typeof MAMMAL) =>
      result.some(
        s => s.s.value === ALICE.value &&
             s.p.value === RDF_TYPE.value &&
             s.o.kind === 'iri' && s.o.value === target.value
      );

    expect(check(MAMMAL)).toBe(true);
    expect(check(ANIMAL)).toBe(true);
    expect(check(ORGANISM)).toBe(true);
  });
});

// ── merge() ───────────────────────────────────────────────────────────────────

describe('merge — identical KBs', () => {
  it('collapses exact duplicate triples', () => {
    const s1 = stmt({ s: ALICE, p: KNOWS, o: BOB });
    // s2 has same (s,p,o) — tripleKey matches — so it's a duplicate
    const s2 = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const report = merge([s1], [s2]);
    expect(report.collapsedDuplicates).toBe(1);
    expect(report.merged.length).toBe(1);
  });

  it('bumps confidence of the surviving duplicate', () => {
    const s1 = stmt({ s: ALICE, p: KNOWS, o: BOB, confidence: 0.8 });
    const s2 = stmt({ s: ALICE, p: KNOWS, o: BOB, confidence: 0.8 });
    const report = merge([s1], [s2]);
    expect(report.merged[0].confidence).toBeGreaterThan(0.8);
  });

  it('keeps the higher-confidence statement', () => {
    const low  = stmt({ s: ALICE, p: KNOWS, o: BOB, confidence: 0.5 });
    const high = stmt({ s: ALICE, p: KNOWS, o: BOB, confidence: 0.9 });
    const report = merge([low], [high]);
    // The surviving statement should have confidence >= 0.9 (bumped from the higher one)
    expect(report.merged[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('reports zero conflicts when KBs are identical', () => {
    const s1 = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const s2 = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const report = merge([s1], [s2]);
    expect(report.conflicts).toHaveLength(0);
  });
});

describe('merge — disjoint KBs', () => {
  it('concatenates all statements when the KBs share nothing', () => {
    const kbA = [
      stmt({ s: ALICE, p: KNOWS,   o: BOB }),
      stmt({ s: ALICE, p: LIKES,   o: CAROL }),
    ];
    const kbB = [
      stmt({ s: DAVE,  p: FOLLOWS, o: ALICE }),
    ];
    const report = merge(kbA, kbB);
    expect(report.merged.length).toBe(3);
    expect(report.collapsedDuplicates).toBe(0);
  });

  it('reports zero conflicts for disjoint KBs', () => {
    const kbA = [stmt({ s: ALICE, p: KNOWS,   o: BOB   })];
    const kbB = [stmt({ s: DAVE,  p: FOLLOWS, o: CAROL })];
    const report = merge(kbA, kbB);
    expect(report.conflicts).toHaveLength(0);
  });
});

describe('merge — conflicting (s,p) with different objects', () => {
  it('reports a conflict when two KBs disagree on the object for the same (s,p)', () => {
    const kbA = [stmt({ s: ALICE, p: KNOWS, o: BOB   })];
    const kbB = [stmt({ s: ALICE, p: KNOWS, o: CAROL })];
    const report = merge(kbA, kbB);
    expect(report.conflicts.length).toBeGreaterThan(0);
    const conflict = report.conflicts[0];
    expect(conflict.reason).toMatch(/distinct objects/i);
  });

  it('both conflicting statements are represented in the conflict entry', () => {
    const stA = stmt({ s: ALICE, p: KNOWS, o: BOB   });
    const stB = stmt({ s: ALICE, p: KNOWS, o: CAROL });
    const report = merge([stA], [stB]);
    const objects = [
      report.conflicts[0].a.o,
      report.conflicts[0].b.o,
    ].map(o => (o.kind === 'iri' ? o.value : ''));
    expect(objects).toContain(BOB.value);
    expect(objects).toContain(CAROL.value);
  });

  it('does not report a conflict when objects are identical', () => {
    const stA = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const stB = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const report = merge([stA], [stB]);
    expect(report.conflicts).toHaveLength(0);
  });
});

describe('merge — added count', () => {
  it('added reflects statements in merged that were not in kb A', () => {
    const kbA = [stmt({ s: ALICE, p: KNOWS,   o: BOB   })];
    const kbB = [stmt({ s: DAVE,  p: FOLLOWS, o: CAROL })];
    const report = merge(kbA, kbB);
    // merged has 2 total; kbA had 1; added = 2 - 1 = 1
    expect(report.added).toBe(1);
  });
});

// ── splitByConcept() ──────────────────────────────────────────────────────────

describe('splitByConcept — connected component extraction', () => {
  it('extracts statements directly connected to the seed', () => {
    const aliceKnowsBob   = stmt({ s: ALICE, p: KNOWS,   o: BOB   });
    const aliceLikesCarol = stmt({ s: ALICE, p: LIKES,   o: CAROL });
    const daveFollowsDave = stmt({ s: DAVE,  p: FOLLOWS, o: DAVE  });

    const result = splitByConcept(
      [aliceKnowsBob, aliceLikesCarol, daveFollowsDave],
      [ALICE.value]
    );

    // ALICE is seed — ALICE knows BOB + ALICE likes CAROL both included
    expect(result).toContain(aliceKnowsBob);
    expect(result).toContain(aliceLikesCarol);
    // DAVE is isolated from ALICE's component
    expect(result).not.toContain(daveFollowsDave);
  });

  it('returns empty array for an empty seed list', () => {
    const fact = stmt({ s: ALICE, p: KNOWS, o: BOB });
    expect(splitByConcept([fact], [])).toHaveLength(0);
  });

  it('returns empty array when statements list is empty', () => {
    expect(splitByConcept([], [ALICE.value])).toHaveLength(0);
  });
});

describe('splitByConcept — isolated node', () => {
  it('returns only the statements of the seeded isolated node', () => {
    const aliceKnowsBob  = stmt({ s: ALICE, p: KNOWS, o: BOB   });
    const carolLikesDave = stmt({ s: CAROL, p: LIKES, o: DAVE  });

    // Seed on CAROL — no connection to ALICE/BOB
    const result = splitByConcept([aliceKnowsBob, carolLikesDave], [CAROL.value]);
    expect(result).toContain(carolLikesDave);
    expect(result).not.toContain(aliceKnowsBob);
  });

  it('includes statements where seed appears as object', () => {
    // BOB appears as object in ALICE knows BOB — seeding BOB should include that statement
    const aliceKnowsBob = stmt({ s: ALICE, p: KNOWS, o: BOB });
    const result = splitByConcept([aliceKnowsBob], [BOB.value]);
    expect(result).toContain(aliceKnowsBob);
  });
});

describe('splitByConcept — multi-hop connectivity', () => {
  it('follows two-hop connections from the seed', () => {
    // ALICE → BOB → CAROL (chain)
    const aliceKnowsBob   = stmt({ s: ALICE, p: KNOWS, o: BOB   });
    const bobKnowsCarol   = stmt({ s: BOB,   p: KNOWS, o: CAROL });
    const carolLikesDave  = stmt({ s: CAROL, p: LIKES, o: DAVE  });
    const isolated        = stmt({ s: iri('urn:test:eve'), p: KNOWS, o: iri('urn:test:frank') });

    const result = splitByConcept(
      [aliceKnowsBob, bobKnowsCarol, carolLikesDave, isolated],
      [ALICE.value]
    );

    expect(result).toContain(aliceKnowsBob);
    expect(result).toContain(bobKnowsCarol);
    expect(result).toContain(carolLikesDave);
    expect(result).not.toContain(isolated);
  });

  it('merges reachable sets from multiple seeds', () => {
    const aliceKnowsBob  = stmt({ s: ALICE, p: KNOWS, o: BOB   });
    const carolLikesDave = stmt({ s: CAROL, p: LIKES, o: DAVE  });
    const isolated       = stmt({ s: iri('urn:test:zed'), p: KNOWS, o: iri('urn:test:zoe') });

    // Two separate seeds covering both components
    const result = splitByConcept(
      [aliceKnowsBob, carolLikesDave, isolated],
      [ALICE.value, CAROL.value]
    );

    expect(result).toContain(aliceKnowsBob);
    expect(result).toContain(carolLikesDave);
    expect(result).not.toContain(isolated);
  });

  it('handles a literal object in the graph without errors', () => {
    const aliceHasAge = stmt({ s: ALICE, p: iri('urn:test:age'), o: lit('42') });
    const result = splitByConcept([aliceHasAge], [ALICE.value]);
    expect(result).toContain(aliceHasAge);
  });
});
