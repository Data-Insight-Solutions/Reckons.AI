/**
 * Pre-approved task templates (F99.4).
 *
 * THE ADMISSION TEST IS THE POINT. Anyone can add a template; the tests below are what stop a
 * template that sends to a third party, deletes something, or produces output nobody would notice
 * was wrong from becoming selectable by voice.
 *
 * The matching cases use REAL voice notes from the capture corpus, transcribed by the shipping
 * pipeline on 2026-09-10 — not invented phrasings. A matcher tested only against what a developer
 * imagines someone says is worth very little.
 */
import { describe, it, expect } from 'vitest';
import {
  TEMPLATES, admissionFailures, assertAdmissible, describeForApproval, matchTemplate, normalize,
  type TaskTemplate,
} from '../task-templates.js';

const base: TaskTemplate = {
  id: 'probe', phrases: ['do the thing'], does: 'Does a thing.',
  recipient: 'owner', effect: 'additive', outputIsReadable: true,
  worstCase: 'Nothing much.', command: (a) => `echo ${a}`,
};

describe('the admission test — what may NOT be pre-approved', () => {
  it('passes every template that actually ships', () => {
    expect(() => assertAdmissible(TEMPLATES)).not.toThrow();
    for (const t of TEMPLATES) expect(admissionFailures(t), t.id).toEqual([]);
  });

  it('REFUSES a template that sends to a third party', () => {
    // "Send certain documents to certain individuals" shares the generation step with "email me"
    // and nothing else: it exposes someone, and it cannot be recalled.
    const f = admissionFailures({ ...base, recipient: 'other' });
    expect(f.join(' ')).toMatch(/not the owner/);
    expect(() => assertAdmissible([{ ...base, recipient: 'other' }])).toThrow(/must not be able to select/);
  });

  it('REFUSES a destructive template', () => {
    expect(admissionFailures({ ...base, effect: 'destructive' }).join(' ')).toMatch(/not additive/);
  });

  it('REFUSES a template whose output nobody would read', () => {
    // Silence is the failure that costs most: a wrong result that is never seen keeps being wrong.
    expect(admissionFailures({ ...base, outputIsReadable: false }).join(' ')).toMatch(/not readable/);
  });

  it('REFUSES a template with no stated worst case', () => {
    // If nobody wrote down what going wrong looks like, nobody thought about it.
    expect(admissionFailures({ ...base, worstCase: '   ' }).join(' ')).toMatch(/no worst case/);
  });

  it('reports every failure at once rather than the first', () => {
    const f = admissionFailures({ ...base, recipient: 'other', effect: 'destructive', outputIsReadable: false, worstCase: '' });
    expect(f).toHaveLength(4);
  });
});

describe('matching REAL voice notes from the corpus', () => {
  it('matches the note that arrived at 21:00 on 2026-09-10', () => {
    // Verbatim: "Generate humanity AI alignment document."
    const m = matchTemplate('Generate humanity AI alignment document.');
    expect(m?.template.id).toBe('generate-document-email-me');
    // The subject keeps the word "document" because that is where the speaker put it. Trying to
    // strip it would be guessing at grammar; the approver reads the subject before anything runs.
    expect(m?.arg).toBe('humanity ai alignment document');
  });

  it('matches the 20:43 note about grant requirements', () => {
    // Verbatim: "We need to, uh, take a look at every requirement for the community AI grant and
    // determine viability for project as defined." — the template phrase is not at the start, so
    // this must NOT match. Recorded as the limit rather than hidden.
    const m = matchTemplate('We need to, uh, take a look at every requirement for the community AI grant');
    expect(m).toBeNull();
  });

  it('matches the same request when spoken as a command', () => {
    const m = matchTemplate('Review every requirement for the community AI grant');
    expect(m?.template.id).toBe('review-requirements');
    expect(m?.arg).toBe('the community ai grant');
  });

  it('strips filler that the transcript adds', () => {
    expect(matchTemplate('um, generate a document about the food tokens program')?.arg)
      .toBe('the food tokens program');
  });
});

describe('REFUSALS — a fragment is not a request', () => {
  it('refuses a template phrase with no subject', () => {
    // "Generate a document" about nothing must not create a task.
    expect(matchTemplate('generate a document')).toBeNull();
    expect(matchTemplate('summarise')).toBeNull();
  });

  it('refuses a template mentioned mid-sentence', () => {
    expect(matchTemplate('I was thinking we could generate a document about that later')).toBeNull();
  });

  it('refuses empty and filler-only transcripts', () => {
    expect(matchTemplate('')).toBeNull();
    expect(matchTemplate('um uh')).toBeNull();
  });

  it('prefers the longer phrase so the argument keeps no command words', () => {
    expect(matchTemplate('generate a document about badgers')?.arg).toBe('badgers');
  });
});

describe('what the approver reads', () => {
  it('states the effect and the worst case, not just the intent', () => {
    const m = matchTemplate('Generate humanity AI alignment document.')!;
    const text = describeForApproval(m);
    expect(text).toMatch(/Sends to: you only/);
    expect(text).toMatch(/Worst case:/);
    expect(text).toMatch(/Command:/);
  });

  it('passes the spoken subject as a quoted ARGUMENT, never as bare shell text', () => {
    // A transcript must not be able to become part of the command's structure.
    const m = matchTemplate('generate a document about "; rm -rf /; echo "')!;
    const cmd = m.template.command(m.arg);
    expect(cmd).toContain('--subject=');
    // JSON.stringify quotes and escapes it, so the shell sees one argument.
    expect(cmd).not.toMatch(/--subject=[^"]*;\s*rm/);
  });
});

describe('normalisation', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('  Generate DOCUMENT about X.  ')).toBe('generate document about x');
  });
});
