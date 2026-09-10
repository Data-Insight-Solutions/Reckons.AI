/**
 * Catching a triple that a model collapsed into one node.
 *
 * THE FAILURE, OBSERVED 2026-08-27. Dictating "Orange Logic is an enterprise DAM" produced the
 * entity `orange-logic-is-an-enterprise-dam`. The whole proposition became the SUBJECT, and the
 * relation it states was never extracted at all. `validateExtractedTriples` waved it through
 * because that function checks TYPES — is the subject a non-empty string? — and a sentence is a
 * perfectly good string.
 *
 * WHY A RULE AND NOT A BETTER PROMPT. The prompt already says to emit subject/predicate/object,
 * and a model that ignores it will keep ignoring it. This is checkable by a rule: a name does not
 * contain a finite verb. "Orange Logic" is a name; "Orange Logic is an enterprise DAM" is a claim
 * about one. So this is script tier — deterministic, free, and right by construction rather than
 * right on average. It holds whichever model is behind the extractor, including a future one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not try to REPAIR the collapsed triple by splitting it
 * on the verb. That would be inventing a fact from a parse — the model's failure would become the
 * graph's content, with nothing marking it as a guess. Rejecting is honest and cheap: the note is
 * kept verbatim, so re-extraction is always available.
 *
 * FALSE POSITIVES ARE THE REAL RISK, so the test is narrow. Long names are fine ("Data Insight
 * Solutions, LLC"). Names containing prepositions are fine ("Bank of America", "Museum of Modern
 * Art"). Only a COPULA OR OTHER FINITE VERB sitting between two content words makes a string a
 * proposition rather than a name.
 */

/**
 * Verbs that turn a name into a claim. Deliberately short: every entry is a word that cannot
 * appear inside an ordinary entity name without the string having become a sentence.
 *
 * "has" and "have" are included because `x-has-y` is the single most common way a model collapses
 * a triple whose predicate was `has-*`.
 */
const FINITE_VERBS = [
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had',
  'does', 'do', 'did',
  'owns', 'owned', 'uses', 'used', 'makes', 'made',
  'will', 'would', 'should', 'could', 'can',
  'includes', 'contains', 'provides', 'requires', 'supports',
  'became', 'becomes', 'costs', 'runs',
];

const VERB_SET = new Set(FINITE_VERBS);

/** Split a slug or phrase into lowercase word tokens. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when a string reads as a CLAIM rather than a NAME.
 *
 * Requires a finite verb with at least one content word on each side: "is-a" alone is a predicate
 * and perfectly legitimate, while "orange-logic-is-an-enterprise-dam" is a sentence wearing a
 * slug's clothes.
 */
export function looksLikeProposition(value: string): boolean {
  const words = tokens(value);
  if (words.length < 3) return false;

  for (let i = 1; i < words.length - 1; i++) {
    if (!VERB_SET.has(words[i])) continue;
    // Something must be said ABOUT something: a verb at either edge is not a proposition,
    // which keeps predicate-shaped strings like "is-a" and "used-by" out of this.
    const before = words.slice(0, i).some((w) => !VERB_SET.has(w));
    const after = words.slice(i + 1).some((w) => !VERB_SET.has(w));
    if (before && after) return true;
  }
  return false;
}

/**
 * True when the subject appears to have swallowed the predicate or the object.
 *
 * A second, independent signal for the same failure: even where no verb is present, a subject
 * containing the predicate's words plus the object's words is one node standing where three
 * should be.
 */
export function subjectSwallowedTriple(
  subject: string,
  predicate: string,
  object: string,
): boolean {
  const subjectWords = new Set(tokens(subject));
  if (subjectWords.size < 3) return false;

  const contentOf = (v: string) => tokens(v).filter((w) => w.length > 2 && !VERB_SET.has(w));
  const predicateWords = contentOf(predicate);
  const objectWords = contentOf(object);
  if (predicateWords.length === 0 || objectWords.length === 0) return false;

  const covers = (words: string[]) => words.every((w) => subjectWords.has(w));
  return covers(predicateWords) && covers(objectWords);
}

export type ShapeRejection = {
  subject: string;
  predicate: string;
  object: string;
  reason: 'subject-is-a-proposition' | 'subject-swallowed-triple' | 'predicate-is-a-proposition';
};

export type ShapeCheckResult<T> = {
  triples: T[];
  rejected: ShapeRejection[];
};

/**
 * Drop triples whose subject or predicate is a collapsed proposition.
 *
 * Returns the rejections rather than only a count, so the caller can SAY what was thrown away.
 * A silent drop here would look identical to a model that simply found nothing in the sentence.
 */
export function rejectCollapsedTriples<
  T extends { subject: string; predicate: string; object: unknown },
>(triples: T[]): ShapeCheckResult<T> {
  const kept: T[] = [];
  const rejected: ShapeRejection[] = [];

  for (const t of triples) {
    const object = typeof t.object === 'string' ? t.object : String(t.object ?? '');
    const record = { subject: t.subject, predicate: t.predicate, object };

    if (looksLikeProposition(t.subject)) {
      rejected.push({ ...record, reason: 'subject-is-a-proposition' });
      continue;
    }
    if (looksLikeProposition(t.predicate)) {
      rejected.push({ ...record, reason: 'predicate-is-a-proposition' });
      continue;
    }
    if (subjectSwallowedTriple(t.subject, t.predicate, object)) {
      rejected.push({ ...record, reason: 'subject-swallowed-triple' });
      continue;
    }
    kept.push(t);
  }

  return { triples: kept, rejected };
}
