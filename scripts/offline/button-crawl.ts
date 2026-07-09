#!/usr/bin/env npx tsx
/**
 * F34 Deep Testing — offline exhaustive button crawler (phase 1).
 *
 * Clicks every interactive element on every route and records, per click:
 *   - crash?          console errors / uncaught page errors fired by the click
 *   - blank screen?   solid-fill pixel artifact (via tests/visual/vision-local)
 *   - silent no-op?    nothing observable changed (URL, node count, KB id, open
 *                      panels, title, visible-text hash) — the class of bug that
 *                      "click every button, flag crashes" crawlers MISS. This is
 *                      exactly the docs-hub leap regression: the button fired,
 *                      no error, and silently did nothing.
 *   - occluded / offscreen / sub-44px touch target (rubric: touch-targets)
 *
 * OFFLINE-FIRST: pixel/DOM/text/touch checks are pure local JS (no Ollama, no
 * Opus). VLM visual scoring and a persistent-context (warm service-worker) pass
 * are later phases — see reckons-roadmap.ttl F34.
 *
 * The crawler resets to the route before each click so results are deterministic
 * (a click that navigates or mutates the DOM can't cascade into the next).
 *
 * Usage:
 *   npm run dev            # (or any server) — then, in another shell:
 *   npm run test:crawl                       crawl every route on :5173
 *   BASE_URL=http://localhost:5174 npm run test:crawl
 *   npm run test:crawl -- --route=/kb        crawl a single route
 *   npm run test:crawl -- --max=20           cap elements per route
 *
 * Exit code is always 0 (offline diagnostic) — findings are queued to
 * reckons-workspace/knowledge.pending.jsonl for in-app review, per the
 * graphs-are-source-of-truth workflow.
 */
import { chromium, type Page, type Browser } from '@playwright/test';
import { analyzePixels, auditTouchTargets } from '../../tests/visual/vision-local';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const ONLY_ROUTE = arg('route');
const MAX_PER_ROUTE = Number(arg('max') ?? 60);

/** Routes to crawl. Keep in sync with src/routes/(app). */
const ROUTES = ['/', '/ingest', '/review', '/kb', '/settings', '/about'];

/** Interactive elements we click. Excludes external links (noted, not clicked). */
const INTERACTIVE =
  'button:not([disabled]), [role="button"]:not([aria-disabled="true"]), ' +
  '[role="tab"], summary, a[href^="/"], a[href^="."], .leap-badge, .leap-jump';

const OUT_DIR = path.resolve('tests/visual/screenshots/button-crawl');
const RESULTS_DIR = path.resolve('tests/visual/results');
const PENDING = path.resolve('reckons-workspace/knowledge.pending.jsonl');

const C = { b: '\x1b[1m', d: '\x1b[2m', y: '\x1b[33m', g: '\x1b[32m', r: '\x1b[31m', x: '\x1b[0m' };

interface Snapshot {
  url: string;
  nodeLabels: number;
  kbId: string | null;
  openDialogs: number;
  title: string;
  textHash: number;
}

interface Finding {
  route: string;
  index: number;
  label: string;
  selectorGroup: string;
  clicked: boolean;
  changed: boolean;
  errors: string[];
  dialogs: string[];
  openedPopup: boolean;
  blankScreen: boolean;
  dominantColor: string;
  tinyTouchTarget: boolean;
  screenshot: string;
}

/** A cheap fingerprint of what the user can currently see / where they are. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return {
      url: location.pathname + location.search,
      nodeLabels: document.querySelectorAll('.node-label').length,
      kbId: localStorage.getItem('currentKbId'),
      // count open bits-ui dialogs / sheets / popovers as "panel state"
      openDialogs: document.querySelectorAll(
        '[role="dialog"], .sheet-content, [data-state="open"][role="menu"]',
      ).length,
      title: document.title,
      textHash: h,
    };
  });
}

function changed(a: Snapshot, b: Snapshot): boolean {
  return (
    a.url !== b.url ||
    a.nodeLabels !== b.nodeLabels ||
    a.kbId !== b.kbId ||
    a.openDialogs !== b.openDialogs ||
    a.title !== b.title ||
    a.textHash !== b.textHash
  );
}

async function cleanSlate(page: Page) {
  await page.evaluate(async () => {
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((d) =>
          d.name
            ? new Promise<void>((res) => {
                const q = indexedDB.deleteDatabase(d.name!);
                q.onsuccess = () => res();
                q.onerror = () => res();
              })
            : Promise.resolve(),
        ),
      );
    } catch {
      /* not all browsers expose indexedDB.databases() */
    }
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
}

async function gotoRoute(page: Page, route: string) {
  await page.goto(BASE_URL + route, { waitUntil: 'networkidle' }).catch(() => {});
  await page.locator('nav').first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function crawlRoute(browser: Browser, route: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  // First visit: clean slate so every run starts identically.
  await page.goto(BASE_URL + route, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await cleanSlate(page);
  await gotoRoute(page, route);

  // Enumerate a STABLE count of interactive elements up-front. We re-locate by
  // index after resetting the route before each click.
  const count = Math.min(await page.locator(INTERACTIVE).count(), MAX_PER_ROUTE);
  console.log(`${C.b}${route}${C.x} ${C.d}— ${count} interactive elements${C.x}`);

  const shotDir = path.join(OUT_DIR, route === '/' ? '_root' : route.replace(/\//g, '_'));
  mkdirSync(shotDir, { recursive: true });

  for (let i = 0; i < count; i++) {
    await gotoRoute(page, route); // reset — deterministic per-click state
    const el = page.locator(INTERACTIVE).nth(i);
    if (!(await el.count())) continue;

    const label =
      ((await el.getAttribute('aria-label')) ||
        (await el.textContent()) ||
        (await el.getAttribute('title')) ||
        '(no label)')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);

    const before = await snapshot(page);
    const errors: string[] = [];
    const dialogs: string[] = [];
    let openedPopup = false;

    const onErr = (e: Error) => errors.push(e.message);
    const onConsole = (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error') errors.push(m.text());
    };
    const onDialog = async (d: { message: () => string; dismiss: () => Promise<void> }) => {
      dialogs.push(d.message());
      await d.dismiss().catch(() => {});
    };
    const onPopup = async (pg: Page) => { openedPopup = true; await pg.close().catch(() => {}); };
    page.on('pageerror', onErr);
    page.on('console', onConsole);
    page.on('dialog', onDialog);
    page.on('popup', onPopup);

    let clicked = true;
    try {
      await el.click({ timeout: 4_000, trial: false });
      await page.waitForTimeout(1_200); // allow async fetch/import/animation
    } catch {
      clicked = false;
    }

    const after = await snapshot(page);

    // Visual audit of the resulting screen (offline, deterministic).
    let blankScreen = false;
    let dominantColor = '';
    let tinyTouchTarget = false;
    const screenshotPath = path.join(shotDir, `${i}.png`);
    try {
      const buf = await page.screenshot();
      writeFileSync(screenshotPath, buf);
      const px = await analyzePixels(buf);
      blankScreen = px.isSolidFill;
      dominantColor = px.dominantColor;
      const tt = await auditTouchTargets(page);
      tinyTouchTarget = tt.some((t) => t.text && label.includes(t.text.slice(0, 20)));
    } catch {
      /* screenshot/analysis best-effort */
    }

    page.off('pageerror', onErr);
    page.off('console', onConsole);
    page.off('dialog', onDialog);
    page.off('popup', onPopup);

    const f: Finding = {
      route,
      index: i,
      label,
      selectorGroup: INTERACTIVE.split(',')[0],
      clicked,
      changed: changed(before, after),
      errors: [...new Set(errors)].slice(0, 5),
      dialogs,
      openedPopup,
      blankScreen,
      dominantColor,
      tinyTouchTarget,
      screenshot: path.relative(process.cwd(), screenshotPath),
    };
    findings.push(f);

    const flag =
      f.errors.length ? `${C.r}CRASH${C.x}` :
      f.blankScreen ? `${C.r}BLANK${C.x}` :
      !f.clicked ? `${C.y}UNCLICKABLE${C.x}` :
      !f.changed && !f.dialogs.length && !f.openedPopup ? `${C.y}NO-OP${C.x}` :
      `${C.g}ok${C.x}`;
    console.log(`  ${flag} ${C.d}[${i}]${C.x} ${label}`);
  }

  await page.close();
  return findings;
}

/** Turn the worst findings into pending graph entries for in-app review. */
function queueFindings(findings: Finding[]) {
  const worth = findings.filter(
    (f) => f.errors.length || f.blankScreen || (!f.changed && !f.clicked),
  );
  if (!worth.length) return 0;
  const lines = worth.map((f) => {
    const kind = f.errors.length ? 'observation' : f.blankScreen ? 'observation' : 'question';
    const note = f.errors.length
      ? `Button "${f.label}" (${f.route}) threw on click: ${f.errors[0]}`
      : f.blankScreen
        ? `Button "${f.label}" (${f.route}) left a blank/solid-fill screen (${f.dominantColor})`
        : `Button "${f.label}" (${f.route}) could not be clicked (occluded/disabled?)`;
    return JSON.stringify({
      subject: `urn:reckons:test/button-crawl${f.route}`,
      predicate: 'urn:reckons:test/finding',
      object: f.label,
      note,
      type: kind,
      agent: 'button-crawl',
      priority: f.errors.length || f.blankScreen ? 'high' : 'normal',
    });
  });
  try {
    mkdirSync(path.dirname(PENDING), { recursive: true });
    appendFileSync(PENDING, lines.join('\n') + '\n');
  } catch {
    /* workspace may not exist in every checkout */
  }
  return worth.length;
}

async function main() {
  // Fail fast with a helpful message if no server is up.
  const probe = await fetch(BASE_URL).then((r) => r.ok).catch(() => false);
  if (!probe) {
    console.error(`${C.r}No server at ${BASE_URL}.${C.x} Start one (npm run dev) or set BASE_URL.`);
    process.exit(0);
  }

  const routes = ONLY_ROUTE ? [ONLY_ROUTE] : ROUTES;
  console.log(`${C.b}Button crawl${C.x} — ${routes.length} route(s) @ ${BASE_URL}\n`);

  const browser = await chromium.launch();
  const all: Finding[] = [];
  for (const route of routes) {
    try {
      all.push(...(await crawlRoute(browser, route)));
    } catch (e) {
      console.error(`${C.r}route ${route} failed:${C.x}`, e instanceof Error ? e.message : e);
    }
  }
  await browser.close();

  // Report.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `button-crawl_${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify({ baseUrl: BASE_URL, routes, findings: all }, null, 2));

  const crashes = all.filter((f) => f.errors.length);
  const blanks = all.filter((f) => f.blankScreen);
  const noops = all.filter((f) => f.clicked && !f.changed && !f.dialogs.length && !f.openedPopup);
  const unclickable = all.filter((f) => !f.clicked);

  console.log(`\n${C.b}Summary${C.x}  (${all.length} clicks)`);
  console.log(`  ${crashes.length ? C.r : C.d}crashes:      ${crashes.length}${C.x}`);
  console.log(`  ${blanks.length ? C.r : C.d}blank screens: ${blanks.length}${C.x}`);
  console.log(`  ${C.y}silent no-ops: ${noops.length}${C.x} ${C.d}(review — may be intended)${C.x}`);
  console.log(`  ${C.d}unclickable:   ${unclickable.length}${C.x}`);
  const queued = queueFindings(all);
  console.log(`\n  report:  ${C.d}${path.relative(process.cwd(), reportPath)}${C.x}`);
  console.log(`  queued:  ${queued} finding(s) -> ${C.d}${path.relative(process.cwd(), PENDING)}${C.x}`);
  console.log(`\n${C.d}No-ops and visuals want an Opus/VLM pass — phase 2.${C.x}`);
}

main();
