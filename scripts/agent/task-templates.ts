/**
 * PRE-APPROVED TASK TEMPLATES (F99.4) — the menu voice is allowed to pick from.
 *
 * Matt, 2026-09-10: "pre approved tasks only through voice and a manual click approval of picked up
 * and defined task", and the type case: "Generate document and email me, is an example of a great
 * pre-approved task."
 *
 * WHY A REGISTRY IS THE SAFETY MECHANISM. An earlier design worried that a transcription error
 * could become an executed command — the capture pipeline turned "n8n" into "Nate" the same
 * evening this was written. A registry removes that rather than containing it: voice SELECTS FROM
 * THIS LIST, so a mishearing picks the wrong PRE-APPROVED task and never an unbounded one. The
 * worst outcome of a bad transcript is a task somebody already judged acceptable, run when it was
 * not wanted.
 *
 * TWO GATES AT DIFFERENT TIMES, and both are needed:
 *   TYPE     approved once here, at design time, by a person reading what it can do.
 *   INSTANCE approved at run time — a task is created `proposed` and a human promotes it to
 *            `open`. Only then does scripts/agent/runner.ts touch it.
 *
 * THE ADMISSION TEST IS ENFORCED, NOT DOCUMENTED. `assertAdmissible` runs over every template in
 * this file and throws on one that does not qualify, so a future template cannot be added by
 * writing a plausible description. The four properties are Matt's, derived from why "email me"
 * qualifies and "email someone else" does not.
 */

/*
 * ── WHICH GRAPH? DO NOT ASK A MODEL. ────────────────────────────────────────────────────────
 *
 * Matt, 2026-09-10: "routing to correct graph may be difficult currently with local models."
 * Correct, and the answer is to stop treating it as an inference problem. A workspace here holds
 * thirty-odd graphs; "generate humanity AI alignment document" names a subject and no destination.
 *
 * THREE WAYS TO SETTLE IT, in order of preference:
 *   1. DETERMINISTIC SCORING, which is a lookup rather than a judgement: does a graph contain the
 *      subject entity, or an entity that aligns to it? kb:qr-relevance (scaffolded) already does
 *      exactly this and cannot hallucinate a match.
 *   2. THE SPEAKER SAYS IT — "in the humanity AI graph, generate…" — which costs four words and
 *      removes the problem entirely.
 *   3. THE APPROVER PICKS, which is free. A task is already waiting for a human click before it
 *      runs, so the graph belongs in that same moment: candidates ranked by (1), the person
 *      confirms or changes it. Routing stops being a guess the system has to get right and becomes
 *      part of a decision somebody is making anyway.
 *
 * So `command` deliberately carries NO graph. A template that guessed one would be asserting the
 * most consequential parameter with the least evidence — and the two-gate design already provides
 * the moment where a person can supply it for nothing.
 */

/** Who receives the output. The single most important property of a template. */
export type Recipient =
  /** The graph's owner, and nobody else. A wrong result is an annoyance in your own inbox. */
  | 'owner'
  /** A third party. A wrong result is a disclosure, and it cannot be recalled. */
  | 'other';

/** What the task does to state that already exists. */
export type Effect =
  /** Only adds. Nothing existing is changed or removed. */
  | 'additive'
  /** Replaces or deletes something. */
  | 'destructive';

export interface TaskTemplate {
  id: string;
  /** Spoken phrases that select this template, matched after normalisation. */
  phrases: string[];
  /** One line stating what it does, shown to the person approving the instance. */
  does: string;
  recipient: Recipient;
  effect: Effect;
  /** True when a wrong result is visible to the person on arrival rather than silent. */
  outputIsReadable: boolean;
  /** The worst realistic outcome, in plain words. Written to be read at approval time. */
  worstCase: string;
  /** The command the runner would execute, with `{arg}` substituted. Never built from the transcript. */
  command: (arg: string) => string;
}

/**
 * THE FOUR PROPERTIES, as an executable test.
 *
 * Matt's reasoning for why "generate a document and email me" is a good pre-approved task, turned
 * into the admission rule for every future one. A candidate that fails any of these is not
 * pre-approvable — it may still be a fine task, it just has to be approved per instance from
 * scratch rather than selected by voice from a menu.
 */
export function admissionFailures(t: TaskTemplate): string[] {
  const failures: string[] = [];
  if (t.recipient !== 'owner') {
    failures.push('recipient is not the owner — a wrong result exposes a third party and cannot be recalled');
  }
  if (t.effect !== 'additive') {
    failures.push('effect is not additive — a wrong result destroys something rather than adding noise');
  }
  if (!t.outputIsReadable) {
    failures.push('output is not readable — a wrong result would be silent, and silence is the failure that costs most');
  }
  if (!t.worstCase.trim()) {
    failures.push('no worst case stated — if nobody has written down what going wrong looks like, nobody has thought about it');
  }
  return failures;
}

/** Throw on any inadmissible template. Called at module load, so a bad addition fails loudly. */
export function assertAdmissible(templates: readonly TaskTemplate[]): void {
  const problems = templates.flatMap((t) => admissionFailures(t).map((f) => `  ${t.id}: ${f}`));
  if (problems.length > 0) {
    throw new Error(
      'Inadmissible pre-approved task template(s) — voice must not be able to select these:\n'
      + problems.join('\n')
      + '\n\nA template failing the admission test can still be a task; it just cannot be pre-approved.',
    );
  }
}

export const TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'generate-document-email-me',
    /*
     * ORDER AND SHAPE BOTH COME FROM A REAL TRANSCRIPT, not from imagination. The note that
     * prompted this template reads "Generate humanity AI alignment document." — subject in the
     * MIDDLE and "document" at the END, which none of the invented "generate a document about X"
     * phrasings matched. The bare 'generate' entry is what catches how a person actually speaks;
     * the longer entries still win when they are present, because matching is longest-first.
     */
    phrases: [
      'generate a document about', 'generate document about',
      'write me a document about', 'draft a document about',
      'generate a document', 'generate document',
      'generate', 'draft', 'write me',
    ],
    does: 'Draft a document from the graph and email it to you.',
    recipient: 'owner',
    effect: 'additive',
    outputIsReadable: true,
    worstCase: 'A useless or wrong document arrives in your own inbox, and you delete it.',
    // The subject is passed as an ARGUMENT, never interpolated into a shell string, so a transcript
    // cannot become part of the command itself.
    command: (arg) => `npm run agent:document -- --subject=${JSON.stringify(arg)} --deliver=email-owner`,
  },
  {
    id: 'review-requirements',
    phrases: [
      'review every requirement for', 'check every requirement for',
      'determine viability for', 'assess viability for',
    ],
    does: 'Read a set of stated requirements against the graph and report which are met, unmet or unknown — as a document emailed to you.',
    recipient: 'owner',
    effect: 'additive',
    outputIsReadable: true,
    worstCase: 'A report that misjudges a requirement. It is read by you before it informs anything, and it changes no state.',
    command: (arg) => `npm run agent:requirements -- --against=${JSON.stringify(arg)} --deliver=email-owner`,
  },
  {
    id: 'summarise-graph',
    phrases: ['summarise the graph', 'summarize the graph', 'brief me on', 'summarise'],
    does: 'Summarise a graph or a slice of one and email it to you.',
    recipient: 'owner',
    effect: 'additive',
    outputIsReadable: true,
    worstCase: 'A shallow summary in your inbox.',
    command: (arg) => `npm run agent:summarise -- --scope=${JSON.stringify(arg)} --deliver=email-owner`,
  },
];

// Enforced at load. A template that fails the test cannot ship, even if someone writes a
// convincing `does` line for it.
assertAdmissible(TEMPLATES);

export interface TemplateMatch {
  template: TaskTemplate;
  /** The subject or scope spoken after the phrase. */
  arg: string;
  matched: string;
}

/** Normalise a transcript for matching: lowercase, punctuation and filler out. */
export function normalize(text: string): string {
  return text.toLowerCase()
    .replace(/[.,!?;:"'’]/g, ' ')
    .replace(/\b(um+|uh+|er+|hmm+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Select a template from a spoken note, or return null.
 *
 * PREFIX-ANCHORED AND ARGUMENT-REQUIRED, for the same reasons the voice grammar is: a template
 * mentioned mid-sentence is not a request, and a template with no subject is a fragment. "Generate
 * a document" with nothing after it must not create a task about nothing.
 *
 * Longest phrase first, so "generate a document about" beats "generate a document" and the argument
 * does not keep the word "about".
 */
export function matchTemplate(
  transcript: string,
  templates: readonly TaskTemplate[] = TEMPLATES,
): TemplateMatch | null {
  const text = normalize(transcript);
  if (!text) return null;
  const candidates = templates
    .flatMap((template) => template.phrases.map((phrase) => ({ template, phrase })))
    .sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { template, phrase } of candidates) {
    if (!text.startsWith(`${phrase} `) && text !== phrase) continue;
    const arg = text.slice(phrase.length).trim();
    if (!arg) return null;   // a template with no subject is a fragment, not a request
    return { template, arg, matched: phrase };
  }
  return null;
}

/** What the person approving the INSTANCE needs to read. States effect and worst case, not just intent. */
export function describeForApproval(m: TemplateMatch): string {
  return [
    `Task: ${m.template.does}`,
    `Subject: ${m.arg}`,
    `Sends to: ${m.template.recipient === 'owner' ? 'you only' : 'a third party'}`,
    `Worst case: ${m.template.worstCase}`,
    `Command: ${m.template.command(m.arg)}`,
  ].join('\n');
}
