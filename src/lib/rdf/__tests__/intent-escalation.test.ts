import { describe, it, expect, vi } from 'vitest';
import { readNote, readIntent, AMBIGUOUS_THRESHOLD, TASK_THRESHOLD } from '../note-intent';
import {
  needsEscalation, escalationCost, escalateNote, INTENT_OPTIONS, type DecideIntent
} from '../intent-escalation';

/** A backend that always answers `choice`, and counts how often it was asked. */
const stub = (choice: string, confidence: number | null = 0.9) => {
  const fn = vi.fn(async () => ({ choice, confidence })) as unknown as DecideIntent;
  return fn as DecideIntent & { mock: { calls: unknown[] } };
};

describe('the gate — what gets paid for', () => {
  it('escalates only the hedge band, by threshold rather than by label', () => {
    expect(needsEscalation({ score: AMBIGUOUS_THRESHOLD } as never)).toBe(true);
    expect(needsEscalation({ score: TASK_THRESHOLD - 0.01 } as never)).toBe(true);
    expect(needsEscalation({ score: TASK_THRESHOLD } as never)).toBe(false);
    expect(needsEscalation({ score: AMBIGUOUS_THRESHOLD - 0.01 } as never)).toBe(false);
  });

  // The rule is 10/10 on this slice; sending it to a model costs ~8s each and buys nothing.
  it('never spends a call on a confident reading', async () => {
    const decide = stub('assertion');
    const note = readNote('Email the committee the revised budget. The roof leaks in the wind.');
    expect(escalationCost(note)).toBe(0);
    await escalateNote(note, decide);
    expect(decide).not.toHaveBeenCalled();
  });

  it('reports the cost before it is spent', () => {
    const note = readNote('Check whether the hall is free on the fourteenth.');
    expect(escalationCost(note)).toBe(readIntent('Check whether the hall is free on the fourteenth.').intent === 'ambiguous' ? 1 : 0);
  });
});

describe('resolving a hedge', () => {
  const HEDGED = 'Check whether the hall is free on the fourteenth.';

  it('is genuinely hedged by the rule, or this test proves nothing', () => {
    const r = readIntent(HEDGED);
    expect(r.intent).toBe('ambiguous');
    expect(needsEscalation(r)).toBe(true);
  });

  it('adopts the model choice and says the rule was overridden', async () => {
    const out = await escalateNote(readNote(HEDGED), stub('task', 0.94));
    expect(out.readings[0].intent).toBe('task');
    expect(out.readings[0].score).toBe(0.94);
    expect(out.readings[0].signals.join(' ')).toMatch(/rule hedged at 0\.50, model chose "task"/);
  });

  // readNote sends an ambiguous sentence down BOTH paths, so a human triages two proposals for
  // one sentence. Resolving it removes that, which is the benefit even when routing was right.
  it('removes the double-proposal an ambiguous reading creates', async () => {
    const before = readNote(HEDGED);
    expect(before.tasks).toHaveLength(1);
    expect(before.factText).not.toBe('');

    const after = await escalateNote(before, stub('task'));
    expect(after.tasks).toHaveLength(1);
    expect(after.factText).toBe('');
  });

  it('keeps the hedge when the model agrees it is unclear', async () => {
    const out = await escalateNote(readNote(HEDGED), stub('ambiguous'));
    expect(out.readings[0].intent).toBe('ambiguous');
    expect(out.readings[0].signals.join(' ')).toMatch(/model agreed/);
  });
});

describe('fail-safe — a downed model degrades to today, never worse', () => {
  const HEDGED = 'Check whether the hall is free on the fourteenth.';

  it('keeps the rule reading when the backend throws', async () => {
    const boom: DecideIntent = async () => { throw new Error('connection refused'); };
    const out = await escalateNote(readNote(HEDGED), boom);
    expect(out.readings[0].intent).toBe('ambiguous');
    expect(out.readings[0].signals.join(' ')).toMatch(/escalation unavailable.*connection refused/);
  });

  it('keeps the rule reading when the backend times out', async () => {
    const hang: DecideIntent = () => new Promise(() => {});
    const out = await escalateNote(readNote(HEDGED), hang, { timeoutMs: 20 });
    expect(out.readings[0].intent).toBe('ambiguous');
    expect(out.readings[0].signals.join(' ')).toMatch(/timed out/);
  });

  it('refuses an option the model invented', async () => {
    const out = await escalateNote(readNote(HEDGED), stub('URGENT'));
    expect(out.readings[0].intent).toBe('ambiguous');
    expect(out.readings[0].signals.join(' ')).toMatch(/unusable answer/);
  });

  it('offers exactly the three routings the rule uses', () => {
    expect([...INTENT_OPTIONS].sort()).toEqual(['ambiguous', 'assertion', 'task']);
  });
});

describe('the rebuilt note agrees with readNote', () => {
  // escalateNote recomputes tasks/factText because it holds parsed readings, not raw text.
  // If readNote's derivation changes and this one does not, the two silently diverge.
  it('derives tasks and factText identically when nothing is escalated', async () => {
    const text = 'Email the committee the revised budget. The roof leaks in the wind.';
    const direct = readNote(text);
    const passthrough = await escalateNote(direct, stub('assertion'));
    expect(passthrough.tasks.map(r => r.sentence)).toEqual(direct.tasks.map(r => r.sentence));
    expect(passthrough.factText).toBe(direct.factText);
  });
});
