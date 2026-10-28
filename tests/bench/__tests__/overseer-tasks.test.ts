import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OVERSEER_TASKS, buildPrompt, parseAnswer, scoreAnswer } from '../overseer-tasks';

const ROOT = resolve(__dirname, '../../..');

describe('overseer bench scoring', () => {
  for (const t of OVERSEER_TASKS) {
    it(`${t.id}: fixture exists and the reference answer scores correct`, () => {
      expect(existsSync(resolve(ROOT, t.fixture))).toBe(true);
      expect(buildPrompt(t)).toContain(t.fixture);
      const ref = `reasoning...\nANSWER: {"cause": "${t.expectCause}", "action": "${t.expectAction ?? 'proceed'}"}`;
      expect(scoreAnswer(t, ref).correct).toBe(true);
    });
    it(`${t.id}: a wrong cause, and keyword stuffing without the JSON line, score incorrect`, () => {
      expect(scoreAnswer(t, `ANSWER: {"cause": "other-x", "action": "stop"}`).correct).toBe(false);
      expect(scoreAnswer(t, `${t.expectCause} ${t.causes.join(' ')} stop proceed`).correct).toBe(false);
    });
  }
  it('b-diff-review: right cause but action proceed fails the stop condition', () => {
    const t = OVERSEER_TASKS.find((x) => x.id === 'b-diff-review')!;
    const s = scoreAnswer(t, `ANSWER: {"cause": "private-data-committed", "action": "proceed"}`);
    expect(s.causeCorrect).toBe(true);
    expect(s.stopRespected).toBe(false);
    expect(s.correct).toBe(false);
  });
  it('takes the LAST ANSWER line and rejects malformed JSON', () => {
    expect(parseAnswer('ANSWER: {"cause":"a","action":"stop"}\nANSWER: {"cause":"b","action":"proceed"}')?.cause).toBe('b');
    expect(parseAnswer('ANSWER: {cause: a}')).toBeNull();
  });
});
