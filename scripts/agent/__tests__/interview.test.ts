/**
 * The question desk (F80/F91).
 *
 * The desk is the human's side of the ask/answer loop: it surfaces the questions agents left
 * and records Matt's replies in the SAME file the UI writes. Two ways it can silently betray
 * that contract — and both get tested: (1) showing a question Matt already answered (in the UI
 * or here), which wastes his attention and risks a double-answer; (2) writing an answer in a
 * shape `answers.ts` can't read, which strands the waiting agent forever.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { openQuestions, classifyObject, recordAnswer, uiLink } from '../interview';
import { readAnswers } from '../answers';

let dir: string;
let pending: string;
let answers: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'interview-'));
  pending = path.join(dir, 'pending.jsonl');
  answers = path.join(dir, 'answers.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const q = (o: Record<string, unknown>) =>
  JSON.stringify({ type: 'question', priority: 'medium', ...o });

describe('openQuestions', () => {
  it('returns only unanswered partial-fact questions', () => {
    writeFileSync(
      pending,
      [
        q({ subject: 'urn:a', predicate: 'urn:p', question: 'A?' }),
        q({ subject: 'urn:b', predicate: 'urn:p', question: 'B?' }),
        // an assertion, not a question — must be ignored
        JSON.stringify({ subject: 'urn:c', predicate: 'urn:p', object: 'settled' }),
      ].join('\n') + '\n',
    );
    // B was already answered — must not surface again.
    writeFileSync(
      answers,
      JSON.stringify({ subject: 'urn:b', predicate: 'urn:p', object: 'yes', objectKind: 'literal' }) + '\n',
    );

    const open = openQuestions(pending, answers);
    expect(open.map((o) => o.subject)).toEqual(['urn:a']);
  });

  it('sorts high priority first, then oldest question first', () => {
    writeFileSync(
      pending,
      [
        q({ subject: 'urn:mid', predicate: 'urn:p', question: 'mid', priority: 'medium', addedAt: '2026-01-01' }),
        q({ subject: 'urn:hi', predicate: 'urn:p', question: 'hi', priority: 'high', addedAt: '2026-02-01' }),
        q({ subject: 'urn:old', predicate: 'urn:p', question: 'old', priority: 'medium', addedAt: '2025-01-01' }),
      ].join('\n') + '\n',
    );
    const open = openQuestions(pending, answers);
    expect(open.map((o) => o.subject)).toEqual(['urn:hi', 'urn:old', 'urn:mid']);
  });

  it('dedupes identical (subject, predicate, question) lines', () => {
    const line = q({ subject: 'urn:a', predicate: 'urn:p', question: 'dup?' });
    writeFileSync(pending, [line, line].join('\n') + '\n');
    expect(openQuestions(pending, answers)).toHaveLength(1);
  });

  it('is empty when the pending file does not exist', () => {
    expect(openQuestions(path.join(dir, 'nope.jsonl'), answers)).toEqual([]);
  });
});

describe('classifyObject', () => {
  it('treats prefixed and absolute IRIs as iri objects and expands prefixes', () => {
    expect(classifyObject('kb:auto-merge')).toEqual({ object: 'urn:kbase:concept/auto-merge', objectKind: 'iri' });
    expect(classifyObject('  urn:kbase:concept/x ')).toEqual({ object: 'urn:kbase:concept/x', objectKind: 'iri' });
    expect(classifyObject('https://reckons.ai').objectKind).toBe('iri');
  });
  it('treats free text as a literal', () => {
    expect(classifyObject('0.9 confidence')).toEqual({ object: '0.9 confidence', objectKind: 'literal' });
  });
});

describe('recordAnswer', () => {
  it('writes a line answers.ts can read back and match to the question', () => {
    const question = { subject: 'urn:a', predicate: 'urn:kbase:predicate/threshold', question: 'what value?' };
    recordAnswer(question, 'kb:high-band', answers);

    const back = readAnswers(answers);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      subject: 'urn:a',
      predicate: 'urn:kbase:predicate/threshold',
      object: 'urn:kbase:concept/high-band',
      objectKind: 'iri',
      agent: 'matt',
    });
    expect(back[0].answeredAt).toBeTruthy();
  });
});

describe('uiLink', () => {
  it('points at the review tab and selects the question’s graph', () => {
    const link = uiLink({ subject: 'urn:a', predicate: 'urn:p', kb: 'Roadmap' }, 'http://localhost:5173');
    expect(link).toBe('http://localhost:5173/review?kb=Roadmap');
  });
  it('omits ?kb when the question is not addressed to a specific graph', () => {
    expect(uiLink({ subject: 'urn:a', predicate: 'urn:p' }, 'http://localhost:5173')).toBe(
      'http://localhost:5173/review',
    );
  });
});
