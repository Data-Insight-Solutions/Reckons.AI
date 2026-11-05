import { readFileSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';

/**
 * F275.3 — demo recording inside a test workflow's step loop.
 *
 * A NO-OP UNLESS THE RENDER ASKS FOR IT. `npm run demo:render` (scripts/demo/render.ts) writes a
 * timings file and sets DEMO_TIMINGS / DEMO_MARKS; the ordinary e2e run sets neither, so the test
 * runs exactly as before. The test's own assertions still run in demo mode, so a demo cannot be
 * recorded of an app that fails its test.
 *
 * Each step: mark its start, run it, then wait until its narration has finished (the hold the
 * render computed from the clip's measured length). The marks are offsets from the test body's
 * start; the render shifts them by the gap between the video's start and the test body's start,
 * which it measures as (video duration - endedAtMs).
 */

export type DemoMark = { stepId: string; startMs: number; endMs: number };
export type DemoMarksFile = { marks: DemoMark[]; endedAtMs: number };
export type DemoTimingsFile = { holds: Record<string, number> };

/** What is left to wait after a step's action took `elapsedMs`, so the step lasts `holdMs`. */
export function remainingHoldMs(elapsedMs: number, holdMs: number): number {
  return Math.max(0, Math.round(holdMs - elapsedMs));
}

export interface DemoRecorder {
  readonly active: boolean;
  step(stepId: string, run: () => Promise<void>): Promise<void>;
  finish(): void;
}

/** True while `npm run demo:render` records; a test keeps the demo's 1920x1080 viewport instead of its own. */
export function isDemoRender(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.DEMO_TIMINGS && env.DEMO_MARKS);
}

export function demoRecorder(page: Page, env: NodeJS.ProcessEnv = process.env): DemoRecorder {
  const timingsPath = env.DEMO_TIMINGS;
  const marksPath = env.DEMO_MARKS;
  if (!timingsPath || !marksPath) {
    return { active: false, step: async (_id, run) => run(), finish: () => {} };
  }
  const { holds } = JSON.parse(readFileSync(timingsPath, 'utf8')) as DemoTimingsFile;
  const t0 = Date.now();
  const marks: DemoMark[] = [];
  return {
    active: true,
    async step(stepId, run) {
      const hold = holds[stepId];
      if (hold === undefined) throw new Error(`demo timings have no hold for step "${stepId}"`);
      const startMs = Date.now() - t0;
      await run();
      await page.waitForTimeout(remainingHoldMs(Date.now() - t0 - startMs, hold));
      marks.push({ stepId, startMs, endMs: Date.now() - t0 });
    },
    finish() {
      const file: DemoMarksFile = { marks, endedAtMs: Date.now() - t0 };
      writeFileSync(marksPath, JSON.stringify(file, null, 2));
    },
  };
}
