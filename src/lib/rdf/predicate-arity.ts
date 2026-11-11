/**
 * Which predicates hold at most ONE value per subject, MEASURED from the stored facts, never named in a list.
 *
 * Why the app needs it (2026-11-10): the Review card for "same subject and predicate, different
 * object" offered "keep new", which supersedes the existing facts. That is right for a status and
 * destroys facts for a predicate that accumulates (has, part-of, a list). Three accepted `has`
 * links left only the last one alive. Superseding is only licensed when the predicate is measured
 * single-valued; anything unmeasured or unknown is multi-valued, so nothing is replaced on a guess.
 *
 * The rule is the one mcp-server/src/review-session.ts predicateArity uses (that package cannot
 * import from src, so the logic is restated here and a test checks the two agree): a predicate is
 * functional only if no subject holds two objects for it AND it has been seen on at least
 * MIN_SUBJECTS_FOR_FUNCTIONAL subjects. Thin evidence is not evidence.
 */
export type Arity = 'functional' | 'multi';
export const MIN_SUBJECTS_FOR_FUNCTIONAL = 8;

/** The comparable part of a predicate IRI (`kpred:x`, `urn:kbase:predicate/x` and `x` agree). */
export function localName(iri: string): string {
  const tail = iri.split(/[/#]/).pop() ?? iri;
  return (tail.includes(':') ? tail.split(':').pop()! : tail).trim();
}

export function predicateArity(
  triples: readonly { subject: string; predicate: string; object: string }[],
): Map<string, Arity> {
  const objects = new Map<string, Set<string>>();
  for (const t of triples) {
    const key = JSON.stringify([t.subject, localName(t.predicate)]);
    let set = objects.get(key);
    if (!set) objects.set(key, (set = new Set()));
    set.add(t.object);
  }
  const plural = new Set<string>();
  const subjects = new Map<string, number>();
  for (const [key, values] of objects) {
    const [, predicate] = JSON.parse(key) as [string, string];
    subjects.set(predicate, (subjects.get(predicate) ?? 0) + 1);
    if (values.size > 1) plural.add(predicate);
  }
  const arity = new Map<string, Arity>();
  for (const [p, count] of subjects) arity.set(p, !plural.has(p) && count >= MIN_SUBJECTS_FOR_FUNCTIONAL ? 'functional' : 'multi');
  return arity;
}

/** Is replacing an existing object with a different one licensed for this predicate? Unknown: no. */
export function isSingleValued(arity: ReadonlyMap<string, Arity>, predicateIri: string): boolean {
  return arity.get(localName(predicateIri)) === 'functional';
}
