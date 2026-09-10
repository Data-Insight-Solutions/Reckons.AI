/**
 * SPOKEN COMMANDS — recognising an intent through a bad transcript (F99).
 *
 * Matt, 2026-09-10: "We need voice commands, specific spoken terms reckognized lol" and "We
 * trigger agent orchestrated tasks, from voice."
 *
 * WHY A GRAMMAR RATHER THAN MORE `if (lower === '…')`. The audio REPL already recognises four
 * phrases by string equality, which works for "stop" and falls apart on everything domain-specific
 * — because SPEECH-TO-TEXT MANGLES THE EXACT WORDS THIS PRODUCT CARES ABOUT MOST. The evidence is
 * Matt's own captured notes, transcribed by the shipping pipeline on 2026-09-10:
 *
 *     "ViaVoice, the… Nate and server should be able to relay both bi-directional integration"
 *
 * That is "via voice" and "n8n server". Neither survives an equality check, and no amount of
 * adding more `===` branches fixes a transcript that never contains the token being compared. So
 * matching happens after normalisation and alias expansion, and the aliases are the point of the
 * file rather than a detail of it.
 *
 * WHAT THIS MODULE WILL NOT DO: fire anything consequential on its own. A misheard sentence must
 * never launch an agent task, send a document, or write to a graph — see NEEDS_CONFIRMATION and
 * `matchCommand`'s `confirm` result. Read-only commands answer immediately because being wrong
 * costs a wasted sentence; everything else asks first. This is the same boundary the rest of the
 * product runs on: propose, then let a person settle it.
 *
 * It is deliberately dependency-free and pure — a transcript in, a decision out — so it can be
 * tested without a microphone, an STT engine, or a graph.
 */

/** What a matched command is allowed to do without asking. */
export type Consequence =
  /** Reads and answers. Wrong match costs one wasted reply. */
  | 'read'
  /** Changes state, sends something, or starts an agent. Wrong match costs something real. */
  | 'act';

export interface CommandSpec {
  id: string;
  /** Phrases that mean this command. Matched after normalisation, longest first. */
  phrases: string[];
  consequence: Consequence;
  /** Captures the rest of the utterance as an argument (search terms, a note body). */
  takesRest?: boolean;
  /** Spoken back before an `act` command runs. Must state what will happen, not just confirm. */
  confirmPrompt?: (arg?: string) => string;
}

/**
 * TERMS THIS PROJECT'S TRANSCRIPTS ACTUALLY GET WRONG, with what they come out as.
 *
 * Every entry is an OBSERVED mangling from the captured-notes corpus or a predictable homophone of
 * a term the CLI must recognise — not a guess at what might go wrong. Ordered longest-first at use
 * so "n eight n" is consumed before "eight".
 *
 * This table is the maintenance surface of voice support. When a new command word enters the
 * vocabulary, its manglings belong here, and the honest way to find them is to say the word into
 * the real pipeline and read the transcript rather than to imagine what a model would hear.
 */
export const STT_ALIASES: ReadonlyArray<readonly [spoken: string, meant: string]> = [
  // Observed 2026-09-10 in Matt's own captured note.
  ['nate and', 'n8n'],
  ['nate n', 'n8n'],
  ['n eight n', 'n8n'],
  ['and eight and', 'n8n'],
  ['nate', 'n8n'],
  ['via voice', 'voice'],
  ['viavoice', 'voice'],
  // The product's own name, which no STT engine has a prior for.
  ['reckons ai', 'reckons'],
  ['reckon zai', 'reckons'],
  ['reckons a i', 'reckons'],
  ['wreckons', 'reckons'],
  ['reckoning', 'reckon'],
  // Graph vocabulary that sounds like ordinary words.
  ['turtle file', 'ttl'],
  ['t t l', 'ttl'],
  ['tee tee el', 'ttl'],
  ['nano pub', 'nanopub'],
  ['topic stream', 'topik'],
  ['topik stream', 'topik'],
  ['in dico', 'indico'],
  ['indi co', 'indico'],
];

/** Commands that change something. Kept as a set so the table below cannot silently disagree. */
const NEEDS_CONFIRMATION: Consequence = 'act';

export const COMMANDS: readonly CommandSpec[] = [
  // ── Read: answer immediately ───────────────────────────────────────────────
  { id: 'stats', phrases: ['stats', 'status', 'how big is my graph'], consequence: 'read' },
  { id: 'list-graphs', phrases: ['list graphs', 'my graphs', 'which graphs', 'what graphs', 'list kbs', 'my kbs'], consequence: 'read' },
  { id: 'search', phrases: ['search for', 'search', 'find', 'look up'], consequence: 'read', takesRest: true },
  { id: 'entity', phrases: ['tell me about', 'what do i know about', 'entity'], consequence: 'read', takesRest: true },
  { id: 'review-queue', phrases: ['what needs review', 'review queue', 'what is waiting', 'what needs deciding'], consequence: 'read' },
  { id: 'priority', phrases: ['what is my priority', 'what should i do', 'brief me', 'my briefing'], consequence: 'read' },

  // ── Act: confirm first ────────────────────────────────────────────────────
  {
    id: 'capture-note',
    phrases: ['make a note', 'take a note', 'remember that', 'note that'],
    consequence: 'act',
    takesRest: true,
    confirmPrompt: (arg) => `Save a note saying: ${arg ?? '(nothing heard)'}. Say yes to save.`,
  },
  {
    id: 'run-agent-task',
    phrases: ['run the agent', 'start the agent', 'run agent task', 'do the task'],
    consequence: 'act',
    takesRest: true,
    confirmPrompt: (arg) => `Start an agent task: ${arg ?? '(no task heard)'}. This will run on its own. Say yes to start.`,
  },
  {
    id: 'accept-claim',
    phrases: ['accept that', 'confirm that', 'accept the claim'],
    consequence: 'act',
    takesRest: true,
    confirmPrompt: (arg) => `Accept ${arg ?? 'that claim'} into the graph. Say yes to accept.`,
  },
  {
    id: 'publish',
    phrases: ['publish the graph', 'publish this graph', 'share the graph'],
    consequence: 'act',
    confirmPrompt: () => 'Publish this graph, which makes it readable by other people. Say yes to publish.',
  },
];

/** Affirmatives accepted for a pending confirmation. Deliberately short and unambiguous. */
const YES = new Set(['yes', 'yeah', 'yep', 'confirm', 'do it', 'go ahead', 'affirmative', 'correct']);
const NO = new Set(['no', 'nope', 'cancel', 'stop', 'never mind', 'nevermind', 'abort', 'forget it']);

/**
 * Strip what a transcript adds and a matcher should not see: punctuation, casing, filler.
 *
 * FILLER REMOVAL IS DELIBERATELY NARROW. "um" and "uh" are safe to drop because no command
 * contains them. "like" and "so" are NOT dropped even though speech is full of them, because
 * "look up like buttons" is a legitimate search and eating the word changes the query. A
 * normaliser that improves matching by corrupting arguments is a bad trade.
 */
export function normalizeUtterance(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/[.,!?;:"'’]/g, ' ');
  s = s.replace(/\b(um+|uh+|er+|hmm+)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Apply the observed STT manglings, longest phrase first so short ones cannot pre-empt them. */
export function expandAliases(text: string): string {
  let s = text;
  const byLength = [...STT_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [spoken, meant] of byLength) {
    s = s.split(spoken).join(meant);
  }
  return s.replace(/\s+/g, ' ').trim();
}

export interface Match {
  command: CommandSpec;
  /** The remainder of the utterance, when the command takes one. */
  arg?: string;
  /** True when the command must be confirmed out loud before it runs. */
  confirm: boolean;
  /** The phrase that matched, for logging and for telling the user what was heard. */
  matched: string;
}

/**
 * Recognise a command in a transcript, or return null so the caller can fall through to chat.
 *
 * PREFIX-ANCHORED, AND THAT IS A REAL LIMIT WORTH KNOWING. A command must begin the utterance, so
 * "could you please search for badgers" does not match. The alternative — matching a phrase
 * anywhere — makes every sentence containing the word "stop" a quit command, which is worse. The
 * REPL still falls through to the language model, so an unrecognised phrasing is answered rather
 * than refused; it simply costs a model call instead of being free.
 *
 * Longest phrase first, so "search for" beats "search" and the argument does not keep the word.
 */
export function matchCommand(transcript: string, commands: readonly CommandSpec[] = COMMANDS): Match | null {
  const text = expandAliases(normalizeUtterance(transcript));
  if (!text) return null;

  const candidates = commands
    .flatMap((command) => command.phrases.map((phrase) => ({ command, phrase })))
    .sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { command, phrase } of candidates) {
    if (text !== phrase && !text.startsWith(`${phrase} `)) continue;
    const rest = text.slice(phrase.length).trim();
    // A command that needs an argument and did not get one is not a match — it is a fragment, and
    // treating it as a match would fire `run the agent` with no task attached.
    if (command.takesRest && rest === '') return null;
    return {
      command,
      arg: command.takesRest ? rest : undefined,
      confirm: command.consequence === NEEDS_CONFIRMATION,
      matched: phrase,
    };
  }
  return null;
}

export type ConfirmReply = 'yes' | 'no' | 'unclear';

/**
 * Read a spoken answer to a confirmation.
 *
 * ANYTHING THAT IS NOT CLEARLY YES IS NOT A YES. An unrecognised reply returns 'unclear' rather
 * than falling back to either, because the two failure directions are not symmetric: re-asking
 * costs a sentence, and guessing yes runs something the person may not have asked for. Silence,
 * a cough transcribed as "hm", and a half-sentence all land here.
 */
export function readConfirmation(transcript: string): ConfirmReply {
  const t = normalizeUtterance(transcript);
  if (YES.has(t)) return 'yes';
  if (NO.has(t)) return 'no';
  return 'unclear';
}

/** What to say back when a command was heard. Names the action rather than acknowledging vaguely. */
export function describeMatch(m: Match): string {
  if (m.confirm && m.command.confirmPrompt) return m.command.confirmPrompt(m.arg);
  return m.arg ? `${m.command.id}: ${m.arg}` : m.command.id;
}
