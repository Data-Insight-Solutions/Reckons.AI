/**
 * SETS (F187) — the read side.
 *
 * The assertions that matter are the three properties the whole design rests on: membership
 * OVERLAPS rather than partitions, sets NEST, and order belongs to the (set, member) pair rather
 * than to the member. If any of those quietly stopped holding, sets would still look like they
 * worked while failing at the only things they were chosen for.
 */
import { describe, it, expect } from 'vitest';
import {
  readSets, readNotations, setOverlaps, membershipIri, readBlocks, blockIri,
  HAS_BLOCK, BLOCK_SET, BLOCK_COMPONENT, BLOCK_ORDER, BLOCK_CONTENT, BLOCK_HEADING,
  COLLECTION, ORDERED_COLLECTION, MEMBER, PREF_LABEL, DEFINITION,
  SET_KIND, MEMBER_ORDER, IN_SET, HAS_MEMBER_ENTITY, SET_RELATES_TO,
  type SetQuad,
} from '../sets';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const q = (s: string, p: string, o: string, termType = 'NamedNode'): SetQuad => ({
  subject: { value: s }, predicate: { value: p }, object: { value: o, termType },
});
const lit = (s: string, p: string, o: string) => q(s, p, o, 'Literal');

const SHORTLIST = 'urn:kbase:concept/set-shortlist';
const DEPLOYED = 'urn:kbase:concept/set-deployed';
const APRIMO = 'urn:kbase:concept/aprimo';
const BYNDER = 'urn:kbase:concept/bynder';
const OPENTEXT = 'urn:kbase:concept/opentext';
const VANTAGE = 'urn:kbase:concept/vantage-suite';

describe('reading a set', () => {
  const base: SetQuad[] = [
    q(SHORTLIST, RDF_TYPE, COLLECTION),
    lit(SHORTLIST, PREF_LABEL, 'Shortlist'),
    lit(SHORTLIST, DEFINITION, 'The three carried forward.'),
    q(SHORTLIST, MEMBER, APRIMO), q(SHORTLIST, MEMBER, BYNDER), q(SHORTLIST, MEMBER, OPENTEXT),
  ];

  it('reads label, definition and members', () => {
    const [s] = readSets(base);
    expect(s.label).toBe('Shortlist');
    expect(s.definition).toBe('The three carried forward.');
    expect(s.members.map((m) => m.iri)).toEqual([APRIMO, BYNDER, OPENTEXT]);
    expect(s.ordered).toBe(false);
  });

  it('resolves a set kind through its notation, not its IRI', () => {
    const kindIri = 'urn:kbase:type/set-kind/roster';
    const notations = readNotations([lit(kindIri, 'http://www.w3.org/2004/02/skos/core#notation', 'roster')]);
    const [s] = readSets([...base, q(SHORTLIST, SET_KIND, kindIri)], notations);
    expect(s.kind).toBe('roster');
  });

  it('leaves kind null when none is stated — a set need not be typed to be a set', () => {
    expect(readSets(base)[0].kind).toBeNull();
  });

  it('reads set-to-set relations', () => {
    const [s] = readSets([...base, q(SHORTLIST, SET_RELATES_TO, DEPLOYED)]);
    expect(s.relatesTo).toEqual([DEPLOYED]);
  });
});

describe('membership overlaps rather than partitions', () => {
  const both: SetQuad[] = [
    q(SHORTLIST, RDF_TYPE, COLLECTION), lit(SHORTLIST, PREF_LABEL, 'Shortlist'),
    q(SHORTLIST, MEMBER, APRIMO), q(SHORTLIST, MEMBER, OPENTEXT),
    q(DEPLOYED, RDF_TYPE, COLLECTION), lit(DEPLOYED, PREF_LABEL, 'Deployed'),
    q(DEPLOYED, MEMBER, VANTAGE), q(DEPLOYED, MEMBER, OPENTEXT),
  ];

  it('lets one entity belong to two sets', () => {
    const sets = readSets(both);
    const holding = sets.filter((s) => s.members.some((m) => m.iri === OPENTEXT));
    expect(holding).toHaveLength(2);
  });

  it('derives the shared members between sets — the cross-link and the Venn', () => {
    const [o] = setOverlaps(readSets(both));
    expect(o.shared).toEqual([OPENTEXT]);
  });

  it('reports no overlap when sets genuinely share nothing', () => {
    const apart = both.filter((x) => !(x.subject.value === DEPLOYED && x.object.value === OPENTEXT));
    expect(setOverlaps(readSets(apart))).toEqual([]);
  });
});

describe('sets nest', () => {
  it('accepts a collection as a member of another collection', () => {
    const all = 'urn:kbase:concept/set-everyone';
    const sets = readSets([
      q(SHORTLIST, RDF_TYPE, COLLECTION), q(SHORTLIST, MEMBER, APRIMO), q(SHORTLIST, MEMBER, BYNDER),
      q(all, RDF_TYPE, COLLECTION), q(all, MEMBER, SHORTLIST), q(all, MEMBER, VANTAGE),
    ]);
    const everyone = sets.find((s) => s.iri === all)!;
    expect(everyone.members.map((m) => m.iri)).toContain(SHORTLIST);
  });
});

describe('order belongs to the membership, not the member', () => {
  const MIGRATION = 'urn:kbase:concept/set-migration';
  const OTHER = 'urn:kbase:concept/set-other';
  const ordered = (set: string, member: string, n: number): SetQuad[] => [
    q(membershipIri(set, member), IN_SET, set),
    q(membershipIri(set, member), HAS_MEMBER_ENTITY, member),
    lit(membershipIri(set, member), MEMBER_ORDER, String(n)),
  ];

  it('sorts members by their stated position', () => {
    const [s] = readSets([
      q(MIGRATION, RDF_TYPE, ORDERED_COLLECTION),
      q(MIGRATION, MEMBER, OPENTEXT), q(MIGRATION, MEMBER, APRIMO), q(MIGRATION, MEMBER, BYNDER),
      ...ordered(MIGRATION, APRIMO, 1), ...ordered(MIGRATION, BYNDER, 2), ...ordered(MIGRATION, OPENTEXT, 3),
    ]);
    expect(s.ordered).toBe(true);
    expect(s.members.map((m) => m.iri)).toEqual([APRIMO, BYNDER, OPENTEXT]);
  });

  it('gives ONE entity DIFFERENT positions in DIFFERENT sets', () => {
    // The property that makes the ordinal belong to the pair. If it lived on the member, an entity
    // could only ever hold one position and overlapping ordered sets would be impossible.
    const sets = readSets([
      q(MIGRATION, RDF_TYPE, ORDERED_COLLECTION), q(MIGRATION, MEMBER, APRIMO), q(MIGRATION, MEMBER, BYNDER),
      q(OTHER, RDF_TYPE, ORDERED_COLLECTION), q(OTHER, MEMBER, APRIMO), q(OTHER, MEMBER, BYNDER),
      ...ordered(MIGRATION, APRIMO, 1), ...ordered(MIGRATION, BYNDER, 2),
      ...ordered(OTHER, BYNDER, 1), ...ordered(OTHER, APRIMO, 2),
    ]);
    const m = sets.find((s) => s.iri === MIGRATION)!;
    const o = sets.find((s) => s.iri === OTHER)!;
    expect(m.members.map((x) => x.iri)).toEqual([APRIMO, BYNDER]);
    expect(o.members.map((x) => x.iri)).toEqual([BYNDER, APRIMO]);
  });

  it('does NOT invent an order for members nobody positioned', () => {
    // Sorting the unordered alphabetically would be tidier and wrong: it imposes a sequence on a
    // set whose author deliberately gave none, and a reader cannot tell the difference.
    const [s] = readSets([
      q(SHORTLIST, RDF_TYPE, COLLECTION),
      q(SHORTLIST, MEMBER, OPENTEXT), q(SHORTLIST, MEMBER, APRIMO), q(SHORTLIST, MEMBER, BYNDER),
    ]);
    expect(s.members.map((m) => m.iri)).toEqual([OPENTEXT, APRIMO, BYNDER]);
  });

  it('puts positioned members before unpositioned ones', () => {
    const [s] = readSets([
      q(MIGRATION, RDF_TYPE, ORDERED_COLLECTION),
      q(MIGRATION, MEMBER, OPENTEXT), q(MIGRATION, MEMBER, APRIMO),
      ...ordered(MIGRATION, APRIMO, 1),
    ]);
    expect(s.members[0].iri).toBe(APRIMO);
    expect(s.members[1].order).toBeUndefined();
  });

  it('builds a membership IRI that is stable and contains no blank node', () => {
    expect(membershipIri(MIGRATION, APRIMO)).toBe(`${MIGRATION}/member/aprimo`);
    expect(membershipIri(MIGRATION, APRIMO)).toBe(membershipIri(MIGRATION, APRIMO));
  });
});


/**
 * BLOCKS — a page is a composition over sets, not a set (Matt, 2026-09-09).
 *
 * The assertions that matter are the ones one-set-one-page could not satisfy: two sets on ONE page
 * with DIFFERENT components, and a block that is not a set at all.
 */
describe('a page is an ordered list of blocks', () => {
  const PAGE = 'urn:reckons:feature/FiveMoves';
  const b = (n: number) => blockIri(PAGE, n);
  const page: SetQuad[] = [
    q(PAGE, HAS_BLOCK, b(1)), q(PAGE, HAS_BLOCK, b(2)), q(PAGE, HAS_BLOCK, b(3)),
    q(b(1), BLOCK_SET, SHORTLIST), lit(b(1), BLOCK_COMPONENT, 'gallery'), lit(b(1), BLOCK_ORDER, '1'),
    q(b(2), BLOCK_SET, DEPLOYED), lit(b(2), BLOCK_COMPONENT, 'accordion'), lit(b(2), BLOCK_ORDER, '2'),
    lit(b(3), BLOCK_ORDER, '3'), q(b(3), BLOCK_CONTENT, 'urn:kbase:concept/some-diagram'),
    lit(b(3), BLOCK_COMPONENT, 'figure'),
  ];

  it('renders TWO sets on ONE page with DIFFERENT components', () => {
    // The thing one-set-one-page forbade by construction, and the reason it was wrong.
    const blocks = readBlocks(page).get(PAGE)!;
    expect(blocks.map((x) => [x.set, x.component])).toEqual([
      [SHORTLIST, 'gallery'],
      [DEPLOYED, 'accordion'],
      [null, 'figure'],
    ]);
  });

  it('carries a block that is not a set at all — an image, a diagram, a paragraph', () => {
    const blocks = readBlocks(page).get(PAGE)!;
    expect(blocks[2].set).toBeNull();
    expect(blocks[2].content).toBe('urn:kbase:concept/some-diagram');
  });

  it('orders blocks by their stated position', () => {
    const shuffled = [...page].reverse();
    expect(readBlocks(shuffled).get(PAGE)!.map((x) => x.order)).toEqual([1, 2, 3]);
  });

  it('lets one set appear on two pages with different components', () => {
    // A set is material, not a page — so the same set can be presented differently elsewhere.
    const OTHER = 'urn:reckons:feature/Other';
    const blocks = readBlocks([
      ...page,
      q(OTHER, HAS_BLOCK, blockIri(OTHER, 1)),
      q(blockIri(OTHER, 1), BLOCK_SET, SHORTLIST),
      lit(blockIri(OTHER, 1), BLOCK_COMPONENT, 'list'),
      lit(blockIri(OTHER, 1), BLOCK_ORDER, '1'),
    ]);
    expect(blocks.get(PAGE)![0].component).toBe('gallery');
    expect(blocks.get(OTHER)![0].component).toBe('list');
    expect(blocks.get(OTHER)![0].set).toBe(SHORTLIST);
  });

  it('falls back to a list on an unrecognised component rather than throwing', () => {
    // A page that half-renders beats a build that dies over a typo in a presentation hint.
    const blocks = readBlocks([
      q(PAGE, HAS_BLOCK, b(9)), q(b(9), BLOCK_SET, SHORTLIST), lit(b(9), BLOCK_COMPONENT, 'carousel'),
    ]);
    expect(blocks.get(PAGE)![0].component).toBe('list');
  });

  it('omits a page with no blocks, so blocks can be adopted one page at a time', () => {
    expect(readBlocks([q(SHORTLIST, MEMBER, APRIMO)]).size).toBe(0);
  });

  it('carries an optional heading, so one page can label two sets differently', () => {
    const blocks = readBlocks([...page, lit(b(1), BLOCK_HEADING, 'What you pick between')]);
    expect(blocks.get(PAGE)![0].heading).toBe('What you pick between');
  });
});
