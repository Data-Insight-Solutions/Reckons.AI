import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueFindings, findingIdentity, RECOMPUTABLE_AGENTS } from '../pending-queue';

let dir: string;
let QUEUE: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-queue-'));
  QUEUE = join(dir, 'knowledge.pending.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () =>
  existsSync(QUEUE)
    ? readFileSync(QUEUE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];

const f = (subject: string, question: string, predicate = 'urn:sweep:pred/test') => ({
  subject,
  predicate,
  question,
});

describe('findingIdentity', () => {
  it('is the same for the same finding re-queued later', () => {
    // The whole bug: a repeat differs only by its timestamp.
    const a = { subject: 's', predicate: 'p', question: 'boom', addedAt: '2026-01-01' };
    const b = { subject: 's', predicate: 'p', question: 'boom', addedAt: '2026-08-15' };
    expect(findingIdentity(a)).toBe(findingIdentity(b));
  });

  it('DISTINGUISHES THE SAME SENTENCE ABOUT DIFFERENT SUBJECTS', () => {
    // The old substring guard got this wrong and silently dropped real findings: 345 branch-align
    // proposals said one sentence about 345 different entities.
    expect(findingIdentity(f('a', 'same text'))).not.toBe(findingIdentity(f('b', 'same text')));
  });

  it('does not treat a short finding as a repeat of a longer one containing it', () => {
    // `existing.includes(text)` did exactly this.
    expect(findingIdentity(f('s', 'parse error'))).not.toBe(findingIdentity(f('s', 'parse error in file x')));
  });

  it('ignores whitespace and case differences', () => {
    expect(findingIdentity(f('s', '  Boom   Bang '))).toBe(findingIdentity(f('s', 'boom bang')));
  });

  it('falls back to `object` when there is no question — proposed triples carry no question', () => {
    expect(findingIdentity({ subject: 's', predicate: 'p', object: '2026-07-12' })).toContain('2026-07-12');
  });
});

describe('queueFindings — non-recomputing jobs append only what is new', () => {
  const opts = { agent: 'offline:one-shot', path: QUEUE, recomputes: false };

  it('writes findings the first time', () => {
    const r = queueFindings([f('a', 'x'), f('b', 'y')], { ...opts, path: QUEUE });
    expect(r).toMatchObject({ queued: 2, skipped: 0, superseded: 0 });
    expect(read()).toHaveLength(2);
  });

  it('SKIPS AN IDENTICAL FINDING ON RE-RUN — the queue stops refilling', () => {
    queueFindings([f('a', 'x')], { ...opts, path: QUEUE });
    const r = queueFindings([f('a', 'x')], { ...opts, path: QUEUE });
    expect(r).toMatchObject({ queued: 0, skipped: 1 });
    expect(read()).toHaveLength(1);
  });

  it('still queues the same sentence about a different subject', () => {
    queueFindings([f('a', 'does not parse')], { ...opts, path: QUEUE });
    queueFindings([f('b', 'does not parse')], { ...opts, path: QUEUE });
    expect(read()).toHaveLength(2);
  });

  it('deduplicates within a single call as well as against the file', () => {
    const r = queueFindings([f('a', 'x'), f('a', 'x')], { ...opts, path: QUEUE });
    expect(r.queued).toBe(1);
    expect(read()).toHaveLength(1);
  });

  it('stamps agent and addedAt', () => {
    queueFindings([f('a', 'x')], { ...opts, path: QUEUE });
    expect(read()[0]).toMatchObject({ agent: 'offline:one-shot' });
    expect(read()[0].addedAt).toBeTruthy();
  });

  it('NEVER supersedes a one-time note, however old', () => {
    // Age is not staleness for something nobody recomputes. Getting this backwards would delete
    // the most considered entries in the queue.
    writeFileSync(
      QUEUE,
      JSON.stringify({ subject: 'a', predicate: 'p', question: 'a careful human observation', agent: 'claude-code', addedAt: '2020-01-01' }) + '\n',
    );
    queueFindings([f('a', 'something else', 'p')], { ...opts, path: QUEUE });
    expect(read().some((r) => r.agent === 'claude-code')).toBe(true);
  });
});

describe('queueFindings — recomputing jobs replace their own previous answers', () => {
  const opts = { agent: 'offline:branch-align', path: QUEUE };

  it('replaces a previous answer for the same subject+predicate', () => {
    queueFindings([{ subject: 'a', predicate: 'p', object: 'functional' }], { ...opts, path: QUEUE });
    const r = queueFindings([{ subject: 'a', predicate: 'p', object: 'production' }], { ...opts, path: QUEUE });
    expect(r.superseded).toBe(1);
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(rows[0].object).toBe('production'); // the newer computation won
  });

  it('DROPS A FINDING THE JOB NO LONGER REPORTS — a fixed problem disappears', () => {
    // Without this, a resolved finding lingers forever and the queue never shrinks on its own.
    queueFindings(
      [{ subject: 'a', predicate: 'p', object: '1' }, { subject: 'gone', predicate: 'p', object: '1' }],
      { ...opts, path: QUEUE },
    );
    expect(read()).toHaveLength(2);
    queueFindings([{ subject: 'a', predicate: 'p', object: '1' }], { ...opts, path: QUEUE });
    const subs = read().map((r) => r.subject);
    expect(subs).toContain('a');
    expect(subs).not.toContain('gone');
  });

  it('leaves OTHER jobs’ findings completely alone', () => {
    queueFindings([f('a', 'from another job')], { agent: 'offline:graph-lint', path: QUEUE, recomputes: false });
    queueFindings([{ subject: 'a', predicate: 'urn:sweep:pred/test', object: 'x' }], { ...opts, path: QUEUE });
    expect(read().some((r) => r.agent === 'offline:graph-lint')).toBe(true);
  });

  it('infers `recomputes` from the agent name when not stated', () => {
    expect(RECOMPUTABLE_AGENTS.has('offline:branch-align')).toBe(true);
    expect(RECOMPUTABLE_AGENTS.has('claude-code')).toBe(false);
  });

  it('KEEPS THE ORIGINAL FIRST-SEEN DATE across a rewrite', () => {
    // A finding that has been true since July must not look like it appeared today — how long
    // something has been open is exactly what makes an unruled queue visible as a problem.
    writeFileSync(
      QUEUE,
      JSON.stringify({
        subject: 'a', predicate: 'p', object: '1',
        agent: 'offline:branch-align', addedAt: '2026-07-12T00:00:00.000Z',
      }) + '\n',
    );
    queueFindings([{ subject: 'a', predicate: 'p', object: '1' }], { ...opts, path: QUEUE });
    expect(read()[0].addedAt).toBe('2026-07-12T00:00:00.000Z');
  });

  it('reports only findings that genuinely went away as superseded', () => {
    queueFindings(
      [{ subject: 'a', predicate: 'p', object: '1' }, { subject: 'gone', predicate: 'p', object: '1' }],
      { ...opts, path: QUEUE },
    );
    const r = queueFindings([{ subject: 'a', predicate: 'p', object: '1' }], { ...opts, path: QUEUE });
    expect(r.superseded).toBe(1); // 'gone' left; 'a' is still true, not superseded
  });

  it('is STABLE across repeated identical runs — no growth, no churn', () => {
    const findings = [
      { subject: 'a', predicate: 'p', object: '1' },
      { subject: 'b', predicate: 'p', object: '2' },
    ];
    for (let i = 0; i < 5; i++) queueFindings(findings, { ...opts, path: QUEUE });
    expect(read()).toHaveLength(2);
  });
});

describe('the queue file is never damaged', () => {
  it('preserves a line that does not parse as JSON', () => {
    // Rewriting must not be a way to quietly lose a hand-edited entry.
    writeFileSync(QUEUE, 'this is not json\n');
    queueFindings([{ subject: 'a', predicate: 'p', object: '1' }], { agent: 'offline:branch-align', path: QUEUE });
    expect(readFileSync(QUEUE, 'utf8')).toContain('this is not json');
  });

  it('creates the file when it does not exist yet', () => {
    expect(existsSync(QUEUE)).toBe(false);
    queueFindings([f('a', 'x')], { agent: 'offline:one-shot', path: QUEUE, recomputes: false });
    expect(read()).toHaveLength(1);
  });

  it('writes nothing when there is nothing new to say', () => {
    queueFindings([f('a', 'x')], { agent: 'offline:one-shot', path: QUEUE, recomputes: false });
    const before = readFileSync(QUEUE, 'utf8');
    queueFindings([f('a', 'x')], { agent: 'offline:one-shot', path: QUEUE, recomputes: false });
    expect(readFileSync(QUEUE, 'utf8')).toBe(before);
  });

  it('handles an empty findings list without truncating the queue', () => {
    queueFindings([f('a', 'x')], { agent: 'offline:one-shot', path: QUEUE, recomputes: false });
    queueFindings([], { agent: 'offline:branch-align', path: QUEUE });
    expect(read()).toHaveLength(1);
  });
});
