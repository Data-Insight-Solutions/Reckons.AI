import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { extractFacts, validateVerdict, runToTurtle, runEntityId, TTL_PREFIXES, buildPrompt, tailOf } from '../job-watch.js';

const LOG = [
  '\u001b[32m ✓ \u001b[39m src/a.test.ts (3 tests)',
  ' ✗ src/b.test.ts > does the thing',
  'Error: expected 1 to be 2',
  'merge-queue: MERGED #12',
  'merge-queue: STOP #13 checks failing',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 3 passed (4)',
  '  2 passed',
  '  1 failed',
  'noise line that matters not',
].join('\n');

describe('extractFacts', () => {
  const f = extractFacts(LOG, 1, 4200);
  it('records exit, duration and counts by rule', () => {
    expect(f.exitCode).toBe(1);
    expect(f.durationMs).toBe(4200);
    expect(f.counts).toMatchObject({ testsPassed: 3, testsFailed: 1, pw_passed: 2, pw_failed: 1, merged: 1, stop: 1, ticks: 1 });
  });
  it('keeps signal lines, strips ANSI, drops noise', () => {
    expect(f.lines).toContain('✓  src/a.test.ts (3 tests)');
    expect(f.lines.some((l) => l.includes('noise'))).toBe(false);
  });
  it('prompt carries the exit code, the extracted lines and the tail', () => {
    const p = buildPrompt('x', f, tailOf(LOG, 2));
    expect(p).toContain('Exit code: 1');
    expect(p).toContain('> merge-queue: STOP #13 checks failing');
    expect(p).toContain('noise line that matters not');
  });
});

describe('validateVerdict', () => {
  it('drops a hallucinated evidence line and keeps a real one', () => {
    const { verdict, notes } = validateVerdict({
      status: 'failed', headline: 'one test failed',
      findings: [
        { kind: 'failure', text: 'b failed', evidence_line: '✗ src/b.test.ts > does the thing' },
        { kind: 'failure', text: 'made up', evidence_line: 'TypeError: nothing like this was logged' },
      ],
    }, LOG, 1);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].text).toBe('b failed');
    expect(notes.join()).toMatch(/unverifiable/);
  });
  it('corrects "passed" on a non-zero exit', () => {
    const { verdict, notes } = validateVerdict({ status: 'passed', headline: 'all good', findings: [] }, LOG, 1);
    expect(verdict.status).toBe('failed');
    expect(notes.join()).toMatch(/corrected/);
  });
  it('derives status from exit code when the model returns junk, and caps lengths', () => {
    const { verdict } = validateVerdict({ status: 'great', headline: 'x'.repeat(300), findings: 'no' }, LOG, 0);
    expect(verdict.status).toBe('passed');
    expect(verdict.headline.length).toBeLessThanOrEqual(120);
  });
});

describe('runToTurtle', () => {
  const started = new Date('2026-09-30T10:00:00.000Z');
  const rec = {
    name: 'agent-tests', startedAt: started, endedAt: new Date('2026-09-30T10:00:05.000Z'), exitCode: 1,
    logPath: '/home/x/.local/state/reckons/jobs/a "quoted".log',
    verdict: { status: 'failed' as const, headline: 'it said "no"\nnewline', findings: [{ kind: 'failure', text: 'b\\failed', evidence_line: 'Error: "x"' }] },
    modelUsed: 'qwen3.6:latest',
  };
  it('parses as Turtle with one entity and one statement per finding', () => {
    const quads = new Parser().parse(`${TTL_PREFIXES}\n\n${runToTurtle(rec)}`);
    const subj = 'urn:reckons:jobrun/' + runEntityId('agent-tests', started).split(':')[1];
    expect(new Set(quads.map((q) => q.subject.value))).toEqual(new Set([subj]));
    expect(quads.filter((q) => q.predicate.value === 'urn:kbase:predicate/finding')).toHaveLength(1);
    expect(quads.find((q) => q.predicate.value === 'urn:kbase:predicate/exit-code')?.object.value).toBe('1');
    expect(quads.find((q) => q.predicate.value === 'urn:kbase:predicate/headline')?.object.value).toBe('it said "no"\nnewline');
  });
});
