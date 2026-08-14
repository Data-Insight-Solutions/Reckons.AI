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
import { evalStable } from '../../tests/visual/eval-stable';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const ONLY_ROUTE = arg('route');
const MAX_PER_ROUTE = Number(arg('max') ?? 60);

/**
 * Viewport to crawl at. Defaults to desktop, but the 44px TOUCH-TARGET rule only means anything on
 * a touch screen — a 30px chip is fine under a mouse pointer and a defect under a thumb. Crawling
 * only at 1280x900 produced 66 "sub-44px" findings that no touch user would ever meet, which is
 * the same cry-wolf problem as the no-ops. Pass --device=pixel (or iphone/ipad) to audit at a size
 * where the rule applies; `touchTargetsMeaningful` records which it was, so a reader can tell
 * whether the count is advisory or real.
 */
const DEVICES: Record<string, { width: number; height: number; touch: boolean }> = {
  desktop: { width: 1280, height: 900, touch: false },
  ipad:    { width: 834,  height: 1194, touch: true },
  pixel:   { width: 412,  height: 915,  touch: true },
  iphone:  { width: 390,  height: 844,  touch: true },
};
const DEVICE_NAME = arg('device') ?? 'desktop';
const DEVICE = DEVICES[DEVICE_NAME] ?? DEVICES.desktop;

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
  /**
   * Which controls are currently "on" (aria-pressed / aria-selected / aria-current / data-state
   * active / .active / .selected), hashed.
   *
   * Without this the crawler is blind to the commonest kind of working button: a toggle whose only
   * effect is an attribute flip. Body text is identical before and after, so a 2D/3D switch, a
   * layout mode, or a sort order all looked like SILENT NO-OPS — 11 of them on the 2026-07-18 run,
   * every one of them a control that works. Fingerprinting the on/off set makes a working toggle
   * observably different from a dead one.
   */
  activeHash: number;
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
  /** Click started a file download — a DOM no-change is correct. */
  downloaded?: boolean;
  /** Click opened the native file picker — invisible to the DOM by design. */
  openedFilePicker?: boolean;
  /** Control was already in the state the click sets — no-change is correct. */
  alreadyActive?: boolean;
  blankScreen: boolean;
  dominantColor: string;
  tinyTouchTarget: boolean;
  screenshot: string;
  screenshotB64: string; // data-URI PNG, embedded into the story graph (kmeta:gif)
}

/** ok | crash | blank | no-op | unclickable — the reviewable per-step verdict. */
function verdict(f: Finding): string {
  if (f.errors.length) return 'crash';
  if (f.blankScreen) return 'blank';
  if (!f.clicked) return 'unclickable';
  if (isRealNoOp(f)) return 'no-op';
  return 'ok';
}

/**
 * A no-op worth a human's attention: the click was accepted and NOTHING happened — no DOM change,
 * no dialog, no popup, no download, no file picker — and the control was not already in the state
 * it sets.
 *
 * The exclusions are not leniency, they are accuracy. An export button that downloads a .ttl
 * changes no DOM, and neither does the active button of a 2D/3D toggle; reporting those as defects
 * buries the one finding that is real. This is the docs-hub leap regression's signature — button
 * fires, no error, nothing happens — and it only stays findable if the list stays honest.
 */
function isRealNoOp(f: Finding): boolean {
  return (
    f.clicked &&
    !f.changed &&
    !f.dialogs.length &&
    !f.openedPopup &&
    !f.downloaded &&
    !f.openedFilePicker &&
    !f.alreadyActive
  );
}

/** A cheap fingerprint of what the user can currently see / where they are. */
async function snapshot(page: Page): Promise<Snapshot> {
  return evalStable(page, () => {
    const text = document.body?.innerText ?? '';
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;

    // Fingerprint of every control currently in an "on" state, positionally indexed so a change
    // in WHICH control is on registers even when the count stays the same.
    const onSet: string[] = [];
    document
      .querySelectorAll('button, [role="button"], [role="tab"], [role="option"], a, input')
      .forEach((n, idx) => {
        const e = n as HTMLElement;
        if (
          e.getAttribute('aria-pressed') === 'true' ||
          e.getAttribute('aria-selected') === 'true' ||
          e.getAttribute('aria-current') !== null ||
          e.getAttribute('data-state') === 'active' ||
          e.getAttribute('data-state') === 'checked' ||
          // bits-ui marks a selected ToggleGroup/Tabs item with data-state="on" +
          // aria-checked, NOT .active. Missing these made every working toggle in the
          // app read as a silent no-op (verified against /review layout chips).
          e.getAttribute('data-state') === 'on' ||
          e.getAttribute('aria-checked') === 'true' ||
          e.classList.contains('active') ||
          e.classList.contains('selected') ||
          (e as HTMLInputElement).checked === true
        ) {
          onSet.push(`${idx}:${e.tagName}`);
        }
      });
    const onStr = onSet.join('|');
    let ah = 0;
    for (let i = 0; i < onStr.length; i++) ah = (ah * 31 + onStr.charCodeAt(i)) | 0;

    return {
      activeHash: ah,
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
    a.textHash !== b.textHash ||
    a.activeHash !== b.activeHash
  );
}

async function cleanSlate(page: Page) {
  await evalStable(page, async () => {
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
  await page.setViewportSize({ width: DEVICE.width, height: DEVICE.height });

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

    // A click can DO something real while changing nothing observable in the DOM. Without these
    // three signals the crawler reported export buttons, folder pickers and already-active toggles
    // as "silent no-ops" — 21 of them on the first full run, most of which were correct behavior.
    // A finding list that is mostly false positives moves cost from generation to triage and gets
    // switched off, so the discrimination belongs HERE, not in the reader's head.
    let downloaded = false;
    let openedFilePicker = false;
    const onDownload = (dl: { cancel?: () => Promise<void> }) => {
      downloaded = true;              // export/save — no DOM change is CORRECT
      dl.cancel?.().catch(() => {});
    };
    const onFileChooser = (fc: { page: () => unknown }) => { openedFilePicker = true; void fc; };

    // Was the control ALREADY in the state the click would set? Then "nothing changed" is the
    // right outcome, not a defect (clicking the active "2D" button in a 2D/3D toggle).
    const alreadyActive = await el.evaluate((node: Element) => {
      const el2 = node as HTMLElement;
      return (
        el2.getAttribute('aria-pressed') === 'true' ||
        el2.getAttribute('aria-selected') === 'true' ||
        el2.getAttribute('aria-current') !== null ||
        el2.getAttribute('data-state') === 'active' ||
        el2.getAttribute('data-state') === 'on' ||
        el2.getAttribute('aria-checked') === 'true' ||
        el2.classList.contains('active') ||
        el2.classList.contains('selected')
      );
    }).catch(() => false);

    page.on('pageerror', onErr);
    page.on('console', onConsole);
    page.on('dialog', onDialog);
    page.on('popup', onPopup);
    page.on('download', onDownload);
    page.on('filechooser', onFileChooser);

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
    let screenshotB64 = '';
    try {
      const buf = await page.screenshot();
      writeFileSync(screenshotPath, buf);
      screenshotB64 = `data:image/png;base64,${buf.toString('base64')}`;
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
    page.off('download', onDownload);
    page.off('filechooser', onFileChooser);

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
      downloaded,
      openedFilePicker,
      alreadyActive,
      blankScreen,
      dominantColor,
      tinyTouchTarget,
      screenshot: path.relative(process.cwd(), screenshotPath),
      screenshotB64,
    };
    findings.push(f);

    const flag =
      f.errors.length ? `${C.r}CRASH${C.x}` :
      f.blankScreen ? `${C.r}BLANK${C.x}` :
      !f.clicked ? `${C.y}UNCLICKABLE${C.x}` :
      isRealNoOp(f) ? `${C.y}NO-OP${C.x}` :
      `${C.g}ok${C.x}`;
    console.log(`  ${flag} ${C.d}[${i}]${C.x} ${label}`);
  }

  await page.close();
  return findings;
}

const STORY_TTL = path.resolve('tests/visual/button-crawl.ttl');

/** Escape a Turtle string literal. */
function ttl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function routeSlug(route: string): string {
  return route === '/' ? 'root' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

/**
 * Emit the crawl as a TestWorkflow -> TestStep story graph — one workflow per
 * route, one step per click, each carrying its screenshot (kmeta:gif) and
 * verdict — so results are reviewable in-app as an ordered story (same schema
 * as the navigation-sweep story). This is the "tie everything back to the TTL"
 * surface: the graph is the human-review artifact, not a JSON dump.
 *
 * Written to a SIBLING file (button-crawl.ttl) so it never clobbers the
 * pre-existing visual-tests.ttl (whose generator is a separate, uncommitted
 * tool — see the queued discrepancy).
 */
function writeStoryTtl(findings: Finding[]) {
  const byRoute = new Map<string, Finding[]>();
  for (const f of findings) (byRoute.get(f.route) ?? byRoute.set(f.route, []).get(f.route)!).push(f);

  const lines: string[] = [
    '@prefix kb:    <urn:kbase:concept/> .',
    '@prefix kpred: <urn:kbase:predicate/> .',
    '@prefix kmeta: <urn:kbase:meta/> .',
    '@prefix ktype: <urn:kbase:type/> .',
    '@prefix hnav:  <urn:reckons:nav/> .',
    '@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '# Generated by scripts/offline/button-crawl.ts (F34 deep testing) — do not hand-edit; regenerate with `npm run test:crawl`.',
    `# Crawled ${BASE_URL} at ${new Date().toISOString()}.`,
    '',
  ];

  for (const [route, fs] of byRoute) {
    const wf = `kb:vt-crawl-${routeSlug(route)}`;
    lines.push(
      `${wf} rdf:type ktype:TestWorkflow ;`,
      `    rdfs:label ${JSON.stringify(`button crawl · ${route}`)} ;`,
      `    kpred:route ${JSON.stringify(route)} .`,
      '',
    );
    fs.forEach((f, idx) => {
      const step = `${wf}-${String(idx).padStart(2, '0')}`;
      const v = verdict(f);
      const l: string[] = [
        `${step} rdf:type ktype:TestStep ;`,
        `    rdfs:label "${ttl(`${String(idx).padStart(2, '0')} · ${f.label}`)}" ;`,
        `    skos:broader ${wf} ;`,
        `    kpred:step-of ${wf} ;`,
        `    kpred:result "${v}" ;`,
        `    hnav:order "${idx}"^^xsd:integer ;`,
        `    hnav:layer "2"^^xsd:integer ;`,
      ];
      if (idx > 0) l.push(`    hnav:prev ${wf}-${String(idx - 1).padStart(2, '0')} ;`);
      if (idx < fs.length - 1) l.push(`    hnav:next ${wf}-${String(idx + 1).padStart(2, '0')} ;`);
      if (f.errors.length) l.push(`    kpred:error "${ttl(f.errors[0])}" ;`);
      if (f.tinyTouchTarget) l.push(`    kpred:violates "touch-targets" ;`);
      if (f.blankScreen) l.push(`    kpred:violates "no-blank-screen" ;`);
      // Screenshot embedded exactly like the navigation-sweep story (kmeta:gif).
      l.push(`    kmeta:gif "${f.screenshotB64}" .`);
      lines.push(...l, '');
    });
  }
  writeFileSync(STORY_TTL, lines.join('\n'));
  return STORY_TTL;
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
  // Routes that never got crawled. Tracked because the alternative — what this script did until
  // 2026-07-18 — is to log the failure, skip the route, and still print "crashes: 0". Four of six
  // routes were dying on a navigation race and the summary claimed a clean run. An untested route
  // is not a passing route, and a report that cannot tell the difference is worse than no report.
  const skipped: { route: string; reason: string }[] = [];

  for (const route of routes) {
    try {
      all.push(...(await crawlRoute(browser, route)));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`${C.r}route ${route} failed:${C.x}`, reason);
      skipped.push({ route, reason });
    }
  }
  await browser.close();

  // Report.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `button-crawl_${stamp}.json`);
  const crawled = [...new Set(all.map((f) => f.route))];
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        device: DEVICE_NAME,
        viewport: { width: DEVICE.width, height: DEVICE.height },
        // False when crawled on desktop: sub-44px counts below are advisory only.
        touchTargetsMeaningful: DEVICE.touch,
        routes, crawled, skipped, findings: all,
      },
      null,
      2,
    ),
  );

  const crashes = all.filter((f) => f.errors.length);
  const blanks = all.filter((f) => f.blankScreen);
  const noops = all.filter(isRealNoOp);
  const benign = all.filter((f) => f.clicked && !f.changed && !isRealNoOp(f));
  const unclickable = all.filter((f) => !f.clicked);

  console.log(`\n${C.b}Summary${C.x}  (${all.length} clicks)`);
  // COVERAGE FIRST. Every count below is only meaningful over the routes actually reached, so say
  // what was reached before saying what was found — otherwise "crashes: 0" reads as "the app is
  // fine" when it may mean "we never got there".
  console.log(
    `  ${C.d}device:       ${DEVICE_NAME} (${DEVICE.width}x${DEVICE.height})${DEVICE.touch ? '' : ' — touch-target counts ADVISORY'}${C.x}`,
  );
  console.log(
    `  ${skipped.length ? C.r : C.d}coverage:     ${crawled.length}/${routes.length} route(s)${C.x}`,
  );
  for (const s of skipped) {
    console.log(`    ${C.r}NOT CRAWLED${C.x} ${s.route} ${C.d}— ${s.reason.slice(0, 90)}${C.x}`);
  }
  console.log(`  ${crashes.length ? C.r : C.d}crashes:      ${crashes.length}${C.x}${skipped.length ? ` ${C.d}(over crawled routes only)${C.x}` : ''}`);
  console.log(`  ${blanks.length ? C.r : C.d}blank screens: ${blanks.length}${C.x}`);
  console.log(`  ${noops.length ? C.y : C.d}silent no-ops: ${noops.length}${C.x} ${C.d}(no DOM change, no download, not already-active)${C.x}`);
  console.log(`  ${C.d}benign no-change: ${benign.length} ${C.d}(downloads, file pickers, already-active toggles)${C.x}`);
  console.log(`  ${C.d}unclickable:   ${unclickable.length}${C.x}`);
  const storyPath = writeStoryTtl(all);
  const queued = queueFindings(all);
  console.log(`\n  report:  ${C.d}${path.relative(process.cwd(), reportPath)}${C.x}`);
  console.log(`  story:   ${C.d}${path.relative(process.cwd(), storyPath)}${C.x} ${C.d}(TestWorkflow/TestStep — reviewable in-app)${C.x}`);
  console.log(`  queued:  ${queued} finding(s) -> ${C.d}${path.relative(process.cwd(), PENDING)}${C.x}`);
  console.log(`\n${C.d}No-ops and visuals want an Opus/VLM pass — phase 2.${C.x}`);
}

main();
