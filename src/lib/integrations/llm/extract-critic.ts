/**
 * THINKING MODE — a second pass that reads the source AGAINST the facts already extracted, and
 * looks for what the first pass walked past (F146, "extract-then-critic").
 *
 * Matt, 2026-09-04: "I think we need some comparison loop, from original content being added, and
 * the defined facts. Potentially a second pass is needed to pick up smaller details? I want a
 * 'thinking' mode for this extraction, in the effect it may take longer, but be a better result."
 *
 * WHY A CRITIC AND NOT JUST A BIGGER PROMPT. A single extraction pass reads a document once and
 * emits what it noticed. What it did NOT notice is invisible to it — there is no signal in its own
 * output saying "a clause went by unrecorded", so asking the same prompt again produces roughly the
 * same triples. The critic changes the question. It is shown the source AND the extraction, and
 * asked the one thing the first pass could not be asked: what is in the text that is not in this
 * list? That is a comparison, not a re-run, and comparison is a much easier task than recall.
 *
 * The roadmap names this shape directly (kb:extraction-strategies): "a two-pass extract-then-critic"
 * is one of the five candidate strategies, and kb:ref-ontocast is recorded as the comparator whose
 * CRITIC STAGE "is the shape of a second strategy that is not merely a second prompt."
 *
 * THREE RULES, AND THEY ARE WHAT KEEP A SECOND PASS FROM MAKING THINGS WORSE:
 *
 *  1. IT ADDS, IT NEVER REWRITES. The critic's output is UNIONED with pass one, never substituted
 *     for it. A model asked to "improve" a list will silently drop things it merely liked less, and
 *     a second pass that loses a good fact from the first is a regression sold as a refinement.
 *  2. IT IS ANCHORED TO THE TEXT. Every returned triple needs an excerpt, and `triplesToStatements`
 *     already verifies excerpts against the source (kb:passage-grounding) and drops forged ones.
 *     A critic hunting for "smaller details" is exactly the setting where a model starts inferring
 *     rather than reading, so the existing grounding check is load-bearing here, not incidental.
 *  3. FEWER FACTS IS A VALID ANSWER. An empty critic response means the first pass got everything,
 *     and the prompt says so explicitly. Without that permission a model invents work to look
 *     useful — which converts a quality feature into a noise generator, and the review queue pays.
 *
 * COST IS THE POINT OF IT BEING OPT-IN. This roughly doubles extraction time (two generations
 * instead of one) and it is off by default. Matt asked for a mode that "may take longer, but be a
 * better result" — so it is offered as a choice, at the moment of ingest, rather than imposed.
 *
 * WHETHER IT ACTUALLY HELPS IS AN OPEN QUESTION, AND IT IS MEASURABLE.
 * `scripts/offline/extraction-score.ts --thinking` scores this against the same hand-checked corpus
 * as the single pass. Do not claim thinking mode improves extraction until that number moves —
 * F146 phase 1's principle is explicit that a harness which only ever confirms improvement is a
 * marketing instrument.
 */
import type { ExtractedTriple } from './extractor';
import { ethicsPreambleFor } from '../../safety/content-policy';

/*
 * GATED THE SAME WAY THE EXTRACTOR IS, and the first version was not.
 *
 * `npm run offline:all -- --tier=script` flagged this prompt as UNGATED — no ETHICS_PREAMBLE on
 * any path — because the original comment reasoned that "the caller's system prompt carries it".
 * That was wrong: this prompt REPLACES the caller's system prompt for the second pass rather than
 * appending to it, so the critic pass was the one extraction path with no policy on it at all.
 *
 * 'structured' is the right classification and matches extractor.ts: the critic emits JSON triples
 * that go through the same filterBlockedStatements, which vets every written statement
 * deterministically. Classifying it that way is a decision the policy makes, not a shortcut around
 * it — and an unclassified prompt would default to the fuller remote preamble anyway.
 */
const CRITIC_ETHICS = ethicsPreambleFor('structured');

export const CRITIC_SYSTEM_PROMPT = CRITIC_ETHICS + `You are a fact-extraction CRITIC. You are given a source text and a list of triples already extracted from it. Your only job is to find claims the extraction MISSED.

Rules:
1. Return ONLY triples that are stated in the text and are NOT already in the list.
2. Do not rephrase, correct, merge or re-emit anything already in the list.
3. Every triple must quote the text verbatim in "excerpt". If you cannot quote it, do not return it.
4. Do not infer, conclude, or combine facts. If the text does not say it, it is not a fact.
5. Returning an empty array [] is a correct and expected answer when the extraction is complete.

Look especially for:
- secondary clauses ("X, which is also Y") and lists where only the first item was captured
- attributes stated in passing: dates, locations, quantities, roles, statuses
- a second claim about a subject that already appears in the list
- things the text says are MISSING, UNKNOWN or UNDECIDED — record these as facts about the absence
- who is ASSERTING an opinion, where the text attributes one ("we assess…", "X believes…")

Respond with a JSON array only.`;

/** How much of an existing extraction to show the critic. */
const MAX_LISTED_TRIPLES = 120;

/**
 * Renders the already-extracted triples compactly. Deliberately not JSON: the critic must not be
 * able to copy a line and pass it off as new, and a different shape from the one it is asked to
 * emit makes echoing awkward rather than natural.
 */
export function renderKnownTriples(triples: ExtractedTriple[], limit = MAX_LISTED_TRIPLES): string {
  if (triples.length === 0) return '(nothing was extracted — every fact in the text is missing)';
  const shown = triples.slice(0, limit);
  const lines = shown.map((t, i) => `${i + 1}. ${t.subject} — ${t.predicate} — ${t.object}`);
  if (triples.length > shown.length) {
    lines.push(`… and ${triples.length - shown.length} more (not shown; do not re-emit any of them)`);
  }
  return lines.join('\n');
}

export function buildCriticUserPrompt(
  text: string,
  sourceTitle: string,
  known: ExtractedTriple[],
  vocabularySection = '',
): string {
  return `Source: "${sourceTitle}"

Text:
"""
${text.slice(0, 12_000)}
"""

Already extracted (${known.length} triple${known.length === 1 ? '' : 's'}) — do NOT repeat any of these:
${renderKnownTriples(known)}
${vocabularySection}

What does the text state that is missing from the list above? Respond with a JSON array only.`;
}

/**
 * The identity used to decide "already have it".
 *
 * Loose on purpose — case, spacing, punctuation and a trailing plural are all noise here. The cost
 * asymmetry is what sets the threshold: a duplicate that slips through becomes a second review row
 * for one fact, while a REAL new fact discarded as a duplicate is invisible and unrecoverable. So
 * this normalizes only what is unambiguously the same string, and does no fuzzy matching at all.
 */
export function tripleKey(t: ExtractedTriple): string {
  const norm = (v: unknown) =>
    String(v ?? '')
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .replace(/s$/, '');
  return [norm(t.subject), norm(t.predicate), norm(t.object)].join('|');
}

export interface CriticMergeResult {
  merged: ExtractedTriple[];
  /** Triples the critic found that pass one missed — the whole value of the second pass. */
  added: ExtractedTriple[];
  /** Critic output discarded as a restatement of something already held. */
  duplicates: number;
}

/**
 * Union of pass one and the critic, first-pass-wins on collision.
 *
 * First-pass-wins matters: when both passes describe the same fact, the first pass's version is the
 * one the rest of the pipeline has already been reasoning about, and preferring the critic's
 * phrasing would make the same input produce different entity slugs depending on a setting.
 */
export function mergeCriticPass(first: ExtractedTriple[], critic: ExtractedTriple[]): CriticMergeResult {
  const seen = new Set(first.map(tripleKey));
  const added: ExtractedTriple[] = [];
  for (const t of critic) {
    const key = tripleKey(t);
    // A critic that returns an empty subject or object has produced a malformed row, not a fact.
    if (!t.subject?.trim() || !t.predicate?.trim() || String(t.object ?? '').trim() === '') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(t);
  }
  return { merged: [...first, ...added], added, duplicates: critic.length - added.length };
}
