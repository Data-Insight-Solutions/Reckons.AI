import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateBranchReport } from '../run-contract.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GOOD = 'The parser tests pass (cmd: `npx vitest run parser` exit 0 log: "Tests  4 passed")';

describe('F286.1 branch report claims carry evidence', () => {
  it('a claim of passing tests with no command is UNVERIFIED and fails', () => {
    const r = validateBranchReport('All tests pass.\n');
    expect(r.claims[0].verdict).toBe('unverified');
    expect(r.claims[0].reason).toContain('UNVERIFIED');
    expect(r.exitCode).toBe(1);
  });
  it('a claim whose named command logged exit 1 fails', () => {
    const r = validateBranchReport('Tests pass (cmd: `npx vitest run x` exit 1 log: "1 failed")');
    expect(r.claims[0].verdict).toBe('contradicted');
    expect(r.exitCode).toBe(1);
  });
  it('a claim naming command, exit 0 and log line is verified', () => {
    const r = validateBranchReport(GOOD);
    expect(r.claims[0].verdict).toBe('verified');
    expect(r.exitCode).toBe(0);
  });
  it('BLOCKED beside exit 0 is recorded as blocked', () => {
    const r = validateBranchReport(`${GOOD}\nBLOCKED: could not reach the model.`, { commandExit: 0 });
    expect(r.blocked).toBe(true);
    expect(r.exitCode).toBe(3);
    expect(r.problems[0]).toContain('exited 0');
  });
  it('with a log, a quoted line that is not in it is UNVERIFIED', () => {
    expect(validateBranchReport(GOOD, { logText: 'something else' }).claims[0].verdict).toBe('unverified');
    expect(validateBranchReport(GOOD, { logText: 'Tests  4 passed\n' }).claims[0].verdict).toBe('verified');
  });
  it('lines that claim nothing are ignored', () => {
    expect(validateBranchReport('# Report\nChanged two files.\n').claims).toHaveLength(0);
  });
  it('the CLI exits 1 for an unverified report and 3 for a blocked one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-'));
    try {
      const run = (text: string) => {
        const f = path.join(dir, 'r.md'); writeFileSync(f, text);
        return spawnSync(process.execPath, [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO, 'scripts/agent/verify-run-report.ts'), '--kind=branch-report', `--file=${f}`], { encoding: 'utf8' }).status;
      };
      expect(run('It works.\n')).toBe(1);
      expect(run(`${GOOD}\n`)).toBe(0);
      expect(run('BLOCKED\n')).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
