import { describe, expect, it } from 'vitest';
import { decide, openRenamePr, parseRenamed } from '../rename-pr';

describe('rename-pr (F203.6)', () => {
  it('reads the rename total, and says when it is missing', () => {
    expect(parseRenamed('| a | 1 |\ntotal renamed: 42\n')).toBe(42);
    expect(parseRenamed('Error: tsconfig.json does not load cleanly')).toBeNull();
  });
  it('opens a PR only when something was renamed and every gate is green', () => {
    const green = [{ name: 'check', ok: true }, { name: 'unit suite', ok: true }];
    expect(decide(42, green).kind).toBe('pr');
    expect(decide(0, green).kind).toBe('nothing');
    expect(decide(null, green).kind).toBe('stop');
    const red = decide(42, [...green, { name: 'scripts/ imports', ok: false }]);
    expect(red).toEqual({ kind: 'stop', why: 'gate(s) failed: scripts/ imports' });
  });
  it('does not open a second rename PR for a term while one is open', () => {
    const prs = [{ number: 366, headRefName: 'docs/competitor-wispr-flow' }, { number: 367, headRefName: 'refactor/rename-kb-batch-2b' }];
    expect(openRenamePr(prs, 'kb')).toBe(367);
    expect(openRenamePr(prs, 'node')).toBeNull();
  });
});
