import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueFindings, findingIdentity, RECOMPUTABLE_AGENTS, appendQueueText } from '../pending-queue';
import { RowContractError, stampRow } from '../../../mcp-server/src/row-contract';

// These producers run as jobs, and the queue worker's job-watch gives every job its JobRun id (F89.4.1).
process.env.RECKONS_RUN_ID ??= 'jobrun:test-run-20261110T000000Z';

describe('the row contract on append (F89.4.1)', () => {
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'row-contract-')); return { d, q: join(d, 'knowledge.pending.jsonl') }; };
  const row = (over: Record<string, unknown> = {}) => JSON.stringify({ subject: 's', predicate: 'p', object: 'o', kb: 'roadmap', agent: 'offline:fixture', ...over }) + '\n';
  const refused = (fn: () => void): RowContractError => { try { fn(); } catch (e) { return e as RowContractError; } throw new Error('expected a refusal'); };

  it('stamps run, lane, model, addedAt and origin on a machine row from the worker env', () => {
    const { d, q } = fresh();
    appendQueueText(q, row(), { env: { RECKONS_RUN_ID: 'jobrun:x-1', RECKONS_JOB_MODEL: 'm1' } });
    const r = JSON.parse(readFileSync(q, 'utf8'));
    expect(r).toMatchObject({ run: 'jobrun:x-1', lane: 'claim', model: 'm1', origin: 'job', kb: 'roadmap', agent: 'offline:fixture' });
    expect(Date.parse(r.addedAt)).toBeGreaterThan(0);
    rmSync(d, { recursive: true, force: true });
  });
  it('refuses a machine row without kb and with an invented lane, naming the field', () => {
    const { d, q } = fresh();
    expect(refused(() => appendQueueText(q, row({ kb: undefined }), { env: { RECKONS_RUN_ID: 'r' } })).field).toBe('kb');
    expect(refused(() => appendQueueText(q, row({ lane: 'report' }), { env: { RECKONS_RUN_ID: 'r' } })).field).toBe('lane');
    expect(refused(() => appendQueueText(q, row({ kb: '  ' }), { env: { RECKONS_RUN_ID: 'r' } })).message).toMatch(/missing kb/);
    expect(existsSync(q)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
  it('a hand run (no RECKONS_RUN_ID) mints hand:<job>:<time> once, and every row of the run shares it', () => {
    const { d, q } = fresh();
    appendQueueText(q, row({ subject: 'a' }) + row({ subject: 'b' }), { env: {} });
    appendQueueText(q, row({ subject: 'c' }), { env: {} });
    const rows = readFileSync(q, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(new Set(rows.map((r) => r.run)).size).toBe(1);
    expect(rows[0].run).toMatch(/^hand:fixture:\d{8}T\d{6}Z$/);
    expect(rows.every((r) => r.origin === 'job')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('a caller that bypasses the stamping step, with no way to mint a run, is refused naming run', () => {
    const err = refused(() => stampRow({ subject: 's', predicate: 'p', kb: 'roadmap', agent: 'offline:x' }, { env: {} }));
    expect(err.field).toBe('run');
    expect(stampRow({ subject: 's', predicate: 'p', kb: 'roadmap', agent: 'offline:x' }, { env: {}, mintRun: () => 'hand:x:20261111T000000Z' }).run).toBe('hand:x:20261111T000000Z');
  });
  it('one refused row refuses the whole append and leaves the queue as it was', () => {
    const { d, q } = fresh();
    writeFileSync(q, '{"subject":"old","predicate":"p"}\n');
    expect(() => appendQueueText(q, row() + row({ kb: undefined }), { env: { RECKONS_RUN_ID: 'r' } })).toThrow(/missing kb/);
    expect(readFileSync(q, 'utf8')).toBe('{"subject":"old","predicate":"p"}\n');
    rmSync(d, { recursive: true, force: true });
  });
  it("accepts a person's note with only its space, and refuses one without", () => {
    const { d, q } = fresh();
    appendQueueText(q, JSON.stringify({ subject: 's', predicate: 'p', object: 'o', kb: 'roadmap' }) + '\n', { origin: 'note', env: {} });
    expect(JSON.parse(readFileSync(q, 'utf8'))).toMatchObject({ origin: 'note', kb: 'roadmap' });
    expect(refused(() => appendQueueText(q, JSON.stringify({ subject: 's', predicate: 'p' }) + '\n', { origin: 'note', env: {} })).field).toBe('kb');
    rmSync(d, { recursive: true, force: true });
  });
  it('a synthetic producer writing through queueFindings gets the same stamps', () => {
    const { d, q } = fresh();
    const saved = process.env.RECKONS_RUN_ID;
    process.env.RECKONS_RUN_ID = 'jobrun:synthetic-1';
    try {
      queueFindings([{ subject: 's', predicate: 'urn:sweep:pred/x', question: 'q', type: 'question' }], { agent: 'offline:synthetic', path: q, recomputes: false });
    } finally { process.env.RECKONS_RUN_ID = saved; }
    expect(JSON.parse(readFileSync(q, 'utf8'))).toMatchObject({ run: 'jobrun:synthetic-1', lane: 'finding', origin: 'job', kb: 'roadmap' });
    rmSync(d, { recursive: true, force: true });
  });
  it('lines that do not parse pass through untouched for queue-integrity to report', () => {
    const { d, q } = fresh();
    appendQueueText(q, 'not json at all\n', { env: {} });
    expect(readFileSync(q, 'utf8')).toBe('not json at all\n');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('appendQueueText', () => {
  it('appends under the lock and repairs a missing trailing newline', () => {
    const d = mkdtempSync(join(tmpdir(), 'append-text-'));
    const q = join(d, 'knowledge.pending.jsonl');
    writeFileSync(q, '{"subject":"a","predicate":"p"}');
    appendQueueText(q, '{"subject":"b","predicate":"p","kb":"roadmap"}\n', 'utf8');
    appendQueueText(q, '{"subject":"c","predicate":"p","kb":"roadmap"}');
    const rows = readFileSync(q, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).subject);
    expect(rows).toEqual(['a', 'b', 'c']);
    expect(readFileSync(q, 'utf8').endsWith('\n')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('creates nothing for empty text', () => {
    const d = mkdtempSync(join(tmpdir(), 'append-text-'));
    const q = join(d, 'knowledge.pending.jsonl');
    appendQueueText(q, '');
    expect(existsSync(q)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});

let dir: string;
let QUEUE: string;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = join(REPO, 'node_modules/tsx/dist/cli.mjs');
const WORKER = join(REPO, 'scripts/offline/__tests__/fixtures/pending-queue-writer.ts');

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

function worker(ready: string, subject: string, mode = 'append'): Promise<number> {
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [TSX, WORKER, QUEUE, ready, subject, mode], {
      cwd: REPO,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolveWorker(code ?? 1));
  });
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!files.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`workers did not reach queue lock: ${files.join(', ')}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

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

  it('keeps identical text addressed to different graphs distinct', () => {
    const base = { subject: 's', predicate: 'p', question: 'same' };
    expect(findingIdentity({ ...base, kb: 'roadmap' }))
      .not.toBe(findingIdentity({ ...base, kb: 'production' }));
    expect(findingIdentity({ ...base, kb: 'Reckons.AI Roadmap' }))
      .toBe(findingIdentity({ ...base, kb: 'reckons-ai-roadmap' }));
  });

  it('keeps different blockers distinct but ignores block order', () => {
    const base = { subject: 's', predicate: 'p', question: 'same', kb: 'roadmap' };
    expect(findingIdentity({ ...base, blocks: 'task:a' }))
      .not.toBe(findingIdentity({ ...base, blocks: 'task:b' }));
    expect(findingIdentity({ ...base, blocks: ['task:b', 'task:a'] }))
      .toBe(findingIdentity({ ...base, blocks: ['task:a', 'task:b'] }));
  });
});

describe('queueFindings — non-recomputing jobs append only what is new', () => {
  const opts = { agent: 'offline:one-shot', path: QUEUE, recomputes: false };

  it('writes findings the first time', () => {
    const r = queueFindings([f('a', 'x'), f('b', 'y')], { ...opts, path: QUEUE });
    expect(r).toMatchObject({ queued: 2, skipped: 0, superseded: 0 });
    expect(read()).toHaveLength(2);
    expect(read().every((entry) => entry.kb === 'roadmap')).toBe(true);
  });

  it('uses an explicit graph target instead of the repository default', () => {
    queueFindings([f('a', 'x')], { ...opts, path: QUEUE, kb: 'production' });
    expect(read()[0].kb).toBe('production');
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

  it('deduplicates repeated findings inside one recomputing result', () => {
    const finding = { subject: 'a', predicate: 'p', object: '1' };
    const result = queueFindings([finding, finding], { ...opts, path: QUEUE });
    expect(result).toMatchObject({ queued: 1, skipped: 1 });
    expect(read()).toHaveLength(1);
  });

  it('recomputes only the destination graph supplied by this run', () => {
    queueFindings([{ subject: 'prod', predicate: 'p', object: '1' }], {
      ...opts, path: QUEUE, kb: 'production',
    });
    queueFindings([{ subject: 'road', predicate: 'p', object: '1' }], {
      ...opts, path: QUEUE, kb: 'roadmap',
    });
    expect(read().map((row) => row.kb).sort()).toEqual(['production', 'roadmap']);
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

  it('serializes concurrent append and recompute transactions without losing either result', async () => {
    queueFindings([{ subject: 'old', predicate: 'urn:test/predicate', object: 'old' }], {
      agent: 'offline:branch-align', path: QUEUE, recomputes: true, kb: 'roadmap',
    });

    const lockFd = openSync(`${QUEUE}.lock`, 'a', 0o600);
    const acquired = spawnSync('flock', ['-x', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', lockFd],
    });
    expect(acquired.status).toBe(0);

    const readyA = join(dir, 'ready-a');
    const readyB = join(dir, 'ready-b');
    const a = worker(readyA, 'fresh-recompute', 'recompute');
    const b = worker(readyB, 'concurrent-append');
    await waitForFiles([readyA, readyB]);
    closeSync(lockFd);

    expect(await Promise.all([a, b])).toEqual([0, 0]);
    const subjects = read().map((row) => row.subject).sort();
    expect(subjects).toEqual(['concurrent-append', 'fresh-recompute']);
  }, 15_000);
});
