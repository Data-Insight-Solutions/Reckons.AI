/**
 * Some dictated sentences are not facts. They are instructions.
 *
 * THE FAILURE THIS PREVENTS. "Run research on grants for kids sports like swimming for city park
 * and rec" went through the ordinary extractor, which is a machine for turning prose into
 * assertions and has no other mode. It cannot say "this asserts nothing", so it invents:
 * `research has-subject grants`, `kids-sports includes swimming`. Every one of those is a claim
 * about the world that the speaker never made, and the thing they DID say — go and find something
 * out — is nowhere in the graph. A request for work extracted as a fact is lost twice: the work is
 * not queued, and the graph gains sentences nobody said.
 *
 * A TASK VOCABULARY ALREADY EXISTS (F87 / kb:orch-task-vocab, `rdf/agent-task.ts`). This module is
 * only the router: it decides which of the two existing paths a dictated sentence belongs on.
 *
 * WHY A RULE AND NOT A PROMPT, following `triple-shape.ts`. The extractor is already being asked
 * to emit triples; asking it in the same breath to notice that there are none is asking it to
 * argue against its own job. English commands have a shape a rule can see — a bare verb in first
 * position with no subject in front of it — so this is script tier: free, explainable, identical
 * under every backend, and it runs BEFORE the model, which means a note that is wholly an
 * instruction costs no extraction call at all.
 *
 * THE HARD CASE IS A NOUN THAT IS ALSO A VERB. "Research shows enterprise DAMs are consolidating"
 * opens with `research`, and so does the example above. The discriminator is what follows: a
 * finite verb in second position means the first word was the SUBJECT of an assertion, not a
 * command. That single check carries most of the precision here.
 *
 * NOTHING IS DECIDED HERE — THREE BANDS, AND THE MIDDLE ONE DOES BOTH. A confident reading routes
 * one way; an uncertain sentence is proposed as a task AND extracted as prose, both pending, and
 * the human keeps whichever is right. That is the same bet `vocabulary-repair.ts` makes and for
 * the same reason: on a transcript, approval is the feature. What this module must never do is
 * silently drop a sentence — every sentence of the note reaches at least one path.
 */

/** Which reading of a sentence the rules support. */
export type NoteIntent = 'task' | 'ambiguous' | 'assertion';

export type IntentReading = {
  /** The sentence, verbatim. A goal is never paraphrased — see `buildTaskProposals`. */
  sentence: string;
  intent: NoteIntent;
  /** Strength of the command reading, 0-1. Carried onto the proposal as its confidence. */
  score: number;
  /** Which rules fired, in words a review card can show. Never let a routing go unexplained. */
  signals: string[];
};

/** At or above this, the sentence is read as an instruction and is not sent to the extractor. */
export const TASK_THRESHOLD = 0.6;
/** At or above this, the sentence goes down BOTH paths and a human keeps one. */
export const AMBIGUOUS_THRESHOLD = 0.3;

/**
 * Bare verbs that open a command.
 *
 * Bare form ONLY, and that restriction is doing real work: "runs", "emailed" and "checking" can
 * never open an English imperative, so leaving them out costs nothing and removes a whole class of
 * false positive ("Orange Logic runs on AWS").
 */
const IMPERATIVE_OPENERS = new Set([
  'run', 'research', 'find', 'check', 'draft', 'write', 'email', 'call', 'schedule', 'book',
  'compare', 'summarize', 'summarise', 'investigate', 'get', 'pull', 'send', 'add', 'make',
  'build', 'review', 'analyze', 'analyse', 'search', 'ask', 'remind', 'set', 'create', 'update',
  'fix', 'test', 'verify', 'confirm', 'track', 'watch', 'monitor', 'list', 'gather', 'collect',
  'contact', 'apply', 'register', 'sign', 'order', 'buy', 'plan', 'organize', 'organise',
  'prepare', 'estimate', 'price', 'quote', 'measure', 'count', 'read', 'watch', 'explore',
]);

/**
 * Two-word imperatives. Scored slightly higher than a bare opener because the pair is
 * unambiguous — no English noun phrase begins "look into" or "follow up".
 */
const PHRASAL_OPENERS = [
  'look into', 'look up', 'find out', 'check on', 'check with', 'follow up', 'reach out',
  'dig into', 'read up', 'catch up', 'set up', 'write up', 'sign up', 'ask about', 'ask around',
];

/**
 * Ways a person frames a request without using the imperative at all. Anchored to the start of
 * the sentence: "we need to decide" is a request, "the vendor said we need to decide" is a report
 * of one, and only the first should queue work.
 */
const REQUEST_FRAMES: { name: string; re: RegExp }[] = [
  { name: 'remind me', re: /^remind me\b/ },
  { name: "don't forget", re: /^(don'?t|do not) forget\b/ },
  { name: 'please', re: /^please\b/ },
  { name: 'can you', re: /^(can|could|would|will) (you|we)\b/ },
  { name: 'need to', re: /^(i|we) (need|want|have|should|ought)\b/ },
  { name: 'todo', re: /^(todo|to-do|to do|task|action item|next step)s?\b\s*[:\-—]/ },
  { name: "let's", re: /^(let'?s|lets)\b/ },
  { name: 'make sure', re: /^(make sure|ensure|be sure)\b/ },
  { name: 'i should', re: /^(i|we)'(ll|d|ve)\b/ },
];

/**
 * Finite verbs that, in SECOND position, prove the first word was a subject.
 *
 * Only inflected and modal forms belong here. A bare form in second position is usually still part
 * of a command ("go run the numbers"), so including one would break the sentences this module
 * exists to catch.
 */
const FINITE_FOLLOWERS = new Set([
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'must', 'might', 'may',
  'shows', 'showed', 'seems', 'seemed', 'means', 'meant', 'says', 'said',
  'indicates', 'suggests', 'includes', 'requires', 'costs', 'runs', 'goes', 'went',
  'became', 'becomes', 'remains', 'looks', 'sounds', 'appears', 'needs', 'wants',
]);

/**
 * Words that open a subordinate clause, so the finite verb after them is NOT the sentence's main
 * assertion.
 *
 * FOUND ON A REAL DICTATION, 2026-08-28. "Run a research task for new grants or current grants
 * THAT ARE for city Parks and Rec, THAT HAVE childhood activities like swim team" is a command
 * with two relative clauses hanging off its object. Counting `are` and `have` as assertions
 * dragged an obvious instruction down into the hedge band. A verb inside "grants that are…"
 * describes the thing being asked for; it does not state a fact about the world. Longer, more
 * specific requests are exactly the ones that accumulate these clauses, so without this rule the
 * detector got WORSE the more detail the speaker gave — precisely backwards.
 */
const SUBORDINATORS = new Set([
  'that', 'which', 'who', 'whom', 'whose', 'whether', 'if', 'when', 'where', 'while',
  'because', 'since', 'though', 'although', 'unless', 'until',
]);

/**
 * Anything that would otherwise become the first word without being part of the sentence.
 *
 * Dictation is full of these and they are load-bearing in the wrong direction: "Uh, run the
 * numbers" would read `uh` as its opener and score nothing. "Note to self" is stripped for the
 * same reason — it frames the capture, not the content.
 */
const FILLER_PREFIX =
  /^(?:(?:uh|um|erm?|ah|oh|so|ok|okay|alright|right|hey|well|and|also|then|actually|basically)[,\s]+|note to self[:,\s]+|quick note[:,\s]+)+/i;

function stripFillers(sentence: string): string {
  return sentence.replace(FILLER_PREFIX, '').trim();
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Split dictated text into sentences.
 *
 * DELIBERATELY CONSERVATIVE, AND THE LIMITATION IS REAL: dictation frequently arrives with no
 * terminal punctuation at all, and a run-on then reads as ONE sentence. That is the safe way to be
 * wrong. Splitting on conjunctions to find a hidden second clause would cut goals in half and put
 * fragments in the queue, and the goal is stored verbatim precisely so a human can see what was
 * actually said and split it themselves.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How strongly one sentence reads as a request for work. */
export function readIntent(raw: string): IntentReading {
  const sentence = raw.trim();
  const body = stripFillers(sentence);
  const token = words(body);
  const signals: string[] = [];

  if (token.length === 0) {
    signals.push('no words — nothing to route');
    return { sentence, intent: 'assertion', score: 0, signals };
  }

  const pair = token.slice(0, 2).join(' ');
  const phrasal = PHRASAL_OPENERS.includes(pair) ? pair : undefined;
  const frame = REQUEST_FRAMES.find((f) => f.re.test(body.toLowerCase()));
  const opener = IMPERATIVE_OPENERS.has(token[0]) ? token[0] : undefined;

  // The noun-that-is-also-a-verb test, and the reason it comes first: if the opener turns out to
  // be the SUBJECT of a finite verb, no later signal should be able to rescue a command reading.
  // "Research shows…" is a report about research, and a command frame elsewhere in the sentence
  // does not change that.
  if (opener && !phrasal && !frame && FINITE_FOLLOWERS.has(token[1] ?? '')) {
    signals.push(`"${token[0]}" is the subject of "${token[1]}" — this states something`);
    return { sentence, intent: 'assertion', score: 0, signals };
  }

  let score = 0;
  if (frame) {
    score = Math.max(score, 0.6);
    signals.push(`request frame "${frame.name}"`);
  }
  if (phrasal) {
    score = Math.max(score, 0.65);
    signals.push(`phrasal imperative "${phrasal}"`);
  } else if (opener) {
    score = Math.max(score, 0.5);
    signals.push(`imperative opener "${opener}"`);
  }

  // Something was asked for at the front, and nothing is asserted in the MAIN clause. A sentence
  // that states no fact gives the extractor nothing to lose, so the command reading is safe to
  // back. Verbs inside subordinate clauses are skipped — they qualify what is being asked for.
  const asserts = token.some(
    (w, i) => FINITE_FOLLOWERS.has(w) && !SUBORDINATORS.has(token[i - 1] ?? ''),
  );
  if (score > 0 && !asserts) {
    score += 0.25;
    signals.push('no main-clause verb — the sentence asserts nothing');
  }

  // The default path must explain itself too. "Nothing fired" is a real reason and a reviewer
  // asking why a sentence went to the extractor deserves to read it, rather than finding an empty
  // list and having to infer that the rules simply did not match.
  if (signals.length === 0) {
    signals.push('no imperative opener or request frame — read as a statement');
  }

  score = Math.min(1, score);
  const intent: NoteIntent =
    score >= TASK_THRESHOLD ? 'task' : score >= AMBIGUOUS_THRESHOLD ? 'ambiguous' : 'assertion';
  return { sentence, intent, score, signals };
}

export type NoteReading = {
  /** Every sentence, in order, with its reading. */
  readings: IntentReading[];
  /** Sentences to propose as tasks — the confident ones AND the ambiguous ones. */
  tasks: IntentReading[];
  /**
   * The text to send to the extractor: assertions, plus the ambiguous sentences again.
   * Empty when the whole note was an instruction, which is the signal to skip extraction.
   */
  factText: string;
};

/**
 * Route a dictated note.
 *
 * The two outputs OVERLAP on purpose. An ambiguous sentence appears in `tasks` and in `factText`,
 * so an uncertain call produces two pending proposals rather than one silent decision. Nothing is
 * dropped: `tasks` and `factText` together cover every sentence.
 */
export function readNote(text: string): NoteReading {
  const readings = splitSentences(text).map(readIntent);
  return {
    readings,
    tasks: readings.filter((r) => r.intent !== 'assertion'),
    factText: readings
      .filter((r) => r.intent !== 'task')
      .map((r) => r.sentence)
      .join(' ')
      .trim(),
  };
}
