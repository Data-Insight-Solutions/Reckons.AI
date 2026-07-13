/**
 * The async orchestration loop (F80).
 *
 * The whole point is that the user stops being a blocking call. If a question never
 * reaches the Review tab, or an answer never reaches the waiting agent, the model
 * silently degrades back to blocking — and nobody notices, because "no answers yet" looks
 * exactly like "working fine". So the loop gets tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { askGraph, expandIri } from '../ask';
import { readAnswers, newAnswers, readCursor, writeCursor } from '../answers';
import { appendFinding, startSession } from '../digest';

let dir: string;
const p = (f: string) => path.join(dir, f);

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'async-loop-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('expandIri', () => {
  it('expands our prefixes and leaves absolute IRIs alone', () => {
    expect(expandIri('kb:trust-system')).toBe('urn:kbase:concept/trust-system');
    expect(expandIri('kpred:blocks')).toBe('urn:kbase:predicate/blocks');
    expect(expandIri('http://www.w3.org/2000/01/rdf-schema#label')).toBe(
      'http://www.w3.org/2000/01/rdf-schema#label',
    );
  });
});

describe('askGraph — an agent asks the graph instead of blocking on a human', () => {
  it('emits a PARTIAL fact: no object key, which is what makes the Review tab show a picker', () => {
    const pending = p('pending.jsonl');
    askGraph(
      { subject: 'kb:auto-merge', predicate: 'kpred:merge-threshold', question: 'What confidence?' },
      pending,
    );

    const entry = JSON.parse(readFileSync(pending, 'utf8').trim());

    // THE critical assertion. drainWorkspacePending() decides a fact is partial by the
    // ABSENCE of `object`. If a well-meaning refactor ever defaults it to '' or null,
    // the question silently becomes an assertion and the picker never appears.
    expect('object' in entry).toBe(false);

    expect(entry.subject).toBe('urn:kbase:concept/auto-merge');
    expect(entry.predicate).toBe('urn:kbase:predicate/merge-threshold');
    expect(entry.question).toBe('What confidence?');
    expect(entry.type).toBe('question');
  });

  it('records what the question BLOCKS, so other agents can pick up what is not waiting', () => {
    const pending = p('pending.jsonl');
    askGraph(
      { subject: 'kb:x', predicate: 'kpred:y', question: 'q?', blocks: 'kb:auto-merge' },
      pending,
    );
    expect(JSON.parse(readFileSync(pending, 'utf8').trim()).blocks).toBe('urn:kbase:concept/auto-merge');
  });

  it('never queues the same question twice — the reviewer must not triage it again', () => {
    const pending = p('pending.jsonl');
    const q = { subject: 'kb:x', predicate: 'kpred:y', question: 'Same question?' };

    expect(askGraph(q, pending).queued).toBe(true);
    expect(askGraph(q, pending).queued).toBe(false); // asked again later, not re-queued

    expect(readFileSync(pending, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('answers — the agent resumes without ever having waited', () => {
  const write = (file: string, rows: object[]) =>
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const answer = (question: string, object: string) => ({
    subject: 'urn:kbase:concept/x',
    predicate: 'urn:kbase:predicate/y',
    object,
    objectKind: 'literal' as const,
    question,
    answeredAt: new Date().toISOString(),
  });

  it('reads the answers Matt left', () => {
    const f = p('answers.jsonl');
    write(f, [answer('What threshold?', '0.9')]);
    expect(readAnswers(f)[0].object).toBe('0.9');
  });

  it('survives a malformed line rather than dying on one bad byte', () => {
    const f = p('answers.jsonl');
    writeFileSync(f, `${JSON.stringify(answer('a', '1'))}\n{ not json\n${JSON.stringify(answer('b', '2'))}\n`);
    expect(readAnswers(f).map((a) => a.object)).toEqual(['1', '2']);
  });

  it('shows each answer exactly once via the cursor', () => {
    const f = p('answers.jsonl');
    const c = p('cursor');
    write(f, [answer('a', '1'), answer('b', '2')]);

    const first = newAnswers(f, c);
    expect(first.answers).toHaveLength(2);
    writeCursor(first.total, c);

    // Nothing new: the agent must not re-do work it already picked up.
    expect(newAnswers(f, c).answers).toHaveLength(0);

    // Matt answers one more while the agent was busy elsewhere.
    write(f, [answer('a', '1'), answer('b', '2'), answer('c', '3')]);
    const second = newAnswers(f, c);
    expect(second.answers).toHaveLength(1);
    expect(second.answers[0].object).toBe('3');
  });

  it('re-reads from the start if the file shrank, rather than silently swallowing answers', () => {
    const f = p('answers.jsonl');
    const c = p('cursor');
    write(f, [answer('a', '1'), answer('b', '2'), answer('c', '3')]);
    writeCursor(3, c);

    // The file was reset/edited by hand. A naive slice(3) would return nothing forever.
    write(f, [answer('fresh', '9')]);
    expect(newAnswers(f, c).answers).toHaveLength(1);
  });

  it('treats a missing cursor as "seen nothing"', () => {
    expect(readCursor(p('nope'))).toBe(0);
  });
});

describe('digest — one report that grows, instead of many that interrupt', () => {
  it('appends findings without overwriting what came before', () => {
    const d = p('DIGEST.md');
    appendFinding({ type: 'bug-found', headline: 'First bug', about: 'kb:a' }, d);
    appendFinding({ type: 'test-added', headline: 'Second thing', about: 'kb:b' }, d);

    const md = readFileSync(d, 'utf8');
    expect(md).toContain('First bug');
    expect(md).toContain('Second thing');
    expect(md.indexOf('First bug')).toBeLessThan(md.indexOf('Second thing')); // chronological
  });

  it('creates the digest with a header explaining that nothing waited on the reader', () => {
    const d = p('DIGEST.md');
    appendFinding({ type: 'note', headline: 'x' }, d);
    expect(readFileSync(d, 'utf8')).toContain('Nothing in this file waited on you');
  });

  it('types each finding so the digest can be skimmed', () => {
    const d = p('DIGEST.md');
    appendFinding({ type: 'claim-falsified', headline: 'The 60-70% claim was false', about: 'kb:c' }, d);
    const md = readFileSync(d, 'utf8');
    expect(md).toContain('`claim-falsified`');
    expect(md).toContain('**kb:c**');
  });

  it('opens a session block so a returning reader sees what happened when', () => {
    const d = p('DIGEST.md');
    appendFinding({ type: 'note', headline: 'x' }, d);
    startSession('overnight sweep', d);
    expect(readFileSync(d, 'utf8')).toContain('## overnight sweep');
  });
});
