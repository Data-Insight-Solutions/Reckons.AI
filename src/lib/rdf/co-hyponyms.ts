/**
 * CO-HYPONYMS — entities whose names share a prefix are SIBLINGS, not duplicates (F146).
 *
 * THE SEAM THIS CLOSES. Measured 2026-09-02 on the dictated Pebble Index 01 notes and reproduced in
 * tests/fixtures/extraction-chain.ttl: five entities named `render setting {width, height, quality,
 * samples, format}` (real corpus: `node attribute {name, value, type, repeats, count}`) share a
 * prefix, and TWO STAGES READ THAT SIGNAL IN OPPOSITE DIRECTIONS.
 *
 *   vocabulary-repair  "these names are nearly identical, they are probably the same thing"
 *                      -> proposes a MERGE, which would destroy five distinct settings
 *   hierarchy          "these names share a head, they are probably siblings under one parent"
 *                      -> proposes a PARENT, which is what a person actually meant
 *
 * Only the first reader runs on extraction output today, because nothing infers a parent from a
 * shared prefix. So the destructive reading is the only reading, and hierarchy placed 0 of 32
 * entities on the measured corpus — which is why the review tree had no roots and every real claim
 * arrived as an orphan judgment in a flat list.
 *
 * IT PROPOSES; IT NEVER APPLIES. Every edge returned here is a PENDING fact for review, like an
 * embedding-proposed alias (kb:node-synonyms: "a vocabulary the user did not agree to is not
 * user-managed"). A wrong parent is not a small error — it re-roots a subtree and every later
 * ranking, depth ladder and cascade inherits it.
 *
 * WHY DETERMINISTIC AND NOT A PROMPT (F74.3, and kb:extraction-strategies' third principle: "the
 * deterministic tier comes first and is already earning"). A shared name head is a rule: it is
 * right by construction rather than right on average, costs nothing, runs under every backend, and
 * a model cannot hallucinate a prefix that is not in the strings.
 */
import type { Statement } from './types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KCONCEPT = 'urn:kbase:concept/';

/** Minimum siblings before a shared head is a group rather than a coincidence. */
export const MIN_SIBLINGS = 3;
/** Minimum tokens in the shared head. A single shared word is far too common to mean anything. */
export const MIN_HEAD_TOKENS = 2;

export interface CoHyponymGroup {
  /** The shared head, as words: "render setting". */
  head: string;
  /** Proposed (or existing) parent concept IRI. */
  parentIri: string;
  /** True when an entity with this name already exists, so nothing new needs minting. */
  parentExists: boolean;
  /** The sibling entity IRIs, in stable order. */
  members: string[];
  /** The distinguishing tail of each member, for the reviewer to read: width, height, … */
  tails: string[];
}

const slug = (words: string) => words.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const tokens = (name: string) => name.trim().toLowerCase().split(/[\s\-_]+/).filter(Boolean);

/**
 * An identifier scheme, not a vocabulary. `note-2026-09-02T09-15-04-100Z` and its siblings share
 * the head "note" and differ only in a timestamp — grouping them would propose a parent concept
 * for what is really a primary key, and bury the review queue under one node per capture batch.
 *
 * This is the constructive twin of the guard in vocabulary-repair: there, digits-only difference
 * means NOT a mis-hearing; here it means NOT a hyponym. Both follow from the same fact — a digit
 * carries no meaning the language tiers can reason about.
 */
function isIdentifierTail(tail: string[]): boolean {
  if (!tail.length) return false;
  const joined = tail.join('');
  const digits = (joined.match(/[0-9]/g) ?? []).length;
  return digits > 0 && digits >= joined.length / 2;
}

/**
 * Propose `skos:broader` edges for entities whose labels share a head.
 *
 * Longest head wins: `render setting quality high` and `render setting quality low` belong under
 * `render setting quality`, not directly under `render setting`, so a member is claimed by the most
 * specific group that holds it and never appears in two.
 */
export function proposeCoHyponyms(
  statements: Statement[],
  opts: { minSiblings?: number; minHeadTokens?: number } = {},
): CoHyponymGroup[] {
  const minSiblings = opts.minSiblings ?? MIN_SIBLINGS;
  const minHead = opts.minHeadTokens ?? MIN_HEAD_TOKENS;

  /*
   * WALK BOTH ENDS OF EVERY STATEMENT. A first version collected labels from SUBJECTS only and
   * found nothing at all on the real corpus — because all six `node-attribute-*` entities there
   * appear exclusively as OBJECTS. That is normal for extraction output: a note says "the node
   * needs an attribute for repeat count" and the attribute is the thing being pointed AT, never
   * the thing making a claim. A stage that only walks subjects sees a fraction of the graph.
   */
  const labelOf = new Map<string, string>();
  const slugFallback = (iri: string) => iri.slice(KCONCEPT.length).replace(/[-_]/g, ' ');
  for (const st of statements) {
    for (const term of [st.s, st.o]) {
      if (term.kind !== 'iri' || !term.value.startsWith(KCONCEPT)) continue;
      if (!labelOf.has(term.value)) labelOf.set(term.value, slugFallback(term.value));
    }
    // A real rdfs:label always beats the slug fallback.
    if (st.s.kind === 'iri' && st.p.value === RDFS_LABEL && st.o.kind === 'literal') {
      labelOf.set(st.s.value, st.o.value);
    }
  }

  // Every candidate head: each proper prefix of each name, from longest down.
  const byHead = new Map<string, Array<{ iri: string; tail: string[] }>>();
  for (const [iri, label] of labelOf) {
    const tk = tokens(label);
    for (let n = Math.min(tk.length - 1, 6); n >= minHead; n -= 1) {
      const head = tk.slice(0, n).join(' ');
      const tail = tk.slice(n);
      const list = byHead.get(head);
      if (list) list.push({ iri, tail });
      else byHead.set(head, [{ iri, tail }]);
    }
  }

  const existingByName = new Map<string, string>();
  for (const [iri, label] of labelOf) existingByName.set(slug(label), iri);

  const claimed = new Set<string>();
  const groups: CoHyponymGroup[] = [];

  // Longest head first, so the most specific grouping claims its members.
  const heads = [...byHead.keys()].sort((a, b) => tokens(b).length - tokens(a).length || a.localeCompare(b));
  for (const head of heads) {
    const all = byHead.get(head)!;
    const fresh = all.filter((m) => !claimed.has(m.iri));
    if (fresh.length < minSiblings) continue;

    // An identifier scheme is not a vocabulary. Judged on the WHOLE group: one numeric tail among
    // real words is a legitimate sibling ("render setting 2x"), all-numeric tails are a key space.
    if (fresh.every((m) => isIdentifierTail(m.tail))) continue;

    // Every member must actually distinguish itself, or the "group" is one entity named twice.
    const tails = fresh.map((m) => m.tail.join(' ')).filter(Boolean);
    if (new Set(tails).size < minSiblings) continue;

    for (const m of fresh) claimed.add(m.iri);
    const headSlug = slug(head);
    const existing = existingByName.get(headSlug);
    groups.push({
      head,
      parentIri: existing ?? `${KCONCEPT}${headSlug}`,
      parentExists: Boolean(existing),
      members: fresh.map((m) => m.iri).sort(),
      tails: fresh.map((m) => m.tail.join(' ')).sort(),
    });
  }

  return groups.sort((a, b) => b.members.length - a.members.length || a.head.localeCompare(b.head));
}

/** One answerable question per group — the reviewer confirms a parent, not N edges. */
export function coHyponymQuestion(group: CoHyponymGroup): string {
  const shown = group.tails.slice(0, 4).join(', ');
  const more = group.tails.length > 4 ? `, +${group.tails.length - 4} more` : '';
  return (
    `Are these ${group.members.length} entities kinds of "${group.head}"? (${shown}${more})` +
    (group.parentExists ? '' : ` — "${group.head}" would be created as their parent.`)
  );
}

/**
 * Are two entities siblings under one proposed parent?
 *
 * THIS IS THE COMPOSITION RULE, and it is the whole reason this module exists. vocabulary-repair
 * scores `node attribute name` against `node attribute value` at 0.85 and offers to MERGE them —
 * they are co-hyponyms, so merging would destroy two distinct attributes. A repair proposal
 * between two members of one sibling group is always wrong, and the sibling reading always wins:
 * a shared head plus DIFFERENT tails is positive evidence they are different things, where
 * lexical closeness is only evidence that they are spelled alike.
 *
 * Callers filter with this BEFORE showing a repair, so the two readers of one signal stop
 * contradicting each other in the review queue.
 */
export function areCoHyponyms(iriA: string, iriB: string, groups: CoHyponymGroup[]): boolean {
  return groups.some((g) => g.members.includes(iriA) && g.members.includes(iriB));
}

/** The honest headline: what this stage can and cannot place. */
export function coHyponymSummary(groups: CoHyponymGroup[], totalEntities: number): string {
  if (!groups.length) return 'No shared-name groups — nothing to place from names alone.';
  const placed = groups.reduce((n, g) => n + g.members.length, 0);
  const minted = groups.filter((g) => !g.parentExists).length;
  return (
    `${groups.length} group${groups.length === 1 ? '' : 's'} would place ${placed} of ${totalEntities} ` +
    `entit${totalEntities === 1 ? 'y' : 'ies'}${minted ? `, minting ${minted} parent${minted === 1 ? '' : 's'}` : ''} ` +
    '— proposals only, nothing placed until reviewed.'
  );
}
