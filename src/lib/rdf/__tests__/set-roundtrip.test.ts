/**
 * DOES A SET SURVIVE A ROUND TRIP? Testing a claim rather than trusting it.
 *
 * kb:set-substrate asserts, in the graph, that a set "diffs, reviews, versions and round-trips
 * exactly like any other fact. Nothing in src/lib/rdf/types.ts has to move." That is the argument
 * the whole design rests on, and the ONLY evidence for it was the reasoning that produced it —
 * a claim made by the party it benefits, which kb:mission says is not evidence.
 *
 * So: export a set to Turtle, parse it back, and check the set is still a set. Three shapes,
 * because they fail differently —
 *
 *   AUTHORED    skos:Collection + skos:member, what a user makes in the app
 *   DECLARED    skos:Collection + kpred:member-predicate, what derivation proposes
 *   ORDERED     the skolemised membership nodes, which is where the substrate was WARNED it
 *               would break (F187.2: an rdf:List re-proposes its whole chain on every import,
 *               because n3 allocates blank-node labels from a process-global counter)
 *
 * The ordered case is the one worth having. If skolemised ordinals do not survive, the fix chosen
 * over rdf:List bought nothing.
 */
import { describe, it, expect } from 'vitest';
import { toTurtle } from '../serialize';
import { Parser } from 'n3';
import { buildEntitySet } from '../entity-sets';
import { deriveSets, derivedSetStatements } from '../set-derive';
import {
  readSets, membershipIri, COLLECTION, ORDERED_COLLECTION, MEMBER, PREF_LABEL,
  MEMBER_ORDER, IN_SET, HAS_MEMBER_ENTITY,
} from '../sets';
import type { Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const C = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';

/** Export to Turtle, parse with the same parser the app uses, read the sets back out. */
function roundTrip(statements: Statement[]) {
  const ttl = toTurtle(statements);
  const quads = new Parser().parse(ttl);
  return { ttl, sets: readSets(quads) };
}

/*
 * Ids are uuid-SHAPED on purpose. The first version of this file keyed them as `${s}|${p}|${o}`
 * and every case using it failed to parse — toTurtle mints `urn:kbase:stmt/<id>` for statement
 * metadata, so a `|` in an id produces an IRI no Turtle parser will accept. That was this test's
 * bug, not the product's (every id in the app comes from uuid()), but it is worth knowing that
 * the id reaches an IRI unescaped. See `ids are opaque` below.
 */
let n = 0;
function fact(s: string, p: string, o: string, literal = false): Statement {
  return {
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: literal ? { kind: 'literal', value: o } : { kind: 'iri', value: o },
    g: { kind: 'iri', value: 'urn:kbase:source/test' },
    sourceId: 'test',
    confidence: 1,
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('a set survives export and re-import', () => {
  it('AUTHORED — a set made in the app comes back whole', () => {
    const { setIri, statements } = buildEntitySet('DAM shortlist', [`${C}aprimo`, `${C}bynder`, `${C}opentext`]);
    const { sets } = roundTrip(statements);

    expect(sets).toHaveLength(1);
    expect(sets[0].iri).toBe(setIri);
    expect(sets[0].label).toBe('DAM shortlist');
    expect(sets[0].members.map((m) => m.iri).sort()).toEqual([`${C}aprimo`, `${C}bynder`, `${C}opentext`]);
  });

  it('DECLARED — a derived set comes back with its members, from two quads', () => {
    const facts = [
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}aprimo`),
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}bynder`),
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}opentext`),
    ];
    const { derived } = deriveSets(facts);
    /*
     * CONFIRMED FIRST, because that is the case worth testing. toTurtle exports only `confirmed`
     * and `refined` — a pending proposal is correctly left out of an export, and the first version
     * of this test asserted the opposite and was wrong. What matters is that a derived set a
     * REVIEWER ACCEPTED survives the trip, which is what this now checks.
     */
    const accepted = derivedSetStatements(derived[0], { id: 'test', graph: 'urn:kbase:source/test' })
      .map((st) => ({ ...st, status: 'confirmed' as const }));

    const { sets } = roundTrip([...facts, ...accepted]);
    expect(sets).toHaveLength(1);
    expect(sets[0].members).toHaveLength(3);
    expect(sets[0].memberPredicates).toEqual([`${P}includes`]);
  });

  it('an UNACCEPTED derived set is not exported — a proposal is not a fact', () => {
    const facts = [
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}aprimo`),
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}bynder`),
      fact(`${C}dam-shortlist`, `${P}includes`, `${C}opentext`),
    ];
    const { derived } = deriveSets(facts);
    const pending = derivedSetStatements(derived[0], { id: 'test', graph: 'urn:kbase:source/test' });
    expect(pending.every((p) => p.status === 'pending')).toBe(true);

    // The member edges still export (they are confirmed facts); the SET declaration does not.
    const { sets, ttl } = roundTrip([...facts, ...pending]);
    expect(sets).toHaveLength(0);
    expect(ttl).toContain('includes');
  });

  /*
   * THE ONE THAT MATTERS. F187.2 rejected skos:memberList because an rdf:List is a chain of blank
   * nodes and n3 allocates their labels from a process-global counter, so the same list parses to
   * different identities each time and computeDiff sees every cell as new. The replacement is a
   * skolemised membership node with a STABLE, derived IRI. If that does not survive a round trip,
   * the replacement bought nothing and the warning applies to it too.
   */
  it('ORDERED — skolemised ordinals survive, and identity is stable across TWO parses', () => {
    const set = `${C}five-moves`;
    const members = [`${C}capture`, `${C}extract`, `${C}review`];
    const statements: Statement[] = [
      fact(set, RDF_TYPE, ORDERED_COLLECTION),
      fact(set, PREF_LABEL, 'The five moves', true),
      ...members.flatMap((m, i) => [
        fact(set, MEMBER, m),
        fact(membershipIri(set, m), IN_SET, set),
        fact(membershipIri(set, m), HAS_MEMBER_ENTITY, m),
        fact(membershipIri(set, m), MEMBER_ORDER, String(i + 1), true),
      ]),
    ];

    const first = roundTrip(statements);
    expect(first.sets).toHaveLength(1);
    expect(first.sets[0].ordered).toBe(true);
    expect(first.sets[0].members.map((m) => m.iri)).toEqual(members);
    expect(first.sets[0].members.map((m) => m.order)).toEqual([1, 2, 3]);

    // Parse a SECOND time in the same process — the exact condition that broke rdf:List.
    const second = roundTrip(statements);
    expect(second.sets[0].members.map((m) => m.iri)).toEqual(first.sets[0].members.map((m) => m.iri));
    expect(second.sets[0].members.map((m) => m.order)).toEqual([1, 2, 3]);

    // And no blank node appears anywhere in the serialized form.
    expect(first.ttl).not.toMatch(/_:/);
  });

  it('the serialized Turtle contains no blank nodes for ANY set shape', () => {
    const { statements } = buildEntitySet('S', [`${C}a`, `${C}b`, `${C}c`]);
    expect(toTurtle(statements)).not.toMatch(/_:/);
  });

  /*
   * OVERLAP is the capability skos:Collection was chosen over a tree FOR, so it must survive the
   * trip too — a serializer that quietly partitions would undo the whole choice.
   */
  it('OVERLAP — one entity in two sets is still in two sets afterwards', () => {
    const a = buildEntitySet('Shortlist', [`${C}aprimo`, `${C}opentext`, `${C}bynder`]);
    const b = buildEntitySet('Deployed', [`${C}opentext`, `${C}vantage`, `${C}legacy`]);
    const { sets } = roundTrip([...a.statements, ...b.statements]);

    expect(sets).toHaveLength(2);
    const holding = sets.filter((s) => s.members.some((m) => m.iri === `${C}opentext`));
    expect(holding).toHaveLength(2);
  });

  it('a set with a legacy-dialect body still reads after a round trip', () => {
    const statements = [
      fact(`${C}crew`, RDF_TYPE, 'urn:kbase:type/EntitySet'),
      fact(`${C}crew`, `${P}has-member`, `${C}alex`),
      fact(`${C}crew`, `${P}has-member`, `${C}jordan`),
    ];
    const { sets } = roundTrip(statements);
    expect(sets).toHaveLength(1);
    expect(sets[0].members).toHaveLength(2);
  });

  it('a plain graph with no sets produces none — the reader does not manufacture them', () => {
    const { sets } = roundTrip([fact(`${C}earth`, `${P}orbits`, `${C}sun`)]);
    expect(sets).toHaveLength(0);
  });
});
