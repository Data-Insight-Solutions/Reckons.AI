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
  /** The clause, verbatim. A goal is never paraphrased — see `buildTaskProposals`. */
  sentence: string;
  /**
   * The whole sentence this clause came from, when it was one of several.
   *
   * The goal is the CLAUSE, so each task says one thing a harness can act on. The full sentence
   * rides along as the excerpt, so the record still shows exactly what was said and a reviewer
   * can see that two tasks came from one breath.
   */
  fullSentence?: string;
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
  // Added 2026-08-28 after "Generate a document about orange logic and email it to me." was
  // read as a STATEMENT and extracted as prose. `create`, `make` and `build` were all present;
  // `generate` was not, and one missing word silently turned a request into invented facts.
  'generate', 'produce', 'publish', 'post', 'share', 'compile', 'extract', 'convert', 'export',
  'upload', 'download', 'fetch', 'translate', 'outline', 'sketch', 'calculate', 'forecast',
  'evaluate', 'assess', 'rank', 'score', 'sort', 'clean', 'rename', 'install', 'deploy',
  'notify', 'message', 'invite', 'reserve', 'cancel', 'subscribe', 'follow',
]);

/**
 * Words that open a noun phrase rather than a command.
 *
 * Used only by the structural fallback below, to keep "New idea for Reckons.AI" — a note — from
 * being read as an instruction just because it happens to contain no finite verb.
 */
const PHRASE_OPENERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'his', 'her', 'their', 'its',
  'i', 'we', 'he', 'she', 'they', 'it', 'you', 'there', 'here',
  'new', 'old', 'another', 'more', 'most', 'some', 'any', 'every', 'each', 'no',
  'in', 'on', 'at', 'for', 'with', 'from', 'about', 'by', 'to', 'of',
]);

/** Coordinators after which a second imperative can begin: "draft X AND email it to me". */
const COORDINATORS = new Set(['and', 'then', 'also', 'plus']);

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
  // Third-person forms are open-ended and this list will always be short of them. It caught
  // "Matthew Roe OWNS Data Insight Solutions" only because the structural fallback below was
  // tightened; these are here because they are common, not because the list is now complete.
  'owns', 'uses', 'makes', 'provides', 'offers', 'sells', 'builds', 'holds', 'keeps', 'works',
  'lives', 'comes', 'gets', 'takes', 'gives', 'leads', 'serves', 'supports', 'covers', 'contains',
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
 * Split one sentence into separate imperative clauses.
 *
 * Matt, 2026-08-28: "Actually multiple agent tasks, generate document, and email me." He is right —
 * "Generate a document about orange logic AND EMAIL IT TO ME" is two pieces of work, and one task
 * carrying both has a `done-when` nobody could write.
 *
 * THIS REVERSES A DELIBERATE EARLIER DECISION, recorded in splitSentences below, so the reasoning
 * behind that decision is worth keeping rather than deleting: splitting on conjunctions IN GENERAL
 * would cut goals in half and put fragments in the queue. The narrow version is safe because it
 * cuts only where the coordinator is followed by a word this module already recognises as a
 * command — "and email", never "and rec". A fragment does not begin with a known imperative verb,
 * so the risk that comment names is precisely the case this rule excludes.
 *
 * The sentence is never lost: every clause carries it as `fullSentence`, and it becomes the
 * excerpt on each proposal, so a reviewer can see that two tasks came from one breath.
 */
export function splitImperativeClauses(sentence: string): string[] {
  const parts = sentence.split(/\s+/);
  const cuts: number[] = [];
  for (let i = 1; i < parts.length - 1; i++) {
    const here = parts[i].toLowerCase().replace(/[^a-z']/g, '');
    const next = parts[i + 1].toLowerCase().replace(/[^a-z']/g, '');
    if (COORDINATORS.has(here) && IMPERATIVE_OPENERS.has(next)) cuts.push(i);
  }
  if (cuts.length === 0) return [sentence];

  const clauses: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    clauses.push(parts.slice(start, cut).join(' ').trim());
    start = cut + 1;   // the coordinator itself belongs to neither clause
  }
  clauses.push(parts.slice(start).join(' ').trim());
  return clauses.filter(Boolean);
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

  // A SECOND IMPERATIVE AFTER A COORDINATOR. "Generate a document ... AND EMAIL it to me" is one
  // request with two verbs, and the second one is often the recognisable half. This is redundancy
  // against holes in the lexicon above: it takes two unknown verbs to lose the sentence, not one.
  if (score === 0) {
    const coordinated = token.findIndex(
      (w, i) => i > 0 && COORDINATORS.has(token[i - 1]) && IMPERATIVE_OPENERS.has(w),
    );
    if (coordinated > 0) {
      score = 0.5;
      signals.push(`imperative "${token[coordinated]}" after "${token[coordinated - 1]}"`);
    }
  }

  // Something was asked for at the front, and nothing is asserted in the MAIN clause. A sentence
  // that states no fact gives the extractor nothing to lose, so the command reading is safe to
  // back. Verbs inside subordinate clauses are skipped — they qualify what is being asked for.
  const asserts = token.some(
    (w, i) => FINITE_FOLLOWERS.has(w) && !SUBORDINATORS.has(token[i - 1] ?? ''),
  );

  // THE STRUCTURAL FALLBACK, AND WHY IT ONLY HEDGES. A sentence with no finite verb anywhere,
  // opening on a word that does not begin a noun phrase, is usually an imperative whose verb this
  // module has never heard of. But it is also sometimes a dictated fragment — "New idea for the
  // grants work" — so backing it outright would invent tasks out of notes. It therefore scores
  // into the AMBIGUOUS band, which proposes a task AND extracts the prose: a lexicon hole then
  // costs a hedge a human resolves, instead of silently turning a request into invented facts.
  if (score > 0 && !asserts) {
    score += 0.25;
    signals.push('no main-clause verb — the sentence asserts nothing');
  }
  // THE SHAPE IT LOOKS FOR IS `verb + determiner`, not merely "no finite verb". The first draft
  // asked only whether anything was asserted, and read "Matthew Roe owns Data Insight Solutions"
  // as a possible command — because `owns` is not in the finite list above and never will be
  // reliably, since third-person forms are open-ended. Requiring the SECOND word to open a noun
  // phrase ("generate A document", "frobnicate THE widget") excludes a proper-noun subject
  // outright, and does not depend on knowing the verb at all.
  //
  // IT RUNS AFTER THE BONUS ABOVE AND DOES NOT RECEIVE IT. The bonus rewards "asked for something
  // AND asserts nothing"; this rule's whole premise is already "asserts nothing", so stacking them
  // would count one piece of evidence twice and promote an unknown verb straight to `task`. A verb
  // this module has never seen should HEDGE — that is the point of the rule.
  if (score === 0 && !asserts && !PHRASE_OPENERS.has(token[0]) && PHRASE_OPENERS.has(token[1] ?? '')) {
    score = 0.35;
    signals.push(`"${token[0]}" takes an object and asserts nothing — possibly a verb this module does not know`);
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
  const readings: IntentReading[] = [];
  for (const sentence of splitSentences(text)) {
    const clauses = splitImperativeClauses(sentence);
    for (const clause of clauses) {
      const reading = readIntent(clause);
      readings.push(clauses.length > 1 ? { ...reading, fullSentence: sentence } : reading);
    }
  }
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
