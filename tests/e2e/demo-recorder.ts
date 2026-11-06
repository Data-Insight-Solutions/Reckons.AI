import { readFileSync, writeFileSync } from 'fs';
import type { Locator, Page } from '@playwright/test';

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

/** speakMs: when the step's subject came on screen (hold) and its line starts; absent = at startMs. */
export type DemoMark = { stepId: string; startMs: number; endMs: number; speakMs?: number };
export type DemoMarksFile = { marks: DemoMark[]; endedAtMs: number };
/** holds: the main line plus a pause, per step; leads: the lead-in question's length, per step. */
export type DemoTimingsFile = { holds: Record<string, number>; leads?: Record<string, number> };

/** What is left to wait after a step's action took `elapsedMs`, so the step lasts `holdMs`. */
export function remainingHoldMs(elapsedMs: number, holdMs: number): number {
  return Math.max(0, Math.round(holdMs - elapsedMs));
}

export interface DemoRecorder {
  readonly active: boolean;
  step(stepId: string, run: () => Promise<void>): Promise<void>;
  /**
   * Call at the step's key moment (where the test takes its screenshot): the narration hold happens
   * HERE, while the subject is on screen, not after the step has closed a viewer or moved on.
   * Found 2026-11-05: the splat step opened the viewer, closed it, then held, so the line about the
   * 3D scene played over the graph. Outside a demo render, or outside a step, it does nothing.
   */
  hold(target?: Locator): Promise<void>;
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
    return { active: false, step: async (_id, run) => run(), hold: async () => {}, finish: () => {} };
  }
  installDemoPointer(page);
  const { holds, leads = {} } = JSON.parse(readFileSync(timingsPath, 'utf8')) as DemoTimingsFile;
  const t0 = Date.now();
  const marks: DemoMark[] = [];
  let current: { startMs: number; hold: number; lead: number; speakMs?: number } | null = null;
  // The line plays from the moment the subject is on screen (hold), or from the step's start when a
  // step has no key moment. Either way the step lasts at least the line.
  const waitOut = async () => {
    if (current) await page.waitForTimeout(remainingHoldMs(Date.now() - t0 - (current.speakMs ?? current.startMs), current.hold));
  };
  return {
    active: true,
    async step(stepId, run) {
      const hold = holds[stepId];
      if (hold === undefined) throw new Error(`demo timings have no hold for step "${stepId}"`);
      const startMs = Date.now() - t0;
      current = { startMs, hold, lead: leads[stepId] ?? 0 };
      await run();
      await waitOut(); // a step that never called hold() still lasts as long as its line
      const speakMs = current.speakMs;
      current = null;
      marks.push({ stepId, startMs, endMs: Date.now() - t0, ...(speakMs !== undefined ? { speakMs } : {}) });
    },
    async hold(target) {
      if (!current) return;
      if (target) await glideTo(page, target);
      // The main line never talks over the lead-in question: wait for it to finish, plus a breath.
      if (current.lead) await page.waitForTimeout(remainingHoldMs(Date.now() - t0 - current.startMs, current.lead + 500));
      if (current.speakMs === undefined) current.speakMs = Date.now() - t0;
      await waitOut();
    },
    finish() {
      const file: DemoMarksFile = { marks, endedAtMs: Date.now() - t0 };
      writeFileSync(marksPath, JSON.stringify(file, null, 2));
    },
  };
}

// ── F275: a visible pointer for demo recordings ─────────────────────────────────────────────────
// Headless recordings show no cursor, and Playwright's clicks jump. In a demo render only, a drawn
// cursor follows the real mouse events, every click first scrolls its target smoothly into view and
// glides the mouse there, and fill() types visibly. Ordinary test runs never reach this code.

/** How many mouse-move steps a glide of `distance` CSS pixels takes: slow enough to follow. Pure. */
export function glideSteps(distance: number): number {
  return Math.max(8, Math.min(24, Math.round(distance / 25)));
}

const CURSOR_SCRIPT = `(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const make = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#0a0f14" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const last = JSON.parse(sessionStorage.getItem('demo-cursor') || '{"x":640,"y":360}');
    c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;pointer-events:none;z-index:2147483647;transform:translate(' + last.x + 'px,' + last.y + 'px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))';
    const r = document.createElement('div');
    r.id = 'demo-cursor-ripple';
    r.style.cssText = 'position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #1a9b8e;pointer-events:none;z-index:2147483646;opacity:0;transform:scale(.3)';
    document.documentElement.append(r, c);
  };
  const ready = () => document.documentElement && make();
  if (!ready()) document.addEventListener('DOMContentLoaded', make);
  addEventListener('mousemove', (e) => {
    make();
    const c = document.getElementById('demo-cursor');
    c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    sessionStorage.setItem('demo-cursor', JSON.stringify({ x: e.clientX, y: e.clientY }));
  }, { capture: true, passive: true });
  addEventListener('mousedown', (e) => {
    const r = document.getElementById('demo-cursor-ripple');
    if (!r) return;
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    r.animate([{ opacity: .9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 450, easing: 'ease-out' });
  }, { capture: true, passive: true });
})();`;

const demoPages = new WeakSet<Page>();
const lastPos = new WeakMap<Page, { x: number; y: number }>();
let patched = false;

/** Scroll `target` smoothly into view, then glide the mouse to its middle. Never throws. */
export async function glideTo(page: Page, target: Locator): Promise<void> {
  try {
    const offscreen = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const out = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
      if (out) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      return out;
    });
    // Let the smooth scroll finish: aim only once the target has stopped moving (a fixed 700 ms was
    // too short on the About page, so the cursor glided to where the card USED to be, 2026-11-05).
    let box = await target.boundingBox();
    if (offscreen) {
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(120);
        const next = await target.boundingBox();
        const still = !!box && !!next && Math.abs(next.y - box.y) < 1 && Math.abs(next.x - box.x) < 1;
        box = next;
        if (still) break;
      }
    }
    if (!box) return;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const from = lastPos.get(page) ?? { x: 640, y: 360 };
    await page.mouse.move(to.x, to.y, { steps: glideSteps(Math.hypot(to.x - from.x, to.y - from.y)) });
    lastPos.set(page, to);
    await page.waitForTimeout(120);
  } catch { /* a target that cannot be scrolled or measured is clicked as before */ }
}

function installDemoPointer(page: Page): void {
  demoPages.add(page);
  void page.addInitScript(CURSOR_SCRIPT);
  void page.evaluate(CURSOR_SCRIPT).catch(() => {});
  if (patched) return;
  patched = true;
  // Patch the Locator class once per worker; only pages registered above take the slow path.
  const proto = Object.getPrototypeOf(page.locator('body')) as Locator & Record<string, unknown>;
  // Only ever patch Playwright's own Locator class, never a plain object's prototype.
  if (!proto || proto === Object.prototype || typeof proto.click !== 'function' || typeof proto.fill !== 'function'
      || typeof proto.pressSequentially !== 'function') { patched = false; return; }
  const click = proto.click as Locator['click'];
  const fill = proto.fill as Locator['fill'];
  proto.click = async function (this: Locator, ...args: Parameters<Locator['click']>) {
    if (demoPages.has(this.page())) await glideTo(this.page(), this);
    return click.apply(this, args);
  } as Locator['click'];
  proto.fill = async function (this: Locator, value: string, options?: Parameters<Locator['fill']>[1]) {
    if (!demoPages.has(this.page())) return fill.call(this, value, options);
    await glideTo(this.page(), this);
    await click.call(this);
    await fill.call(this, '', options);
    await this.pressSequentially(value, { delay: 22 });
  } as Locator['fill'];
}
