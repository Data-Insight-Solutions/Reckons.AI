/**
 * WHAT ELSE COULD THIS TERM HAVE BEEN? — a shortlist per position, drawn from the graph itself.
 *
 * Matt, 2026-09-10: "Can we somehow get other potential subjects, predicates, and objects to show
 * easily on click, and then allow from short list of other options that could have been the intent?"
 *
 * THE PROBLEM THIS SOLVES IS REJECT-AND-REDO. A reviewer meets one triple. If the subject resolved
 * to the wrong entity, or the predicate is nearly right, the only moves today are accept something
 * wrong or reject and re-enter it by hand — so the near-misses get rejected and the knowledge is
 * lost with them. Offering the alternatives turns a rejection into a correction, which is the
 * cheapest possible improvement to review throughput.
 *
 * EVERY CANDIDATE COMES FROM THE GRAPH, AND NO MODEL IS INVOLVED. A candidate is something that
 * already exists — an entity that answers to a similar name, a predicate already used on this
 * subject, a value from a declared vocabulary. That makes this script tier: right by construction,
 * zero tokens, and incapable of inventing an option that does not exist. A model could rank these
 * better; it could also offer a plausible entity nobody has, which is the failure that matters.
 *
 * EVERY CANDIDATE CARRIES ITS REASON, because a shortlist without reasons is a guessing game. "Used
 * with this predicate 14 times" is something a reviewer can judge in a second; a bare list of five
 * IRIs is five more decisions.
 */

import type { Statement, Term } from './types';

/** Which position of the triple is being reconsidered. */
export type Position = 'subject' | 'predicate' | 'object';

export interface Alternative {
  /** The replacement term. */
  term: Term;
  /** Display label — the entity's rdfs:label where it has one, else its local name. */
  label: string;
  /** Why this is a candidate, in words a reviewer can judge. Never a bare score. */
  reason: string;
  /** Ranking weight. Higher is offered first. Reported so an odd order can be argued with. */
  weight: number;
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_ALT = 'http://www.w3.org/2004/02/skos/core#altLabel';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** How many options a person will actually read before the list becomes a wall. */
export const SHORTLIST = 5;

function localName(iri: string): string {
  const tail = iri.split(/[/#]/).pop() ?? iri;
  return tail || iri;
}

/** Loose comparison for names: case, punctuation and separators do not distinguish two spellings. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[_\-\s]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function isActive(s: Statement): boolean {
  return s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending';
}

/** Every name an entity answers to: its label, its alt labels, and its local name. */
function namesOf(iri: string, all: readonly Statement[]): string[] {
  const names = [localName(iri)];
  for (const s of all) {
    if (s.s.value !== iri || !isActive(s)) continue;
    if (s.p.value === RDFS_LABEL || s.p.value === SKOS_ALT) names.push(s.o.value);
  }
  return names;
}

function labelOf(iri: string, all: readonly Statement[]): string {
  for (const s of all) {
    if (s.s.value === iri && s.p.value === RDFS_LABEL && isActive(s)) return s.o.value;
  }
  return localName(iri);
}

function typesOf(iri: string, all: readonly Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of all) if (s.s.value === iri && s.p.value === RDF_TYPE && isActive(s)) out.add(s.o.value);
  return out;
}

export interface AlternativesOptions {
  /**
   * Local names of values from declared vocabularies (priority, status, altitude…).
   *
   * Supplied by the caller rather than hardcoded, because the graph publishes them as SKOS concept
   * schemes and a second copy here would drift. Used for the value-hub case below.
   */
  vocabularyValues?: ReadonlySet<string>;
  limit?: number;
}

/**
 * Alternatives for one position of one statement.
 *
 * Ranked by how much evidence the graph offers for the swap, not by string distance alone — an
 * entity that already appears with this exact predicate is a much better suggestion than one whose
 * name merely looks similar.
 */
export function alternativesFor(
  statement: Statement,
  position: Position,
  all: readonly Statement[],
  opts: AlternativesOptions = {},
): Alternative[] {
  const limit = opts.limit ?? SHORTLIST;
  const current = position === 'subject' ? statement.s : position === 'predicate' ? statement.p : statement.o;
  const found = new Map<string, Alternative>();
  const add = (a: Alternative) => {
    const key = `${a.term.kind}:${a.term.value}`;
    const prior = found.get(key);
    if (!prior || a.weight > prior.weight) found.set(key, a);
  };

  if (position === 'predicate') {
    /*
     * PREDICATES ALREADY USED ON THIS SUBJECT COME FIRST. If the graph says this entity has a
     * `has-status`, then `has-status` is a far likelier intent than a predicate that merely shares
     * a word — the subject's own history is the strongest evidence available.
     */
    /*
     * FILTERED BY OBJECT SHAPE, because "used on this subject" alone is too eager. Probed against
     * the real roadmap graph (5,868 statements) it offered `label` and `type` as alternatives to
     * `depends-on` — both genuinely used on that subject and neither a possible replacement, since
     * `depends-on` relates two entities and `label` carries text. A predicate is only a candidate
     * if it is used with the same KIND of object as the one in hand. That is a deterministic test
     * and it removed most of the noise.
     */
    const wantKind = statement.o.kind;
    const kindOf = new Map<string, Set<string>>();
    for (const s of all) {
      if (!isActive(s)) continue;
      const set = kindOf.get(s.p.value) ?? new Set<string>();
      set.add(s.o.kind);
      kindOf.set(s.p.value, set);
    }
    const shapeFits = (iri: string) => kindOf.get(iri)?.has(wantKind) ?? false;

    const onSubject = new Map<string, number>();
    const everywhere = new Map<string, number>();
    for (const s of all) {
      if (!isActive(s) || !shapeFits(s.p.value)) continue;
      everywhere.set(s.p.value, (everywhere.get(s.p.value) ?? 0) + 1);
      if (s.s.value === statement.s.value) onSubject.set(s.p.value, (onSubject.get(s.p.value) ?? 0) + 1);
    }
    const currentWords = new Set(normalizeName(localName(current.value)).split(' ').filter(Boolean));
    for (const [iri, count] of onSubject) {
      if (iri === current.value) continue;
      add({
        term: { kind: 'iri', value: iri },
        label: localName(iri),
        reason: `already used on this subject ${count} time${count === 1 ? '' : 's'}, with the same kind of value`,
        weight: 100 + count,
      });
    }
    for (const [iri, count] of everywhere) {
      if (iri === current.value) continue;
      const words = new Set(normalizeName(localName(iri)).split(' ').filter(Boolean));
      const shared = [...currentWords].filter((w) => words.has(w)).length;
      if (shared === 0) continue;
      add({
        term: { kind: 'iri', value: iri },
        label: localName(iri),
        reason: `shares wording with the current predicate; used ${count} time${count === 1 ? '' : 's'} in this graph`,
        weight: 10 * shared + Math.min(5, count),
      });
    }
    return [...found.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
  }

  // ── subject / object ──────────────────────────────────────────────────────

  /*
   * THE VALUE-HUB CASE, OFFERED AS A CORRECTION RATHER THAN A LINT ERROR. If the term is an IRI
   * whose name is a value from a declared vocabulary, the likeliest intent is the LITERAL — this is
   * exactly the confusion Matt hit on 2026-09-10, meeting a node called "high" and only working out
   * later that it was a priority. graph-lint now refuses this shape in the corpus; offering the fix
   * at review time is how it gets caught before it is ever written.
   */
  if (current.kind === 'iri' && opts.vocabularyValues?.has(localName(current.value).toLowerCase())) {
    add({
      term: { kind: 'literal', value: localName(current.value) },
      label: `"${localName(current.value)}" (a plain value, not an entity)`,
      reason: 'this name is a value from a declared vocabulary — as an entity it becomes a hub that reads like a key concept',
      weight: 1000,
    });
  }

  const currentNames = current.kind === 'iri' ? namesOf(current.value, all).map(normalizeName) : [normalizeName(current.value)];
  const currentTypes = current.kind === 'iri' ? typesOf(current.value, all) : new Set<string>();

  // Candidate entities: everything that is a subject somewhere, which is what "an entity" means here.
  const entities = new Set<string>();
  for (const s of all) if (isActive(s) && s.s.kind === 'iri') entities.add(s.s.value);

  for (const iri of entities) {
    if (iri === current.value) continue;

    // Name overlap: does this entity answer to a name the current term also answers to?
    const names = namesOf(iri, all).map(normalizeName);
    const exact = names.some((n) => currentNames.includes(n));
    const partial = !exact && names.some((n) => currentNames.some((c) => c && (n.includes(c) || c.includes(n))));

    if (exact) {
      add({
        term: { kind: 'iri', value: iri },
        label: labelOf(iri, all),
        reason: 'answers to the same name — these may be the same thing under two IRIs',
        weight: 200,
      });
      continue;
    }

    // Used in this position with this predicate before: strong positional evidence.
    const samePredicate = all.filter((s) =>
      isActive(s) && s.p.value === statement.p.value
      && (position === 'object' ? s.o.value === iri : s.s.value === iri)).length;
    if (samePredicate > 0) {
      add({
        term: { kind: 'iri', value: iri },
        label: labelOf(iri, all),
        reason: `appears in this position with "${localName(statement.p.value)}" ${samePredicate} time${samePredicate === 1 ? '' : 's'}`,
        weight: 50 + samePredicate,
      });
      continue;
    }

    if (partial) {
      add({
        term: { kind: 'iri', value: iri },
        label: labelOf(iri, all),
        reason: 'name overlaps the current one',
        weight: 20,
      });
      continue;
    }

    // Same type as the current term: a weak signal, offered last and only when it is all there is.
    const shared = [...typesOf(iri, all)].filter((t) => currentTypes.has(t));
    if (shared.length > 0) {
      add({
        term: { kind: 'iri', value: iri },
        label: labelOf(iri, all),
        reason: `same type (${localName(shared[0])}) as the current one`,
        weight: 5,
      });
    }
  }

  return [...found.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/** All three positions at once, for a click that opens the whole triple. */
export function alternativesForStatement(
  statement: Statement,
  all: readonly Statement[],
  opts: AlternativesOptions = {},
): Record<Position, Alternative[]> {
  return {
    subject: alternativesFor(statement, 'subject', all, opts),
    predicate: alternativesFor(statement, 'predicate', all, opts),
    object: alternativesFor(statement, 'object', all, opts),
  };
}
