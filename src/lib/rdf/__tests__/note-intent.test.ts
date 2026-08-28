import { describe, it, expect } from 'vitest';
import { readIntent, readNote, splitSentences } from '../note-intent';
import {
  buildTaskProposals,
  TASK_GOAL,
  TASK_STATE,
  TASK_IRI_PREFIX,
  EXTRACTED_FROM,
  CAPTURED_NOTE,
  type CapturedNote,
} from '../captured-notes';
import { AGENT_TASK_TYPE, parseTasks, blockedReason, runnableTasks } from '../agent-task';
import type { Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let n = 0;
const nextId = () => `id${n++}`;

const NOTE_IRI = 'urn:kbase:concept/note-2026-08-28T09-12-00-000Z';
const template = {
  g: { kind: 'iri' as const, value: 'urn:kbase:graph/personal-notes' },
  sourceId: 'src-1',
};

function note(text: string): CapturedNote {
  const statement: Statement = {
    id: nextId(),
    s: { kind: 'iri', value: NOTE_IRI },
    p: { kind: 'iri', value: CAPTURED_NOTE },
    o: { kind: 'literal', value: text },
    g: template.g,
    sourceId: template.sourceId,
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
  return { iri: NOTE_IRI, text, statement };
}

// The sentence that started this: dictated into a ring, and not a fact about anything.
const THE_NOTE = 'run research on grants for kids sports like swimming for city park and rec';

describe('readIntent — requests for work', () => {
  it('reads the dictated grants note as a task', () => {
    const r = readIntent(THE_NOTE);
    expect(r.intent).toBe('task');
    expect(r.signals.join(' ')).toContain('imperative opener "run"');
  });

  it.each([
    'remind me to call the parks department about deadlines',
    'look into whether Orange Logic is a private company',
    'email the board about the grant application',
    "todo: get quotes from three vendors",
    "let's compare Primo and Binder",
    'we need to decide on TanStack Table',
    'please schedule a call with the rec center',
  ])('reads %j as a task', (sentence) => {
    expect(readIntent(sentence).intent).toBe('task');
  });

  it('strips dictation fillers before looking at the first word', () => {
    expect(readIntent('Uh, run the numbers on the swim program').intent).toBe('task');
    expect(readIntent('Note to self: email the board about the grant').intent).toBe('task');
  });

  it('explains every routing it makes', () => {
    for (const r of [readIntent(THE_NOTE), readIntent('Orange Logic is a private company.')]) {
      expect(r.signals.length).toBeGreaterThan(0);
    }
  });
});

describe('readIntent — assertions', () => {
  it.each([
    'Orange Logic is a private company.',
    'Matthew Rowe owns Data Insight Solutions, LLC.',
    'A primo and binder and open text are potential integrations.',
  ])('reads %j as an assertion', (sentence) => {
    expect(readIntent(sentence).intent).toBe('assertion');
  });

  // The hard case, and the one that carries most of the precision: a noun that is also a verb.
  it('does not mistake a noun subject for a command', () => {
    const r = readIntent('Research shows enterprise DAMs are consolidating');
    expect(r.intent).toBe('assertion');
    expect(r.signals.join(' ')).toContain('subject of "shows"');
  });

  it('reads "Email is down" as an assertion and "Email the board" as a task', () => {
    expect(readIntent('Email is down again').intent).toBe('assertion');
    expect(readIntent('Email the board about the grant').intent).toBe('task');
  });

  it('a command frame later in an assertion does not rescue a command reading', () => {
    expect(readIntent('Research shows we need to move faster').intent).toBe('assertion');
  });

  it('an empty or punctuation-only sentence is an assertion, not a task', () => {
    expect(readIntent('   ').intent).toBe('assertion');
    expect(readIntent('...').intent).toBe('assertion');
  });
});

describe('readIntent — the middle band', () => {
  it('hedges when the sentence both commands and asserts', () => {
    // "costs" is a finite verb, so this could be "check X" or a note about what X costs.
    const r = readIntent('check the swim program costs');
    expect(r.intent).toBe('ambiguous');
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('readNote', () => {
  it('splits a mixed note and sends only the prose to the extractor', () => {
    const r = readNote(
      'Orange Logic is a private company. Run research on grants for kids swimming.',
    );
    expect(r.tasks.map((t) => t.sentence)).toEqual([
      'Run research on grants for kids swimming.',
    ]);
    expect(r.factText).toBe('Orange Logic is a private company.');
  });

  it('leaves nothing for the extractor when the whole note is an instruction', () => {
    expect(readNote(THE_NOTE).factText).toBe('');
  });

  it('sends an ambiguous sentence down BOTH paths', () => {
    const r = readNote('check the swim program costs');
    expect(r.tasks).toHaveLength(1);
    expect(r.factText).toBe('check the swim program costs');
  });

  it('never drops a sentence', () => {
    const text =
      'Orange Logic is a private company. Run research on grants. Check the swim program costs.';
    const r = readNote(text);
    const covered = new Set([...r.tasks.map((t) => t.sentence), ...splitSentences(r.factText)]);
    for (const sentence of splitSentences(text)) expect(covered.has(sentence)).toBe(true);
  });
});

describe('buildTaskProposals', () => {
  const proposals = () => {
    const captured = note(THE_NOTE);
    return buildTaskProposals(captured, readNote(THE_NOTE).tasks, template, nextId, 1_700_000);
  };

  it('stores the goal verbatim — a transcript is never tidied up', () => {
    const [p] = proposals();
    const goal = p.statements.find((s) => s.p.value === TASK_GOAL);
    expect(goal?.o.value).toBe(THE_NOTE);
  });

  it('mints the task outside the concept namespace', () => {
    const [p] = proposals();
    expect(p.iri.startsWith(TASK_IRI_PREFIX)).toBe(true);
  });

  it('is idempotent: re-reading the same note proposes the same task IRI', () => {
    expect(proposals()[0].iri).toBe(proposals()[0].iri);
  });

  it('lands the classification and the goal as PENDING review work', () => {
    const [p] = proposals();
    for (const pred of [RDF_TYPE, TASK_GOAL, TASK_STATE]) {
      expect(p.statements.find((s) => s.p.value === pred)?.status).toBe('pending');
    }
  });

  it('auto-confirms only the provenance link', () => {
    const [p] = proposals();
    const link = p.statements.find((s) => s.p.value === EXTRACTED_FROM);
    expect(link?.status).toBe('confirmed');
    expect(link?.o.value).toBe(NOTE_IRI);
  });

  it('routes the classification to the person who said it', () => {
    const [p] = proposals();
    expect(p.statements.find((s) => s.p.value === RDF_TYPE)?.verifiableBy).toBe('user');
  });

  it('declares NO effects and NO done-when — neither was said', () => {
    const [p] = proposals();
    const predicates = p.statements.map((s) => s.p.value);
    expect(predicates).not.toContain('urn:kbase:predicate/effect');
    expect(predicates).not.toContain('urn:kbase:predicate/done-when');
  });

  it('says in the gloss why an ambiguous sentence is also being extracted', () => {
    const captured = note('check the swim program costs');
    const [p] = buildTaskProposals(
      captured,
      readNote(captured.text).tasks,
      template,
      nextId,
      1_700_000,
    );
    expect(p.statements[0].gloss).toContain('also sent to the extractor');
  });
});

// The whole safety argument in one test: a sentence said into a ring must not become work a
// machine will run. It is refused at the queue, before any harness sees it.
describe('a proposed task is not runnable', () => {
  const parsed = () => {
    const captured = note(THE_NOTE);
    const proposals = buildTaskProposals(
      captured,
      readNote(THE_NOTE).tasks,
      template,
      nextId,
      1_700_000,
    );
    return parseTasks(proposals.flatMap((p) => p.statements));
  };

  it('parses back through the F87 task vocabulary', () => {
    // parseTasks only sees subjects typed ktype:AgentTask, so finding it at all proves the type
    // triple is right — no separate assertion needed for that.
    expect(parsed()).toHaveLength(1);
    const [task] = parsed();
    expect(task.goal).toBe(THE_NOTE);
    expect(task.state).toBe('proposed');
    expect(task.effects).toEqual([]);
    expect(task.doneWhen).toBeUndefined();
  });

  it('is typed as an AgentTask', () => {
    const captured = note(THE_NOTE);
    const [p] = buildTaskProposals(
      captured,
      readNote(THE_NOTE).tasks,
      template,
      nextId,
      1_700_000,
    );
    expect(p.statements.find((s) => s.p.value === RDF_TYPE)?.o.value).toBe(AGENT_TASK_TYPE);
  });

  it('is refused by blockedReason, naming the reason', () => {
    const [task] = parsed();
    const why = blockedReason(task, { now: 1_700_000, resolved: () => true });
    expect(why).toContain('dictated note');
  });

  it('never appears in the runnable set', () => {
    expect(runnableTasks(parsed(), { now: 1_700_000, resolved: () => true })).toEqual([]);
  });

  it('stays refused even if someone later adds effects and a done-when', () => {
    const [task] = parsed();
    const armed = { ...task, effects: ['external-read' as const], doneWhen: 'exit 0' };
    expect(blockedReason(armed, { now: 1_700_000, resolved: () => true })).toContain(
      'dictated note',
    );
  });
});

// The transcript that exposed the subordinate-clause hole, dictated 2026-08-28T13:38:52Z and
// kept verbatim - dictation fillers, comma splices and all. A detector tuned on invented
// sentences is tuned on the wrong distribution.
const REAL_TRANSCRIPT =
  'run a research task for new grants or current grants that are, for city, uh, Parks and Rec, ' +
  'that have, uh, childhood activities, uh, like swim team.';

describe('the real dictation', () => {
  it('reads as a task despite two relative clauses on its object', () => {
    const r = readIntent(REAL_TRANSCRIPT);
    expect(r.intent).toBe('task');
    expect(r.signals.join(' ')).toContain('no main-clause verb');
  });

  it('sends nothing to the extractor', () => {
    expect(readNote(REAL_TRANSCRIPT).factText).toBe('');
  });

  it('keeps the fillers in the goal — the transcript is the record', () => {
    const captured = note(REAL_TRANSCRIPT);
    const [p] = buildTaskProposals(
      captured,
      readNote(REAL_TRANSCRIPT).tasks,
      template,
      nextId,
      1_700_000,
    );
    expect(p.statements.find((s) => s.p.value === TASK_GOAL)?.o.value).toBe(REAL_TRANSCRIPT);
  });

  // A verb in a MAIN clause still counts; the exclusion is narrow on purpose.
  it('does not let the exclusion swallow an ordinary assertion', () => {
    expect(readIntent('The grant program that we found is closing in June.').intent).toBe(
      'assertion',
    );
    expect(readIntent('check the swim program costs').intent).toBe('ambiguous');
  });
});
