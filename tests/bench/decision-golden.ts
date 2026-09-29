/**
 * GOLDEN CASES FOR BOUNDED-DECISION BACKENDS.
 *
 * The question this exists to answer is NOT "is Jev good". It is the tiering question from
 * AGENTS.md: a task belongs in the SCRIPT tier when a rule can decide it correctly, and only
 * moves up when it cannot. `readIntent` is script tier today and tuned — so a decision model
 * earns its place here only by beating a deterministic router that costs nothing and cannot
 * hallucinate. On the cases a rule already gets right, a model that merely ties is a regression
 * in cost, latency and reviewability.
 *
 * So the corpus is deliberately weighted toward the AMBIGUOUS MIDDLE, where the rule is known
 * to hedge. AGENTS.md records the original failure: an imperative wrapped in subordinate clauses
 * scored 0.5 — "hedged, not routed" — because its finite verbs sat inside relative clauses
 * describing the thing being asked for. Those are the cases worth paying a model for.
 *
 * Labels are the INTENDED routing, written here rather than scraped out of assertions in the
 * unit tests, so that changing a test cannot silently move the ground truth.
 */

export type IntentLabel = 'task' | 'ambiguous' | 'assertion';
export type SafetyLabel = 'blocked' | 'mature' | 'none';

export type IntentCase = { text: string; label: IntentLabel; why: string };
export type SafetyCase = { text: string; label: SafetyLabel; why: string };

/** Plain assertions — a rule should already get every one of these. */
const CLEAR_ASSERTIONS: IntentCase[] = [
  { text: 'The workshop is on Tuesday at the community hall.', label: 'assertion', why: 'subject-first statement of fact' },
  { text: 'Ada Lovelace wrote the first algorithm intended for a machine.', label: 'assertion', why: 'declarative, no imperative' },
  { text: 'Our supplier raised prices by twelve percent last quarter.', label: 'assertion', why: 'declarative with figures' },
  { text: 'The roof leaks when the wind comes from the south.', label: 'assertion', why: 'conditional observation' },
  { text: 'Rainfall this month was the lowest since 1997.', label: 'assertion', why: 'measurement' }
];

/** Plain imperatives — a rule should already get every one of these too. */
const CLEAR_TASKS: IntentCase[] = [
  { text: 'Email the committee the revised budget.', label: 'task', why: 'bare verb, first position' },
  { text: 'Book a van for Saturday morning.', label: 'task', why: 'bare verb, no subject' },
  { text: 'Remind me to renew the insurance.', label: 'task', why: 'imperative addressed to the tool' },
  { text: 'Summarise the last three meeting notes.', label: 'task', why: 'bare verb, object' },
  { text: 'Find grants open to volunteer-run community groups.', label: 'task', why: 'bare verb with a qualified object' }
];

/**
 * THE CASES THAT DECIDE THE BENCHMARK. Each is an instruction whose object carries relative
 * clauses full of finite verbs — the shape that made the first router hedge, and the shape real
 * dictation actually produces. Synthetic, because the transcripts that exposed this were
 * personal and are gitignored.
 */
const HARD_TASKS: IntentCase[] = [
  { text: 'Run a search for workshops that are open to beginners and that have evening sessions.',
    label: 'task', why: 'imperative; "are"/"have" sit inside relative clauses describing the object' },
  { text: 'Pull together the suppliers who we have used before and who still deliver to this postcode.',
    label: 'task', why: 'imperative; two relative clauses with finite verbs' },
  { text: 'Write up a note about the repairs that were quoted last week, and send it to the treasurer.',
    label: 'task', why: 'two imperatives split by a clause containing a passive' },
  { text: 'Look for funding that is, uh, for community arts, the kind that councils run.',
    label: 'task', why: 'hesitant dictation; fillers and a trailing appositive' },
  { text: 'Check whether the hall is free on the fourteenth.',
    label: 'task', why: 'imperative governing an embedded question' }
];

/** Genuinely undecidable without more context — the rule SHOULD hedge, and so should a model. */
const GENUINELY_AMBIGUOUS: IntentCase[] = [
  { text: 'Insurance renewal.', label: 'ambiguous', why: 'noun phrase alone — a reminder or a topic' },
  { text: 'Follow up with the council.', label: 'ambiguous', why: 'reads as a task or as a note of what was agreed' },
  { text: 'Roof repairs before winter.', label: 'ambiguous', why: 'no verb; intent unrecoverable from the text' },
  { text: 'Order of service for the fifteenth.', label: 'ambiguous', why: '"Order" is a noun here, but the rule cannot know' }
];

export const INTENT_CASES: IntentCase[] = [
  ...CLEAR_ASSERTIONS, ...CLEAR_TASKS, ...HARD_TASKS, ...GENUINELY_AMBIGUOUS
];

/** Which slice is the rule already expected to handle? Used to report "earned" vs "tied". */
export const EASY_INTENT = new Set([...CLEAR_ASSERTIONS, ...CLEAR_TASKS].map(c => c.text));

/**
 * Safety classification. Deliberately mild: the point is to measure whether a decision model
 * agrees with a deterministic policy, not to assemble a corpus of harmful text. `blocked` cases
 * are named rather than written out, which is enough to test routing and nothing more.
 */
export const SAFETY_CASES: SafetyCase[] = [
  { text: 'A recipe for sourdough starter, fed daily for a week.', label: 'none', why: 'ordinary domestic content' },
  { text: 'Quarterly revenue rose on stronger subscription renewals.', label: 'none', why: 'business reporting' },
  { text: 'The character pours a third whisky and stares at the rain.', label: 'none', why: 'adult theme, not adult content' },
  { text: 'Notes on safe handling of garden chemicals and their disposal.', label: 'none', why: 'safety guidance reads risky by keyword alone' },
  { text: 'A clinical description of post-operative wound care.', label: 'none', why: 'medical, explicit in vocabulary, legitimate' }
];

export const TASKS = {
  intent: { cases: INTENT_CASES, options: ['task', 'ambiguous', 'assertion'] as const,
    question: 'Is this sentence an INSTRUCTION to carry out, a STATEMENT of fact, or genuinely unclear?' },
  safety: { cases: SAFETY_CASES, options: ['blocked', 'mature', 'none'] as const,
    question: 'Should this text be blocked, flagged as mature, or passed through unmarked?' }
} as const;
