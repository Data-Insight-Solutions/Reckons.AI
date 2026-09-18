/**
 * SETS (F187) — reading skos:Collection out of a graph.
 *
 * Matt, 2026-09-08: sets should define the pages, an entity can belong to several, order within a
 * set carries meaning, and the overlap between sets is the link. This module is the read side of
 * that, shared rather than duplicated: two page generators already disagree about what a page is,
 * and sets must not become a third thing only one of them understands.
 *
 * WHY skos:Collection AND NOT skos:ConceptScheme. Both were considered. A ConceptScheme is a
 * vocabulary — in THIS repository all seven uses are the closed enums the code draws from
 * (AltitudeScheme, ReviewStatusScheme, FeatureLifecycle), so making a user's "Trip to Japan" a
 * ConceptScheme would file it beside the list of valid review statuses. A Collection is a labelled
 * grouping joined by skos:member, and three properties settle it:
 *
 *   - skos:member ranges over Concept UNION Collection, so sets NEST with no invention.
 *   - A concept may be a member of MANY collections: membership overlaps rather than partitions.
 *   - SKOS S13 makes Collection disjoint from both Concept and ConceptScheme, so a set can carry
 *     an IRI and attributes while formally NOT being one of the nodes in the concept graph —
 *     which is Matt's "a set is not a node, but a grouping of nodes", in the standard.
 *
 * ORDER IS A PROPERTY OF MEMBERSHIP, NOT OF THE MEMBER, because an entity may sit third in one set
 * and first in another. It therefore hangs off a SKOLEMISED membership node rather than an
 * rdf:List: blank-node labels are not stable across parses (n3 allocates them from a process-global
 * counter, measured 2026-09-08), so a list-shaped answer re-proposes its entire chain on every
 * re-import. `skos:memberList` is still emitted on export for interop; it is never the source.
 */

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';

export const COLLECTION = `${SKOS}Collection`;
export const ORDERED_COLLECTION = `${SKOS}OrderedCollection`;
export const MEMBER = `${SKOS}member`;
export const PREF_LABEL = `${SKOS}prefLabel`;
export const DEFINITION = `${SKOS}definition`;

/*
 * THE APP'S OWN GROUPING VOCABULARY, READ AS AN EQUAL (2026-09-11).
 *
 * F65 shipped `ktype:EntitySet` + `kpred:has-member` + `rdfs:label` and the graph canvas still
 * writes it; F187 chose `skos:Collection` + `skos:member` + `skos:prefLabel` and this module read
 * only that. So for three days EVERY SET A USER MADE IN THE APP WAS INVISIBLE TO THE SETS LAYER —
 * including the two that ship in static/knowledge.ttl and static/starter-everyday.ttl, which
 * `set-integrity` and `set-pages` therefore never saw. Found by grepping both vocabularies rather
 * than by any test, because each half was internally consistent and neither knew about the other.
 *
 * The roadmap already called this a rename rather than a rebuild (kb:set-semantics, .measured):
 * the two shapes are isomorphic. So READ BOTH, FOREVER — old graphs and hand-written TTL keep
 * working — and WRITE SKOS, which `buildEntitySet` now does. This is not a migration with an end
 * date; it is a reader that accepts the dialect it is handed.
 */
export const ENTITY_SET_TYPE = `${KTYPE}EntitySet`;
export const HAS_MEMBER = `${KPRED}has-member`;
export const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const SET_KIND = `${KPRED}set-kind`;
export const MEMBER_ORDER = `${KPRED}member-order`;
export const SET_RELATES_TO = `${KPRED}set-relates-to`;

/**
 * MEMBERSHIP BY DECLARATION — a set that costs 2 quads instead of N+2 (2026-09-11).
 *
 * A graph almost always states its groupings already, under its own word:
 *
 *     kb:dam-shortlist  kpred:includes  kb:aprimo, kb:opentext, kb:bynder .
 *
 * That IS a set. Making it readable as one by restating every edge as skos:member would duplicate
 * N facts to add no information, and — measured, not assumed — every duplicate is another BM25
 * document competing with real facts (scripts/offline/set-complexity.ts: membership rows displaced
 * a real result in 5 of 25 queries before weighting). So instead the set NAMES the predicate its
 * membership is already carried by:
 *
 *     kb:dam-shortlist  a skos:Collection ; kpred:member-predicate kpred:includes .
 *
 * Two quads, regardless of how many members, and NO new membership rows in the index at all. It is
 * also the honest encoding: it records that this graph's word for membership is `includes`, rather
 * than overwriting the author's vocabulary with ours.
 *
 * skos:member still works and is still what an authored set uses. This is an ADDITIONAL route in,
 * for the far commoner case of a grouping that already exists under another name — which is what
 * makes deterministic derivation possible at all (see src/lib/rdf/set-derive.ts).
 */
export const MEMBER_PREDICATE = `${KPRED}member-predicate`;
/** Skolemised membership: <set>/member/<member-local-name> carries the ordinal for that pair. */
export const IN_SET = `${KPRED}in-set`;
export const HAS_MEMBER_ENTITY = `${KPRED}member-entity`;

/** Structural quad shape, declared locally so this is usable without a parser. */
export interface SetQuad {
  subject: { value: string };
  predicate: { value: string };
  object: { value: string; termType?: string };
}

export interface SetMember {
  iri: string;
  /** Position within THIS set. Absent when the set is unordered or nobody has said. */
  order?: number;
}

export interface EntitySet {
  iri: string;
  label: string;
  definition: string;
  /** skos:notation of the set kind, e.g. "page" | "story" | "roster" | "contrast". */
  kind: string | null;
  ordered: boolean;
  members: SetMember[];
  /** Other sets, or entities, this set points at. */
  relatesTo: string[];
  /**
   * Predicates this set's membership is carried by, instead of skos:member. Empty for an authored
   * set. Non-empty means the grouping was already in the graph under the author's own word — worth
   * showing a reviewer, because it is the difference between "somebody grouped these" and "these
   * were already grouped and we noticed".
   */
  memberPredicates: string[];
}

const localName = (iri: string): string => iri.split(/[/#]/).filter(Boolean).pop() ?? iri;

/** The membership node for one (set, member) pair — stable, derived, never a blank node. */
export function membershipIri(setIri: string, memberIri: string): string {
  return `${setIri}/member/${localName(memberIri)}`;
}

/**
 * Every set in a graph, with members in order.
 *
 * `notationOf` maps a set-kind concept IRI to its skos:notation. Passed in rather than looked up
 * here because the kinds live in reckons-vocabulary.ttl and a docs graph does not import it — the
 * caller knows which graphs it loaded and this module should not guess.
 */
export function readSets(quads: SetQuad[], notationOf: Map<string, string> = new Map()): EntitySet[] {
  const isSet = new Map<string, boolean>();
  const label = new Map<string, string>();
  /* rdfs:label is the F65 spelling. Kept apart so skos:prefLabel always wins where both exist. */
  const fallbackLabel = new Map<string, string>();
  const definition = new Map<string, string>();
  const kind = new Map<string, string>();
  const members = new Map<string, string[]>();
  const relates = new Map<string, string[]>();
  // Ordinals arrive on membership nodes, which name the set and the member separately.
  const ordinalOf = new Map<string, number>();
  const memberOfNode = new Map<string, string>();
  const setOfNode = new Map<string, string>();
  /** set IRI -> predicates that already carry its membership (kpred:member-predicate). */
  const declaredVia = new Map<string, Set<string>>();

  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    const o = q.object.value;
    switch (p) {
      case RDF_TYPE:
        if (o === COLLECTION || o === ENTITY_SET_TYPE) isSet.set(s, isSet.get(s) ?? false);
        else if (o === ORDERED_COLLECTION) isSet.set(s, true);
        break;
      case PREF_LABEL: label.set(s, o); break;
      case RDFS_LABEL: fallbackLabel.set(s, o); break;
      case DEFINITION: definition.set(s, o); break;
      case SET_KIND: kind.set(s, o); break;
      case MEMBER:
      case HAS_MEMBER:
        members.set(s, [...(members.get(s) ?? []), o]);
        break;
      case SET_RELATES_TO: relates.set(s, [...(relates.get(s) ?? []), o]); break;
      case MEMBER_ORDER: {
        const n = Number.parseInt(o, 10);
        if (Number.isFinite(n)) ordinalOf.set(s, n);
        break;
      }
      case MEMBER_PREDICATE: {
        const set = declaredVia.get(s) ?? new Set<string>();
        set.add(o);
        declaredVia.set(s, set);
        break;
      }
      case IN_SET: setOfNode.set(s, o); break;
      case HAS_MEMBER_ENTITY: memberOfNode.set(s, o); break;
      default: break;
    }
  }

  /*
   * SECOND PASS — members carried by a declared predicate. Separate from the first because a
   * declaration can appear after the edges it describes, and a single pass would miss those.
   * Still O(n) and still one allocation-free scan; compute measured at ~2ms over 17k quads.
   */
  if (declaredVia.size > 0) {
    for (const q of quads) {
      const via = declaredVia.get(q.subject.value);
      if (!via || !via.has(q.predicate.value)) continue;
      // Literals are values, not members. A set of strings is an attribute with repetition.
      if (q.object.termType === 'Literal') continue;
      const existing = members.get(q.subject.value) ?? [];
      if (!existing.includes(q.object.value)) members.set(q.subject.value, [...existing, q.object.value]);
    }
  }

  // Fold the membership nodes down to (set, member) -> ordinal.
  const orderFor = new Map<string, number>();
  for (const [node, n] of ordinalOf) {
    const set = setOfNode.get(node);
    const member = memberOfNode.get(node);
    if (set && member) orderFor.set(`${set}\u0000${member}`, n);
  }

  const out: EntitySet[] = [];
  for (const [iri, ordered] of isSet) {
    const raw = members.get(iri) ?? [];
    const withOrder: SetMember[] = raw.map((m) => {
      const n = orderFor.get(`${iri}\u0000${m}`);
      return n === undefined ? { iri: m } : { iri: m, order: n };
    });
    /*
     * Ordered members first and in order; the rest keep the order the graph stated them in.
     * Sorting the unordered ones alphabetically would be tidier and wrong — it would silently
     * impose a sequence on a set whose author deliberately gave none.
     */
    withOrder.sort((a, b) => {
      if (a.order === undefined && b.order === undefined) return 0;
      if (a.order === undefined) return 1;
      if (b.order === undefined) return -1;
      return a.order - b.order;
    });
    const kindIri = kind.get(iri);
    out.push({
      iri,
      label: label.get(iri) ?? fallbackLabel.get(iri) ?? localName(iri),
      definition: definition.get(iri) ?? '',
      kind: kindIri ? (notationOf.get(kindIri) ?? localName(kindIri)) : null,
      ordered,
      members: withOrder,
      relatesTo: relates.get(iri) ?? [],
      memberPredicates: [...(declaredVia.get(iri) ?? [])].sort(),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** skos:Concept IRI -> its notation, for resolving a set's kind. */
export function readNotations(quads: SetQuad[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const q of quads) if (q.predicate.value === `${SKOS}notation`) out.set(q.subject.value, q.object.value);
  return out;
}

/**
 * Sets that share a member — the derived cross-link, and the Venn.
 *
 * Never asserted. Matt, 2026-09-08: pages can be linked especially when they share an entity. A
 * hand-written see-also list is a claim nobody re-checks; this one cannot go stale because it is
 * recomputed from membership every time.
 */
export function setOverlaps(sets: EntitySet[]): Array<{ a: string; b: string; shared: string[] }> {
  const out: Array<{ a: string; b: string; shared: string[] }> = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const bMembers = new Set(sets[j].members.map((m) => m.iri));
      const shared = sets[i].members.map((m) => m.iri).filter((m) => bMembers.has(m));
      if (shared.length) out.push({ a: sets[i].iri, b: sets[j].iri, shared });
    }
  }
  return out.sort((x, y) => y.shared.length - x.shared.length);
}


/*
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCKS — a page is a composition over sets, not a set (F187.5, corrected).
 *
 * Matt, 2026-09-09: "a set may define a set of entities and triples related to a page, but it does
 * not define the page. Different components used for different sets within the page, or additional
 * nodes for content like images, will build upon what minimally could be a page made with a set."
 *
 * So a page is an ORDERED LIST OF BLOCKS, and each block pairs a set with a COMPONENT. That is
 * what one-set-one-page could not express: the same page rendering one set as a gallery and
 * another as an accordion, and blocks that are not sets at all. It also frees a set to appear on
 * several pages rendered differently each time, which one-set-one-page forbade by construction.
 *
 * A page of exactly one block over one set is still a page. The minimum is not a special case.
 *
 * Blocks are SKOLEMISED for the same reason memberships are: <page>/block/<n> is stable, diffable
 * and reviewable, where a blank node would be none of those.
 */

export const HAS_BLOCK = `${KPRED}has-block`;
export const BLOCK_SET = `${KPRED}block-set`;
export const BLOCK_COMPONENT = `${KPRED}block-component`;
export const BLOCK_ORDER = `${KPRED}block-order`;
export const BLOCK_CONTENT = `${KPRED}block-content`;
export const BLOCK_HEADING = `${KPRED}block-heading`;

/** How a block is presented. Unknown values fall back to a plain list rather than failing. */
export type BlockComponent = 'list' | 'gallery' | 'accordion' | 'prose' | 'figure';

export interface PageBlock {
  iri: string;
  order: number;
  /** The set this block draws its entities from, if it draws from one. */
  set: string | null;
  /** A single content node — an image, a diagram, a paragraph — for blocks that are not sets. */
  content: string | null;
  component: BlockComponent;
  /** An optional heading above the block, so one page can label two sets differently. */
  heading: string | null;
}

const COMPONENTS = new Set<BlockComponent>(['list', 'gallery', 'accordion', 'prose', 'figure']);

/**
 * The blocks of every page that declares any, keyed by the page entity.
 *
 * A page with no blocks is absent from the result rather than present and empty: the generators
 * fall back to their existing behaviour for those, so blocks can be adopted one page at a time
 * instead of requiring every page to be converted before any of them work.
 */
export function readBlocks(quads: SetQuad[]): Map<string, PageBlock[]> {
  const owner = new Map<string, string>();
  const set = new Map<string, string>();
  const content = new Map<string, string>();
  const component = new Map<string, string>();
  const order = new Map<string, number>();
  const heading = new Map<string, string>();

  for (const q of quads) {
    const s = q.subject.value;
    switch (q.predicate.value) {
      case HAS_BLOCK: owner.set(q.object.value, s); break;
      case BLOCK_SET: set.set(s, q.object.value); break;
      case BLOCK_CONTENT: content.set(s, q.object.value); break;
      case BLOCK_COMPONENT: component.set(s, q.object.value); break;
      case BLOCK_HEADING: heading.set(s, q.object.value); break;
      case BLOCK_ORDER: {
        const n = Number.parseInt(q.object.value, 10);
        if (Number.isFinite(n)) order.set(s, n);
        break;
      }
      default: break;
    }
  }

  const out = new Map<string, PageBlock[]>();
  for (const [block, page] of owner) {
    const raw = component.get(block) ?? 'list';
    const blocks = out.get(page) ?? [];
    blocks.push({
      iri: block,
      order: order.get(block) ?? Number.MAX_SAFE_INTEGER,
      set: set.get(block) ?? null,
      content: content.get(block) ?? null,
      // An unrecognised component renders as a list rather than throwing. A page that half-renders
      // is more useful than a build that fails over a typo in a presentation hint.
      component: COMPONENTS.has(raw as BlockComponent) ? (raw as BlockComponent) : 'list',
      heading: heading.get(block) ?? null,
    });
    out.set(page, blocks);
  }
  for (const blocks of out.values()) {
    blocks.sort((a, b) => a.order - b.order || a.iri.localeCompare(b.iri));
  }
  return out;
}

/** Stable IRI for the nth block of a page. Never a blank node. */
export function blockIri(pageIri: string, n: number): string {
  return `${pageIri}/block/${n}`;
}
