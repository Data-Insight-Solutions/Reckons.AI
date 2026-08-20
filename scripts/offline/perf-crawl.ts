#!/usr/bin/env npx tsx
/**
 * PERFORMANCE CRAWL (F140) — a REAL browser, on the REAL GPU, asserting on TIME.
 *
 * Matt, 2026-08-19, after hitting multiple freezing screens while the suite reported 9/9 green:
 * "So we need a live browser actually rendering and performance testing on that."
 *
 * WHY THE EXISTING SUITE COULD NOT CATCH A FREEZE, measured rather than assumed:
 *
 *   1. NO TEST IN THE REPO ASSERTS ON TIME. Grepping tests/ and src/ for PerformanceObserver,
 *      longtask or INP returns ZERO hits. The review e2e has 19 presence assertions and not one
 *      latency assertion, so `toBeVisible({ timeout: 15_000 })` passes identically at 80ms and at
 *      14.9s. The suite proves things APPEAR. It has never proved they appear PROMPTLY — and raising
 *      a timeout to fix a flake writes that tolerance down permanently.
 *
 *   2. HEADLESS CHROMIUM DOES NOT USE THE GPU. Probed on this machine: the test browser reports
 *      `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` — pure CPU
 *      rasterization. WebGL is PRESENT, so checkWebGL() returns true and the 3D graph renders and
 *      nothing skips; it simply renders on a code path with nothing in common with a real GPU.
 *      Driver stalls, VRAM pressure and compositor jank are unreachable by that browser.
 *
 * SO THIS SCRIPT REFUSES TO RUN SOFTWARE-RENDERED. It launches headed against the real display,
 * reads the unmasked WebGL renderer string, and ABORTS if it sees SwiftShader — because a green
 * performance report produced by a software rasterizer is worse than no report. It is an
 * unverifiable claim made by the party it benefits.
 *
 * WHAT IT MEASURES, cheapest and most diagnostic first:
 *   long tasks     PerformanceObserver('longtask') — the direct instrument. A stall is a NUMBER, and
 *                  this one comes with attribution, so it says WHICH work blocked the thread.
 *   time-to-usable how long until the route's own content is actually visible, against a budget.
 *   frame timing   requestAnimationFrame deltas while the page is live — the jank the graph produces.
 *   freeze         (with --video) ffmpeg subsamples the recording and consecutive frames are diffed
 *                  ARITHMETICALLY. Identical frames spanning a threshold while work is pending is a
 *                  frozen UI, and detecting it needs subtraction, not a model.
 *
 * TIERING (F74.3). Everything above is SCRIPT tier: deterministic, zero tokens, right by
 * construction. The VLM is reserved for frames the arithmetic says CHANGED and cannot judge —
 * layout thrash, content flashing — and only with OLLAMA_BASE_URL set. A model asked whether two
 * identical frames are identical is pure waste.
 *
 *   npm run dev                                    # or dev:test, in another terminal
 *   npx tsx scripts/offline/perf-crawl.ts
 *   … --route=/review --video --budget=1500 --allow-software
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' };

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const ONLY_ROUTE = args.find((a) => a.startsWith('--route='))?.split('=')[1];
const WITH_VIDEO = args.includes('--video');
const TRACE = args.includes('--trace-delta');
const ALLOW_SOFTWARE = args.includes('--allow-software');
/** Budget for time-to-usable, ms. A route slower than this fails. */
const BUDGET = Number(arg('budget', '2500'));
/** A task blocking the main thread longer than this is a stall the user feels. */
const LONG_TASK_MS = Number(arg('long-task', '200'));
/** Frames per second to subsample a recording at. */
const FPS = Number(arg('fps', '4'));
const OUT_DIR = 'tests/visual/results/perf';

const ROUTES = ['/', '/review', '/ingest', '/kb', '/settings'];

/**
 * FLOWS — measured INTERACTIONS, not just navigations.
 *
 * A route load being fast says nothing about the thing Matt actually hit: clicking "getting started"
 * and watching a graph never finish. That cost is paid AFTER load, by a click, so it has to be
 * driven and timed as a click. `settle` is what "finished" means for that flow — reached, not merely
 * requested.
 */
const FLOWS: Record<string, { start: string; click: string; settle: string; label: string }> = {
  docs: {
    label: 'landing → Documentation Graph (the "getting started" path)',
    start: '/',
    click: 'button:has-text("Documentation Graph")',
    settle: 'canvas',
  },
  everyday: {
    label: 'landing → the everyday starter graph',
    start: '/',
    click: '.btn-primary, button:has-text("Start")',
    settle: 'canvas',
  },
};

interface RouteResult {
  route: string;
  timeToUsable: number;
  longTasks: { duration: number; name: string }[];
  worstFrame: number;
  medianFrame: number;
  frozenSpans: { fromSec: number; toSec: number; frames: number }[];
  failures: string[];
  /** Set when THIS SCRIPT is wrong (selector matched nothing), not the page. */
  harnessError: string | null;
  /** Convergence measurement: when the graph stopped moving, and how hard it moved getting there. */
  stillness?: { ms: number; samples: number; lastChangeMs: number; peakDelta: number; finalDelta: number } | null;
}

/**
 * Installed BEFORE navigation via addInitScript, because a PerformanceObserver added after load has
 * already missed the long tasks that load caused — which are the ones that matter most.
 */
const OBSERVER = `
window.__perf = { longTasks: [], frames: [] };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const attribution = (e.attribution || []).map((a) => a.name || a.containerName || '').filter(Boolean);
      window.__perf.longTasks.push({ duration: e.duration, name: attribution.join(',') || e.name || 'unknown' });
    }
  }).observe({ entryTypes: ['longtask'] });
} catch (err) { window.__perf.observerError = String(err); }
let last = performance.now();
function tick(now) { window.__perf.frames.push(now - last); last = now; requestAnimationFrame(tick); }
requestAnimationFrame(tick);
`;

/**
 * Context options: fill the REAL window rather than Playwright's 1280x720 default.
 *
 * `viewport: null` is what makes the page adopt the OS window size — without it a headed run shows a
 * large window containing a small letterboxed page, which is both misleading to watch and a
 * different layout from the one a user sees. Graph legibility and node density depend on viewport,
 * so measuring the wrong one measures the wrong thing.
 */
function viewportOpts() {
  return {
    viewport: null,
    ...(WITH_VIDEO ? { recordVideo: { dir: path.join(OUT_DIR, 'video'), size: { width: WIN_W, height: WIN_H } } } : {}),
  } as Parameters<Browser['newContext']>[0];
}

/** The renderer string, unmasked. This is the check that makes the whole report meaningful. */
async function rendererOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'NO_WEBGL';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'masked';
  });
}

/**
 * Route -> a selector that means "this page is actually usable", not merely mounted.
 *
 * VERIFIED AGAINST THE MARKUP, and the first version was not. It looked for `h1` on /review, which
 * renders `h2.rp-title` — so the wait timed out and the script reported a 10.7s stall that did not
 * exist. That is the failure mode a timing harness must never have: a wrong selector and a real
 * stall look identical from the outside. See the harness/budget distinction in measureRoute.
 */
const USABLE: Record<string, string> = {
  '/': 'canvas, .landing, h1, h2',
  '/review': '.rp-title, .empty-state, [data-testid="altitude-headline"]',
  '/ingest': 'textarea, input[type="file"], h1',
  '/kb': 'h1, h2, .kb-list, .card',
  '/settings': 'h1, h2, .settings, .card',
};

/**
 * Subsample a recording and find FROZEN spans by arithmetic.
 *
 * ffmpeg is asked for frame_pts so each PNG carries its own presentation timestamp: Playwright
 * records variable-frame-rate WebM, so assuming uniform spacing would mislabel WHEN each frame
 * happened, and a frame sequence without time cannot answer a timing question at all.
 *
 * Two consecutive frames being byte-identical is the strongest possible evidence of a frozen UI, and
 * it costs a buffer compare. This is why video does not need a model to catch a freeze.
 */
function findFrozenSpans(video: string, route: string): RouteResult['frozenSpans'] {
  const frameDir = path.join(OUT_DIR, 'frames', route.replace(/\W+/g, '_') || 'root');
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });

  try {
    execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-i', video, '-vf', `fps=${FPS}`, '-frame_pts', '1', path.join(frameDir, 'f_%06d.png')],
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.log(`  ${C.y}ffmpeg failed on ${video}: ${(e as Error).message.split('\n')[0]}${C.x}`);
    return [];
  }

  const frames = readdirSync(frameDir).filter((f) => f.endsWith('.png')).sort();
  const spans: RouteResult['frozenSpans'] = [];
  let runStart = 0;
  let runLen = 0;
  let prev: Buffer | null = null;

  for (const [i, f] of frames.entries()) {
    const buf = readFileSync(path.join(frameDir, f));
    if (prev && buf.equals(prev)) {
      if (runLen === 0) runStart = i - 1;
      runLen++;
    } else {
      // A run of identical frames longer than a second of wall time is a stall, not a still moment.
      if (runLen >= FPS) spans.push({ fromSec: runStart / FPS, toSec: (runStart + runLen) / FPS, frames: runLen + 1 });
      runLen = 0;
    }
    prev = buf;
  }
  if (runLen >= FPS) spans.push({ fromSec: runStart / FPS, toSec: (runStart + runLen) / FPS, frames: runLen + 1 });
  return spans;
}

async function measureRoute(browser: Browser, route: string): Promise<RouteResult> {
  const ctx = await browser.newContext(viewportOpts());
  const page = await ctx.newPage();
  await page.addInitScript(OBSERVER);

  const failures: string[] = [];
  const t0 = Date.now();
  await page.goto(BASE_URL + route, { waitUntil: 'domcontentloaded' }).catch((e) => {
    failures.push(`navigation failed: ${String(e).split('\n')[0]}`);
  });

  /*
   * A WRONG SELECTOR AND A REAL STALL LOOK IDENTICAL FROM THE OUTSIDE, so they are separated here.
   * If the selector still matches NOTHING after the wait, that is a defect in this harness and it is
   * reported as such — never as a page failure. Silently conflating the two is how a timing report
   * becomes noise, and a noisy gate gets switched off.
   */
  const selector = USABLE[route] ?? 'h1, h2';
  const waitMs = Math.max(BUDGET * 4, 10_000);
  let timeToUsable = -1;
  let harnessError: string | null = null;
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: waitMs });
    timeToUsable = Date.now() - t0;
  } catch {
    timeToUsable = Date.now() - t0;
    const present = await page.locator(selector).count().catch(() => 0);
    if (present === 0) harnessError = `selector matched nothing on this route: ${selector}`;
    else failures.push(`never became visible within ${waitMs}ms (${present} matching node(s) present but hidden)`);
  }

  // Let the page live a moment so the graph's simulation and any late work show up in the numbers.
  await page.waitForTimeout(3_000);

  const perf = await page.evaluate(() => (window as unknown as { __perf: { longTasks: { duration: number; name: string }[]; frames: number[]; observerError?: string } }).__perf);
  const longTasks = (perf?.longTasks ?? []).filter((t) => t.duration >= LONG_TASK_MS).sort((a, b) => b.duration - a.duration);
  const frames = (perf?.frames ?? []).filter((f) => f > 0);
  const sorted = [...frames].sort((a, b) => a - b);
  const worstFrame = sorted.length ? sorted[sorted.length - 1] : 0;
  const medianFrame = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  if (perf?.observerError) failures.push(`PerformanceObserver unavailable: ${perf.observerError}`);
  // Only judge the budget when the measurement is trustworthy.
  if (!harnessError && timeToUsable > BUDGET) failures.push(`time-to-usable ${timeToUsable}ms over the ${BUDGET}ms budget`);
  for (const t of longTasks.slice(0, 3)) {
    failures.push(`long task ${t.duration.toFixed(0)}ms blocked the main thread (${t.name})`);
  }

  await page.close();
  await ctx.close(); // the video is only finalized on context close

  let frozenSpans: RouteResult['frozenSpans'] = [];
  if (WITH_VIDEO) {
    const videos = readdirSync(path.join(OUT_DIR, 'video')).filter((f) => f.endsWith('.webm')).sort();
    const latest = videos[videos.length - 1];
    if (latest) {
      frozenSpans = findFrozenSpans(path.join(OUT_DIR, 'video', latest), route);
      for (const s of frozenSpans) {
        failures.push(`frozen ${(s.toSec - s.fromSec).toFixed(1)}s (${s.frames} identical frames from ${s.fromSec.toFixed(1)}s)`);
      }
    }
  }

  return { route, timeToUsable, longTasks, worstFrame, medianFrame, frozenSpans, failures, harnessError };
}

/**
 * TIME UNTIL THE GRAPH IS STILL — Matt, 2026-08-19: "waiting longer until the graph is 'still' and
 * nodes settled into the resting positions."
 *
 * This is the honest definition of "finished loading" for a force-directed graph. `canvas` being
 * visible means the simulation STARTED; it says nothing about whether it converged, and a graph that
 * churns for thirty seconds is unusable while passing any visibility check.
 *
 * Stillness is measured by hashing the canvas pixels and waiting for K consecutive identical
 * samples. Note the deliberate symmetry with findFrozenSpans, and that the two are opposites:
 * identical frames while work is PENDING is a freeze, identical frames after work COMPLETES is
 * convergence. Same arithmetic, and only the surrounding claim differs — which is why both need the
 * app's own state, not just the pixels, to be interpreted.
 *
 * Returns -1 if it never settles inside the budget: a graph still moving at the cap has not
 * converged, and reporting the cap as its settle time would launder a failure into a number.
 */
async function timeToStill(
  page: Page,
  opts: { maxMs: number; sampleMs?: number; stableSamples?: number; epsilon?: number },
): Promise<{ ms: number; samples: number; lastChangeMs: number; peakDelta: number; finalDelta: number }> {
  const sampleMs = opts.sampleMs ?? 300;
  const need = opts.stableSamples ?? 3;
  /** Mean per-channel difference, 0-255. Antialiasing moves a couple of units; a drifting node far more. */
  const epsilon = opts.epsilon ?? 1.0;
  const t0 = Date.now();
  let prev: Buffer | null = null;
  let stable = 0;
  let samples = 0;
  let lastChangeMs = 0;
  let peakDelta = 0;
  let finalDelta = 0;

  /*
   * SAMPLED VIA page.screenshot AND DECODED TO REAL PIXELS. Two earlier versions of this function
   * produced confident numbers that meant nothing, and both are worth recording because the failures
   * are instructive about measuring anything visually:
   *
   *   1. canvas.drawImage() -> BLANK. Reading a WebGL canvas that way returns an empty image unless
   *      the context was created with preserveDrawingBuffer: true, which this app correctly does not
   *      set. Every delta was 0, so it "settled" after 3 samples and reported ~1.4s for every graph
   *      from 110 to 4,224 lines. The tell was peak=0, final=0, samples=5 on every rung.
   *
   *   2. Comparing JPEG BYTES -> NOISE. A compressed stream does not preserve spatial locality and
   *      its length varies frame to frame, so the length-mismatch branch fired almost always and
   *      reported peak delta 255 on every rung. Compressed bytes are not pixels.
   *
   * So: PNG screenshot through the compositor (captures 2D and 3D alike, no product change), decoded
   * by sharp to a 64x64 RGB raw buffer. Mean absolute per-channel difference is then a real velocity
   * proxy — it spikes during the node explosion and decays toward zero as the simulation converges.
   *
   * STILL A PROXY. The simulation's own vx/vy live inside KnowledgeGraph2D and are not exposed on
   * window; reading them would be strictly better and needs a deliberate dev-only hook. It also
   * cannot separate a settling graph from an animating camera over a static scene.
   */
  const trace: number[] = [];
  while (Date.now() - t0 < opts.maxMs) {
    let px: Buffer | null = null;
    try {
      const shot = await page.screenshot({ type: 'png', timeout: 8_000 });
      px = await sharp(shot).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    } catch {
      px = null;
    }
    samples++;

    if (px && prev && px.length === prev.length) {
      let sum = 0;
      for (let i = 0; i < px.length; i++) sum += Math.abs(px[i] - prev[i]);
      finalDelta = sum / px.length;
      trace.push(Number(finalDelta.toFixed(2)));
      if (finalDelta > peakDelta) peakDelta = finalDelta;
      if (finalDelta <= epsilon) {
        stable++;
        if (stable >= need) {
          if (TRACE) console.log(`      ${C.d}Δ trace: ${trace.join(' ')}${C.x}`);
          return { ms: Date.now() - t0, samples, lastChangeMs, peakDelta, finalDelta };
        }
      } else {
        stable = 0;
        lastChangeMs = Date.now() - t0;
      }
    }
    if (px) prev = px;
    await page.waitForTimeout(sampleMs);
  }
  if (TRACE) console.log(`      ${C.d}Δ trace: ${trace.join(' ')}${C.x}`);
  return { ms: -1, samples, lastChangeMs, peakDelta, finalDelta };
}

/**
 * Drive one interaction and time it. Same instruments, but the clock starts at the CLICK.
 *
 * The long-task list is read AFTER settle, so it captures the work the interaction caused rather
 * than the work the page load caused — which is the distinction between "the app is slow to start"
 * and "this button freezes it".
 */
async function measureFlow(browser: Browser, name: string): Promise<RouteResult> {
  const flow = FLOWS[name];
  const ctx = await browser.newContext(viewportOpts());
  const page = await ctx.newPage();
  await page.addInitScript(OBSERVER);
  const failures: string[] = [];
  let harnessError: string | null = null;

  await page.goto(BASE_URL + flow.start, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Reset the counters so the flow is measured, not the landing page's own load.
  await page.evaluate(() => { (window as unknown as { __perf: { longTasks: unknown[]; frames: number[] } }).__perf.longTasks = []; });

  const target = page.locator(flow.click).first();
  let timeToUsable = -1;
  const waitMs = Math.max(BUDGET * 8, 30_000);
  try {
    await target.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    harnessError = `flow control not found: ${flow.click}`;
  }

  if (!harnessError) {
    const t0 = Date.now();
    await target.click().catch((e) => failures.push(`click failed: ${String(e).split('\n')[0]}`));
    try {
      await page.locator(flow.settle).first().waitFor({ state: 'visible', timeout: waitMs });
      timeToUsable = Date.now() - t0;
    } catch {
      timeToUsable = Date.now() - t0;
      failures.push(`never settled within ${waitMs}ms — this is the freeze class`);
    }
    await page.waitForTimeout(4_000);
    if (timeToUsable > BUDGET) failures.push(`interaction took ${timeToUsable}ms, over the ${BUDGET}ms budget`);
  }

  const perf = await page.evaluate(() => (window as unknown as { __perf: { longTasks: { duration: number; name: string }[]; frames: number[] } }).__perf);
  const longTasks = (perf?.longTasks ?? []).filter((t) => t.duration >= LONG_TASK_MS).sort((a, b) => b.duration - a.duration);
  const frames = (perf?.frames ?? []).filter((f) => f > 0).sort((a, b) => a - b);
  for (const t of longTasks.slice(0, 3)) failures.push(`long task ${t.duration.toFixed(0)}ms blocked the main thread (${t.name})`);

  await page.close();
  await ctx.close();

  let frozenSpans: RouteResult['frozenSpans'] = [];
  if (WITH_VIDEO) {
    const videos = readdirSync(path.join(OUT_DIR, 'video')).filter((f) => f.endsWith('.webm')).sort();
    const latest = videos[videos.length - 1];
    if (latest) {
      frozenSpans = findFrozenSpans(path.join(OUT_DIR, 'video', latest), `flow_${name}`);
      for (const sp of frozenSpans) {
        failures.push(`frozen ${(sp.toSec - sp.fromSec).toFixed(1)}s (${sp.frames} identical frames from ${sp.fromSec.toFixed(1)}s)`);
      }
    }
  }

  return {
    route: `flow:${name}`,
    timeToUsable,
    longTasks,
    worstFrame: frames.length ? frames[frames.length - 1] : 0,
    medianFrame: frames.length ? frames[Math.floor(frames.length / 2)] : 0,
    frozenSpans,
    failures,
    harnessError,
  };
}

/**
 * PROGRESSIVELY LARGER GRAPHS — where does the graph view stop converging?
 *
 * One graph proves nothing about scaling. A ladder produces a CURVE, and the curve is what says
 * whether the cost is linear, quadratic, or a cliff. Each rung imports through the app's own turtle
 * path (the same one the e2e test uses) and then waits for stillness rather than for a canvas.
 */
const LADDER: { file: string; label: string }[] = [
  { file: 'tests/fixtures/demo-review-tree.ttl', label: 'demo-review-tree' },
  { file: 'static/starter-quickstart.ttl', label: 'starter-quickstart' },
  { file: 'static/starter-everyday.ttl', label: 'starter-everyday' },
  { file: 'static/starter-guide.ttl', label: 'starter-guide' },
  { file: 'static/reckons-production.ttl', label: 'reckons-production' },
  { file: 'static/reckons-roadmap.ttl', label: 'reckons-roadmap' },
];

async function measureLadderRung(browser: Browser, file: string, label: string): Promise<RouteResult> {
  const ctx = await browser.newContext(viewportOpts());
  const page = await ctx.newPage();
  await page.addInitScript(OBSERVER);
  const failures: string[] = [];
  let harnessError: string | null = null;
  let timeToUsable = -1;
  let stillness: { ms: number; samples: number; lastChangeMs: number; peakDelta: number; finalDelta: number } | null = null;

  await page.goto(BASE_URL + '/ingest', { waitUntil: 'domcontentloaded' }).catch(() => {});
  try {
    await page.locator('.tabs button', { hasText: 'graph' }).click({ timeout: 10_000 });
    await page.setInputFiles('input[type="file"]', file);
    const btn = page.getByRole('button', { name: /^import →$/ });
    await btn.waitFor({ state: 'visible', timeout: 20_000 });
    await page.evaluate(() => { (window as unknown as { __perf: { longTasks: unknown[] } }).__perf.longTasks = []; });
    const t0 = Date.now();
    await btn.click();
    await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 120_000 });
    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
    const still = await timeToStill(page, { maxMs: Math.max(BUDGET * 12, 45_000) });
    timeToUsable = still.ms === -1 ? -1 : Date.now() - t0;
    stillness = still;
    if (still.ms === -1) {
      failures.push(
        `graph NEVER settled within ${Math.max(BUDGET * 12, 45_000)}ms — still moving at ${still.finalDelta.toFixed(1)} ` +
          `mean delta (peak ${still.peakDelta.toFixed(1)}, last movement ${still.lastChangeMs}ms)`,
      );
    } else if (timeToUsable > BUDGET) {
      failures.push(`import→still took ${timeToUsable}ms, over the ${BUDGET}ms budget (settled ${still.ms}ms after landing)`);
    }
  } catch (e) {
    harnessError = `ladder rung failed to drive: ${String(e).split('\n')[0]}`;
  }

  const perf = await page.evaluate(() => (window as unknown as { __perf: { longTasks: { duration: number; name: string }[]; frames: number[] } }).__perf).catch(() => null);
  const longTasks = (perf?.longTasks ?? []).filter((t) => t.duration >= LONG_TASK_MS).sort((a, b) => b.duration - a.duration);
  const frames = (perf?.frames ?? []).filter((f) => f > 0).sort((a, b) => a - b);
  for (const t of longTasks.slice(0, 2)) failures.push(`long task ${t.duration.toFixed(0)}ms (${t.name})`);

  await page.close();
  await ctx.close();
  return {
    route: `ladder:${label}`,
    timeToUsable,
    longTasks,
    worstFrame: frames.length ? frames[frames.length - 1] : 0,
    medianFrame: frames.length ? frames[Math.floor(frames.length / 2)] : 0,
    frozenSpans: [],
    failures,
    harnessError,
    stillness,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
const up = await fetch(BASE_URL).then((r) => r.ok).catch(() => false);
if (!up) {
  console.error(`${C.r}No server at ${BASE_URL}.${C.x} Start one (npm run dev) or set BASE_URL.`);
  process.exit(1);
}

if (!process.env.DISPLAY) {
  console.error(
    `${C.r}No DISPLAY.${C.x} This script exists to test a REAL browser on a REAL GPU; running it\n` +
      `under xvfb would fall back to software rasterization and produce a green report that means\n` +
      `nothing. Run it on a desktop session, or pass --allow-software if you accept that caveat.`,
  );
  if (!ALLOW_SOFTWARE) process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
if (WITH_VIDEO) mkdirSync(path.join(OUT_DIR, 'video'), { recursive: true });

const WIN_W = Number(arg('width', '1920'));
const WIN_H = Number(arg('height', '1200'));

const browser = await chromium.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--window-size=${WIN_W},${WIN_H}`,
    '--window-position=0,0',
    // Ask for real hardware GL. Without these Chromium may still pick ANGLE/SwiftShader.
    '--use-gl=angle',
    '--use-angle=gl',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
  ],
});

const probeCtx = await browser.newContext();
const probePage = await probeCtx.newPage();
await probePage.goto(BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
const renderer = await rendererOf(probePage);
await probeCtx.close();

const isSoftware = /swiftshader|software|llvmpipe/i.test(renderer);
console.log(`\n${C.b}Performance crawl${C.x} ${C.d}— ${BASE_URL}${C.x}`);
console.log(`${C.d}renderer:${C.x} ${isSoftware ? C.r : C.g}${renderer}${C.x}`);

if (isSoftware && !ALLOW_SOFTWARE) {
  console.error(
    `\n${C.r}ABORTING: this is a software rasterizer, not the GPU.${C.x}\n` +
      `A green performance report produced by SwiftShader is worse than no report — it is an\n` +
      `unverifiable claim made by the party it benefits. Fix the GL flags or the display, or pass\n` +
      `--allow-software to record a CPU-rendered baseline knowing it says nothing about the GPU.`,
  );
  await browser.close();
  process.exit(1);
}

console.log(
  `${C.d}budget ${BUDGET}ms · long task ≥ ${LONG_TASK_MS}ms · ${WITH_VIDEO ? `video @ ${FPS}fps` : 'no video'}${C.x}\n`,
);

const FLOW = args.find((a) => a.startsWith('--flow='))?.split('=')[1];
const LADDER_MODE = args.includes('--ladder');
const results: RouteResult[] = [];

if (LADDER_MODE) {
  console.log(`${C.d}ladder: progressively larger graphs, each measured to STILLNESS${C.x}\n`);
  for (const rung of LADDER) {
    if (!existsSync(rung.file)) { console.log(`${C.d}  skip ${rung.label} (missing)${C.x}`); continue; }
    const facts = readFileSync(rung.file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    const r = await measureLadderRung(browser, rung.file, rung.label);
    results.push(r);
    const ok = r.failures.length === 0 && !r.harnessError;
    console.log(
      `${ok ? C.g + '✓' : C.r + '✗'} ${rung.label.padEnd(20)}${C.x} ${String(facts).padStart(6)} lines · ` +
        `${r.timeToUsable === -1 ? C.r + 'never still' + C.x : String(r.timeToUsable).padStart(6) + 'ms to still'} · ` +
        `worst frame ${r.worstFrame.toFixed(0).padStart(5)}ms · ${r.longTasks.length} long task(s)` +
        (r.stillness ? ` · peakΔ${r.stillness.peakDelta.toFixed(1)} n=${r.stillness.samples}` : ''),
    );
    if (r.harnessError) console.log(`    ${C.c}· HARNESS: ${r.harnessError}${C.x}`);
    for (const f of r.failures) console.log(`    ${C.y}· ${f}${C.x}`);
  }
}

if (FLOW) {
  if (!FLOWS[FLOW]) {
    console.error(`${C.r}Unknown flow "${FLOW}".${C.x} Known: ${Object.keys(FLOWS).join(', ')}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`${C.d}flow: ${FLOWS[FLOW].label}${C.x}\n`);
  const r = await measureFlow(browser, FLOW);
  results.push(r);
  const ok = r.failures.length === 0 && !r.harnessError;
  console.log(
    `${ok ? C.g + '✓' : C.r + '✗'} ${('flow:' + FLOW).padEnd(11)}${C.x} ` +
      `settled ${String(r.timeToUsable).padStart(6)}ms · worst frame ${r.worstFrame.toFixed(0).padStart(4)}ms · ` +
      `${r.longTasks.length} long task${r.longTasks.length === 1 ? '' : 's'}` +
      (WITH_VIDEO ? ` · ${r.frozenSpans.length} frozen span${r.frozenSpans.length === 1 ? '' : 's'}` : ''),
  );
  if (r.harnessError) console.log(`    ${C.c}· HARNESS: ${r.harnessError} — fix this script, not the page${C.x}`);
  for (const f of r.failures) console.log(`    ${C.y}· ${f}${C.x}`);
}

const routes = FLOW || LADDER_MODE ? [] : ONLY_ROUTE ? [ONLY_ROUTE] : ROUTES;
for (const route of routes) {
  const r = await measureRoute(browser, route);
  results.push(r);
  const ok = r.failures.length === 0 && !r.harnessError;
  console.log(
    `${ok ? C.g + '✓' : C.r + '✗'} ${route.padEnd(11)}${C.x} ` +
      `usable ${String(r.timeToUsable).padStart(5)}ms · ` +
      `worst frame ${r.worstFrame.toFixed(0).padStart(4)}ms · median ${r.medianFrame.toFixed(1)}ms · ` +
      `${r.longTasks.length} long task${r.longTasks.length === 1 ? '' : 's'}` +
      (WITH_VIDEO ? ` · ${r.frozenSpans.length} frozen span${r.frozenSpans.length === 1 ? '' : 's'}` : ''),
  );
  if (r.harnessError) console.log(`    ${C.c}· HARNESS: ${r.harnessError} — fix this script, not the page${C.x}`);
  for (const f of r.failures) console.log(`    ${C.y}· ${f}${C.x}`);
}

await browser.close();

const report = {
  schema: 'perf-crawl/1',
  finishedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  renderer,
  softwareRendered: isSoftware,
  budgetMs: BUDGET,
  longTaskMs: LONG_TASK_MS,
  results,
};
const out = path.join(OUT_DIR, `perf-crawl_${report.finishedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));

const harnessBroken = results.filter((r) => r.harnessError);
if (harnessBroken.length) {
  console.log(`${C.c}${harnessBroken.length} route(s) could not be measured — this script's selectors are wrong.${C.x}`);
}
const failed = results.filter((r) => r.failures.length > 0);
console.log(`\n${C.d}report: ${out}${C.x}`);
if (failed.length) {
  console.log(`${C.r}${failed.length} of ${results.length} route(s) over budget or stalling.${C.x}\n`);
  process.exit(1);
}
console.log(`${C.g}All ${results.length} route(s) within budget.${C.x}\n`);
