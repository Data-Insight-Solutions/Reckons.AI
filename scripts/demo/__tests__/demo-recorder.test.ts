import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { demoRecorder, remainingHoldMs, type DemoMarksFile } from '../../../tests/e2e/demo-recorder';

/** F275.3 — the recorder in a workflow test's step loop, without a browser. */
const fakePage = () => {
  const waits: number[] = [];
  return { page: { waitForTimeout: async (ms: number) => { waits.push(ms); } } as unknown as Page, waits };
};

describe('remainingHoldMs', () => {
  it('waits out the rest of the hold, never a negative time', () => {
    expect(remainingHoldMs(1000, 4000)).toBe(3000);
    expect(remainingHoldMs(5000, 4000)).toBe(0);
    expect(remainingHoldMs(0, 2500.4)).toBe(2500);
  });
});

describe('demoRecorder', () => {
  it('is a no-op outside a demo render: the step runs, nothing waits, nothing is written', async () => {
    const { page, waits } = fakePage();
    const r = demoRecorder(page, {});
    let ran = false;
    await r.step('a', async () => { ran = true; });
    r.finish();
    expect(r.active).toBe(false);
    expect(ran).toBe(true);
    expect(waits).toEqual([]);
  });

  it('holds each step for its narration and writes one mark per step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-rec-'));
    const timings = join(dir, 't.json');
    const marks = join(dir, 'm.json');
    writeFileSync(timings, JSON.stringify({ holds: { a: 3000, b: 2500 } }));
    const { page, waits } = fakePage();
    const r = demoRecorder(page, { DEMO_TIMINGS: timings, DEMO_MARKS: marks });
    await r.step('a', async () => {});
    await r.step('b', async () => {});
    r.finish();
    expect(r.active).toBe(true);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(2900);
    const out = JSON.parse(readFileSync(marks, 'utf8')) as DemoMarksFile;
    expect(out.marks.map((m) => m.stepId)).toEqual(['a', 'b']);
    expect(out.endedAtMs).toBeGreaterThanOrEqual(out.marks[1].endMs);
  });

  it('fails loudly on a step the timings do not know', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-rec-'));
    const timings = join(dir, 't.json');
    writeFileSync(timings, JSON.stringify({ holds: {} }));
    const r = demoRecorder(fakePage().page, { DEMO_TIMINGS: timings, DEMO_MARKS: join(dir, 'm.json') });
    await expect(r.step('missing', async () => {})).rejects.toThrow(/no hold for step "missing"/);
  });
});
