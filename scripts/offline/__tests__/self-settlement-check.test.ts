import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rowId, type PendingRow } from '../../../mcp-server/src/review-session.js';
import {
  checkFiles,
  findSelfSettlements,
  runSelfSettlementCheck,
  type JournalLine,
} from '../self-settlement-check.js';

const dirs: string[] = [];
function fixture(name: string, queue: unknown[], verdicts: unknown[]): { queueFile: string; journalFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `self-settle-${name}-`));
  dirs.push(dir);
  const queueFile = path.join(dir, 'pending.jsonl');
  const journalFile = path.join(dir, 'decisions.jsonl');
  writeFileSync(queueFile, queue.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(journalFile, verdicts.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { queueFile, journalFile };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const humanActor = { user: 'matt', host: 'devbox', route: 'cli' as const, agent: false, interactive: true, attestation: 'observed, not claimed' };
const agentActor = (agentId: string) => ({ ...humanActor, agent: true, agentId });
const verdict = (decision: string, rows: string[], actor: object, object = 'functional'): object => ({
  decision, verdict: 'accept', rows, subject: 'kb:example', predicate: 'kpred:has-status', object,
  kb: 'roadmap', actor, at: '2026-11-11T00:00:00Z',
});

const rowDeputy: PendingRow = { subject: 'kb:example', predicate: 'kpred:has-status', object: 'functional', kb: 'roadmap', agent: 'local-deputy', type: 'suggestion' };
const rowOther: PendingRow = { subject: 'kb:other', predicate: 'kpred:has-status', object: 'planned', kb: 'roadmap', agent: 'offline-job' };
const rowNoAgent: PendingRow = { subject: 'kb:blank', predicate: 'kpred:has-status', object: 'planned', kb: 'roadmap' };

describe('F286.7 no agent settles its own proposals', () => {
  it('one self-settled verdict fails and names the agent, even across label variants', () => {
    const { queueFile, journalFile } = fixture('fail', [rowDeputy, rowOther], [
      verdict('d-own', [rowId(rowDeputy)], agentActor('local-deputy')),
      verdict('d-variant', [rowId(rowDeputy), rowId(rowOther)], agentActor('local-deputy (opus)')),
      verdict('d-fine', [rowId(rowOther)], humanActor),
    ]);
    const result = checkFiles(queueFile, journalFile);
    expect(result.checked).toBe(3);
    expect(result.notCheckable).toBe(0);
    expect(result.selfSettled).toHaveLength(2);
    expect(result.selfSettled.map((f) => f.decision).sort()).toEqual(['d-own', 'd-variant']);
    expect(result.selfSettled[0].agent).toBe('local-deputy');
    // the variant verdict covered two rows and the agent's own row was one of them
    expect(result.selfSettled.find((f) => f.decision === 'd-variant')).toMatchObject({ covered: 2, own: 1 });
    // running the same pair as the script exits 1
    expect(runSelfSettlementCheck(queueFile, journalFile)).toBe(1);
  });

  it('passes (exit 0) when no verdict settles a row its agent proposed', () => {
    const { queueFile, journalFile } = fixture('pass', [rowDeputy, rowNoAgent], [
      verdict('d-human', [rowId(rowDeputy)], humanActor),
      verdict('d-other-agent', [rowId(rowDeputy)], agentActor('offline-job')),
      // a covered row with no recorded proposer is not a self-settlement: nobody proposed it, visibly
      verdict('d-blank', [rowId(rowNoAgent)], agentActor('offline-job')),
    ]);
    const result = checkFiles(queueFile, journalFile);
    expect(result.checked).toBe(3);
    expect(result.selfSettled).toHaveLength(0);
    expect(runSelfSettlementCheck(queueFile, journalFile)).toBe(0);
  });

  it('a verdict whose rows are gone from the queue is not checkable, not a failure', () => {
    const { queueFile, journalFile } = fixture('stale', [rowDeputy], [
      verdict('d-gone', ['deadbeef'], agentActor('local-deputy')),
      verdict('d-mixed', [rowId(rowDeputy), 'deadbeef'], agentActor('offline-job')),
    ]);
    const result = checkFiles(queueFile, journalFile);
    expect(result.notCheckable).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.selfSettled).toHaveLength(0);
    expect(runSelfSettlementCheck(queueFile, journalFile)).toBe(0);
  });

  it('journal lines without a rows list are neither checked nor failures', () => {
    const queue = [rowDeputy];
    const verdicts: JournalLine[] = [
      { decision: 'd-broken', subject: 'kb:example', predicate: 'kpred:has-status' },
      { decision: 'd-self', rows: [rowId(rowDeputy)], actor: agentActor('local-deputy') },
    ];
    const result = findSelfSettlements(queue, verdicts);
    expect(result.checked).toBe(1);
    expect(result.notCheckable).toBe(0);
    expect(result.selfSettled.map((f) => f.decision)).toEqual(['d-self']);
  });

  it('missing arguments or files exit 2, and the script never writes', () => {
    expect(runSelfSettlementCheck(undefined, undefined)).toBe(2);
    expect(runSelfSettlementCheck('queue.jsonl', undefined)).toBe(2);
    const { queueFile } = fixture('args', [rowDeputy], []);
    expect(runSelfSettlementCheck(queueFile, path.join(tmpdir(), 'no-such-journal.jsonl'))).toBe(2);
  });
});
