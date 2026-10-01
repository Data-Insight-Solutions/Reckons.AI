import { describe, it, expect } from 'vitest';
import {
  attributeByBranch, branchOf, calibrationWindow, cleanCalibration, dedupeEntries, entryFromLine,
  filterWindow, groupTasksPerWeek, median, modelFamily, taskCosts, taskKind, tokensPerPercent,
  tasksPerWeek, weekStart, weigh, type Entry
} from '../lib/usage-attribution';

const e = (ts: string, branch: string, weighted: number, family: Entry['family'] = 'opus', key?: string): Entry => ({ ts, branch, family, weighted, key });

describe('weights and families', () => {
  it('weighs usage with the documented ratios', () => {
    expect(weigh({ input_tokens: 10, cache_creation_input_tokens: 8, cache_read_input_tokens: 100, output_tokens: 2 })).toBe(10 + 10 + 10 + 10);
  });
  it('classifies model families', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4')).toBe('haiku');
    expect(modelFamily('qwen3')).toBe('other');
    expect(modelFamily(undefined)).toBe('other');
  });
});

describe('attribution', () => {
  it('prefers gitBranch, falls back to cwd', () => {
    expect(branchOf({ gitBranch: 'feat/x', cwd: '/a/b' })).toBe('feat/x');
    expect(branchOf({ cwd: '/a/b' })).toBe('(cwd:b)');
    expect(branchOf({ gitBranch: 'HEAD' })).toBe('(unknown)');
  });
  it('turns a transcript line into an entry and skips synthetic/usage-less lines', () => {
    const line = { timestamp: 't', gitBranch: 'fix/a', requestId: 'r', message: { id: 'm', model: 'claude-sonnet-5-5', usage: { output_tokens: 2 } } };
    expect(entryFromLine(line)).toMatchObject({ branch: 'fix/a', family: 'sonnet', weighted: 10, key: 'r|m' });
    expect(entryFromLine({ ...line, message: { model: '<synthetic>', usage: {} } })).toBeNull();
    expect(entryFromLine({ timestamp: 't', message: {} })).toBeNull();
  });
  it('dedupes repeated content-block lines, keeping the last', () => {
    const out = dedupeEntries([e('1', 'a', 5, 'opus', 'k'), e('1', 'a', 9, 'opus', 'k'), e('2', 'a', 1)]);
    expect(out.map((x) => x.weighted).sort()).toEqual([1, 9]);
  });
  it('sums per branch with a model split, heaviest first', () => {
    const rows = attributeByBranch([e('1', 'a', 5, 'opus'), e('1', 'a', 3, 'sonnet'), e('1', 'b', 10, 'haiku')]);
    expect(rows.map((r) => r.branch)).toEqual(['b', 'a']);
    expect(rows[1].byFamily).toEqual({ opus: 5, sonnet: 3, haiku: 0, other: 0 });
  });
});

describe('windowing', () => {
  const es = [e('2026-09-29T23:59:59Z', 'a', 1), e('2026-09-30T00:00:00Z', 'a', 2), e('2026-10-01T00:00:00Z', 'a', 4)];
  it('is since-inclusive and until-exclusive', () => {
    expect(filterWindow(es, '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z').map((x) => x.weighted)).toEqual([2]);
    expect(filterWindow(es).length).toBe(3);
  });
});

describe('task classification', () => {
  it('accepts task prefixes and rejects integration branches', () => {
    for (const p of ['feat', 'fix', 'chore', 'test', 'plan', 'docs', 'agent']) expect(taskKind(`${p}/x`)).toBe(p);
    for (const b of ['dev', 'main', 'staging', 'worktree-agent-abc', 'release/1', '(unknown)']) expect(taskKind(b)).toBeNull();
  });
  it('costs tasks with their dominant family', () => {
    const c = taskCosts([e('1', 'feat/a', 5, 'opus'), e('1', 'feat/a', 9, 'sonnet'), e('1', 'dev', 99)]);
    expect(c).toEqual([{ branch: 'feat/a', kind: 'feat', family: 'sonnet', weighted: 14 }]);
  });
});

describe('calibration math', () => {
  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it('weeks start on Monday UTC', () => {
    expect(weekStart('2026-09-30T12:00:00Z')).toBe('2026-09-28T00:00:00.000Z');
    expect(weekStart('2026-10-04T23:00:00Z')).toBe('2026-09-28T00:00:00.000Z');
  });
  it('needs two rising entries in one week, and never invents a window', () => {
    expect(calibrationWindow([])).toBeNull();
    expect(calibrationWindow(cleanCalibration([{ at: '2026-09-29T00:00:00Z', weeklyPercent: 5 }]))).toBeNull();
    // different weeks
    expect(calibrationWindow(cleanCalibration([{ at: '2026-09-27T00:00:00Z', weeklyPercent: 5 }, { at: '2026-09-29T00:00:00Z', weeklyPercent: 9 }]))).toBeNull();
    // percent fell => reset in between
    expect(calibrationWindow(cleanCalibration([{ at: '2026-09-29T00:00:00Z', weeklyPercent: 50 }, { at: '2026-09-30T00:00:00Z', weeklyPercent: 4 }]))).toBeNull();
  });
  it('windows the first to last entry of the week', () => {
    const w = calibrationWindow(cleanCalibration([
      { at: '2026-09-30T00:00:00Z', weeklyPercent: 30 }, { at: '2026-09-29T00:00:00Z', weeklyPercent: 10 }, { at: 'bad', weeklyPercent: 1 }, { at: '2026-09-29T12:00:00Z', weeklyPercent: 20 }
    ]));
    expect(w).toEqual({ from: '2026-09-29T00:00:00Z', to: '2026-09-30T00:00:00Z', percentDelta: 20 });
  });
  it('tokens per percent and tasks per week', () => {
    const usage = [e('2026-09-29T00:00:01Z', 'feat/a', 400), e('2026-09-29T12:00:00Z', 'feat/b', 600), e('2026-10-02T00:00:00Z', 'feat/c', 9999)];
    const w = { from: '2026-09-29T00:00:00Z', to: '2026-09-30T00:00:00Z', percentDelta: 10 };
    const tpp = tokensPerPercent(usage, w);
    expect(tpp).toBe(100);
    // 100% = 10000 tokens; median task 500 => 20 tasks/week
    expect(tasksPerWeek(tpp, [400, 600]).tasksPerWeek).toBe(20);
    expect(tasksPerWeek(tpp, []).tasksPerWeek).toBe(0);
  });
  it('groups by kind and family', () => {
    const g = groupTasksPerWeek(10, [
      { branch: 'feat/a', kind: 'feat', family: 'opus', weighted: 100 },
      { branch: 'fix/b', kind: 'fix', family: 'sonnet', weighted: 50 }
    ]);
    expect(g.overall.tasks).toBe(2);
    expect(g.byKind.map((r) => r.key).sort()).toEqual(['feat', 'fix']);
    expect(g.byFamily.find((r) => r.key === 'sonnet')!.tasksPerWeek).toBe(20);
  });
});
