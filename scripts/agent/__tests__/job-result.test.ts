import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobResultPath, takeJobResult } from '../session-queue';
import { jobResult } from '../../content/scan-attach';

// F58.9.20: the worker reads the file a job wrote to RECKONS_JOB_RESULT and records it on the done row.
let home: string;
let saved: string | undefined;
beforeEach(() => { saved = process.env.XDG_STATE_HOME; home = mkdtempSync(join(tmpdir(), 'job-result-')); process.env.XDG_STATE_HOME = home; });
afterEach(() => { if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved; rmSync(home, { recursive: true, force: true }); });

describe('job result', () => {
  it('returns what the job wrote, and removes the file', () => {
    const f = jobResultPath('abc123');
    mkdirSync(join(f, '..'), { recursive: true });
    const r = jobResult({ space: 'demo-space', id: 'x.spz', url: 'asset:splat/x.spz', file: '/f', copied: true, rows: 4, rowsAlreadyQueued: 0, entity: 'urn:kbase:concept/scan-x' });
    writeFileSync(f, JSON.stringify(r));
    expect(takeJobResult('abc123')).toEqual({ kind: 'scan-attach', space: 'demo-space', asset: 'asset:splat/x.spz', contentId: 'x.spz', entity: 'urn:kbase:concept/scan-x' });
    expect(existsSync(f)).toBe(false);
  });
  it('no file, or a malformed one, is no result', () => {
    expect(takeJobResult('nothing')).toBeUndefined();
    const f = jobResultPath('bad');
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '{oops');
    expect(takeJobResult('bad')).toBeUndefined();
  });
});
