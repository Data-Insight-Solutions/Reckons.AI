#!/usr/bin/env npx tsx
/**
 * Space-size bench, BROWSER half (F107.10 kb:space-file-layout). The Node bench measures the file;
 * this measures what a person waits for, so the two can be compared directly (Matt, 2026-10-06:
 * "We should compare with front end renders, which is more impactful for time").
 *
 * Per synthetic space (with and without chunks folded in):
 *   import   ingestNewKb → populateKbFromTtl: parse, recovery snapshot, one Dexie transaction.
 *   open     the space opened in 2D and in 3D, each phase timed from navigation start:
 *              boot     the app shell is up (nav visible)
 *              data     statements read and handed to the graph (renderer leaves 'landing')
 *              ready    first graph frame (data-graph-ready)
 *              settled  layout finished (data-graph-settled), or null if it never did in time
 *            plus long-task total and longest (PerformanceObserver 'longtask', the main-thread
 *            stall a person feels) and frame times for 3 s after ready (p50 / p95).
 *
 * --gpu asks for the real GPU WITHOUT opening a window: Chromium's new headless mode (channel
 * 'chromium') with hardware ANGLE/GL reaches the RTX 3090 on this machine (probed 2026-10-07; old
 * headless only gets SwiftShader). It ABORTS on a software rasterizer, the same refusal as
 * scripts/offline/perf-crawl.ts. A headed run once put windows on Matt's screen mid-work, and he
 * closed them, which the bench then reported as crashes: never measure on someone's display.
 *
 * Needs the app running: `npm run dev:test` (port 5174).
 * Usage: npx tsx tests/bench/run-space-size-browser.ts [--profiles=s,m,l] [--gpu] [--save]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { PROFILES, renderSpace } from './lib/synthetic-space';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const URL_BASE = flag('url') ?? 'http://localhost:5174';
const TIMEOUT_MS = Number(flag('open-timeout') ?? 120_000);
const GPU = args.includes('--gpu');
const wanted = flag('profiles')?.split(',') ?? ['s', 'm', 'l'];
const profiles = PROFILES.filter((p) => wanted.includes(p.key));

try { await fetch(URL_BASE); } catch {
  console.error(`✗ ${URL_BASE} is not reachable. Start the app first: npm run dev:test`);
  process.exit(2);
}

type Open = {
  renderer: '2d' | '3d';
  bootMs: number | null; dataMs: number | null; readyMs: number | null; settledMs: number | null;
  longTaskTotalMs: number; longTaskMaxMs: number; frameP50Ms: number | null; frameP95Ms: number | null;
  error?: string;
};
type Row = { profile: string; chunks: 'folded' | 'none'; statements: number; mb: number; importMs: number | null; written: number | null; opens: Open[]; error?: string };

const browser = await chromium.launch(GPU
  ? { channel: 'chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] }
  : {});

// Page-side code is passed as STRINGS: tsx keeps function names with an injected __name helper,
// which does not exist in the page and throws 'ReferenceError: __name is not defined'.
async function glRenderer(page: Page): Promise<string> {
  return page.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'NO_WEBGL'; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'masked'; })()`);
}

/** Resolve with performance.now() at the first animation frame where `selector` matches. */
async function phase(page: Page, selector: string, notValue?: [string, string]): Promise<number | null> {
  // A FUNCTION, not a string: the app's CSP forbids the eval a string predicate needs. It has no
  // named inner functions, so tsx injects no __name helper into it.
  try {
    const handle = await page.waitForFunction(([sel, nv]) => {
      const el = document.querySelector(sel as string);
      if (!el) return false;
      if (nv && el.getAttribute((nv as string[])[0]) === (nv as string[])[1]) return false;
      return performance.now();
    }, [selector, notValue ?? null] as const, { polling: 'raf', timeout: TIMEOUT_MS });
    return (await handle.jsonValue()) as number;
  } catch (error) {
    if (!/Timeout/.test(String(error))) console.log(`      ! phase ${selector}: ${String(error).split('\n')[0]}`);
    return null;
  }
}

async function openSpace(page: Page, kbId: string, renderer: '2d' | '3d'): Promise<Open> {
  const open: Open = { renderer, bootMs: null, dataMs: null, readyMs: null, settledMs: null, longTaskTotalMs: 0, longTaskMaxMs: 0, frameP50Ms: null, frameP95Ms: null };
  const url = `${URL_BASE}/?kb=${encodeURIComponent(kbId)}`;
  try {
    // Choose the renderer in this space's own settings, then measure a fresh navigation.
    await page.goto(url);
    await page.evaluate(async (prefer2D) => {
      const { updateSettings } = await import(/* @vite-ignore */ '/src/lib/stores/settings.svelte.ts');
      await updateSettings({ prefer2D });
    }, renderer === '2d');
    await page.goto(url);
    // In parallel, so a phase one renderer never signals (2D sets settled, not ready) cannot
    // delay the others by a whole timeout.
    [open.bootMs, open.dataMs, open.readyMs, open.settledMs] = await Promise.all([
      phase(page, 'nav'),
      phase(page, '[data-graph-renderer]', ['data-graph-renderer', 'landing']),
      // The 2D renderer signals settled only; waiting for its ready would idle a whole timeout.
      renderer === '3d' ? phase(page, '[data-graph-ready="true"]') : Promise.resolve(null),
      phase(page, '[data-graph-settled="true"]'),
    ]);
    const frames = (await page.evaluate(`new Promise((done) => { const deltas = []; let last = performance.now(); const end = last + 3000;
      const tick = (t) => { deltas.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else done(deltas); }; requestAnimationFrame(tick); })`)) as number[];
    const sorted = frames.slice(1).sort((a, b) => a - b);
    if (sorted.length) { open.frameP50Ms = sorted[Math.floor(sorted.length * 0.5)]; open.frameP95Ms = sorted[Math.floor(sorted.length * 0.95)]; }
    const lt = (await page.evaluate('window.__longTasks || []')) as number[];
    open.longTaskTotalMs = lt.reduce((a, b) => a + b, 0);
    open.longTaskMaxMs = lt.reduce((a, b) => Math.max(a, b), 0);
  } catch (error) {
    open.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
  return open;
}

const rows: Row[] = [];
let renderer = '';
try {
  const probe = await browser.newPage();
  await probe.goto(URL_BASE);
  renderer = await glRenderer(probe);
  await probe.close();
  const software = /swiftshader|software|llvmpipe/i.test(renderer);
  console.log(`renderer: ${renderer}${software ? '  (SOFTWARE: render times say nothing about a GPU)' : ''}\n`);
  if (GPU && software) { console.error('✗ --gpu asked for the GPU and got a software rasterizer. Aborting rather than reporting it.'); process.exit(1); }

  for (const p of profiles) {
    for (const folded of [false, true]) {
      const { ttl } = renderSpace(p, folded);
      const row: Row = { profile: p.key, chunks: folded ? 'folded' : 'none', statements: p.statements, mb: Buffer.byteLength(ttl) / 1e6, importMs: null, written: null, opens: [] };
      // A fresh context per cell: an empty IndexedDB, so no cell pays for the one before it.
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      await context.addInitScript({ content: `window.__longTasks = [];
        try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}` });
      const page = await context.newPage();
      // Say WHY a page went away instead of reporting 'target closed' for every later phase.
      page.on('crash', () => console.log('      ! page crashed'));
      page.on('pageerror', (e) => console.log(`      ! page error: ${e.message.split('\n')[0]}`));
      context.on('page', (p2) => console.log(`      ! a new page opened: ${p2.url()}`));
      try {
        await page.goto(`${URL_BASE}/`);
        await page.locator('nav').waitFor();
        // Warm the import modules so the first cell does not pay Vite's on-demand compile.
        await page.evaluate(() => import(/* @vite-ignore */ '/src/lib/stores/kb-import.ts'));
        const result = await page.evaluate(async ({ ttl, name }) => {
          const { ingestNewKb } = await import(/* @vite-ignore */ '/src/lib/stores/kb-import.ts');
          const t = performance.now();
          const r = await ingestNewKb({ ttl, assets: new Map() }, { name }, `bench://${name}`);
          return { ms: performance.now() - t, kbId: r?.kbId ?? null, count: r?.count ?? 0 };
        }, { ttl, name: `bench-${p.key}-${row.chunks}` });
        row.importMs = result.ms;
        row.written = result.count;
        if (result.kbId) for (const r of ['2d', '3d'] as const) row.opens.push(await openSpace(page, result.kbId, r));
      } catch (error) {
        row.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
      } finally {
        await context.close();
      }
      rows.push(row);
      const f = (v: number | null) => (v === null ? '   —' : `${(v / 1000).toFixed(1)}s`.padStart(5));
      console.log(`${p.key.padEnd(3)} ${row.chunks.padEnd(6)} ${String(p.statements).padStart(7)} st ${row.mb.toFixed(1).padStart(5)} MB  import ${f(row.importMs)}${row.error ? `  ✗ ${row.error}` : ''}`);
      for (const o of row.opens) {
        console.log(`      ${o.renderer}  boot ${f(o.bootMs)}  data ${f(o.dataMs)}  ready ${f(o.readyMs)}  settled ${f(o.settledMs)}  long tasks ${f(o.longTaskTotalMs)} (max ${Math.round(o.longTaskMaxMs)} ms)  frame p50/p95 ${o.frameP50Ms?.toFixed(0) ?? '—'}/${o.frameP95Ms?.toFixed(0) ?? '—'} ms${o.error ? `  ✗ ${o.error}` : ''}`);
      }
    }
  }
} finally {
  await browser.close();
}

if (args.includes('--save')) {
  const dir = resolve(import.meta.dirname ?? '.', 'results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `space-size-browser${GPU ? '-gpu' : ''}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify({ url: URL_BASE, renderer, gpu: GPU, rows }, null, 2));
  console.log(`\nsaved ${file}`);
}
if (rows.some((r) => r.error || r.opens.some((o) => o.error))) process.exitCode = 1;
