#!/usr/bin/env npx tsx
/**
 * Qualitative UX read of real screens, by the LOCAL VLM (F34 visual surface).
 *
 * The rest of the visual tier answers questions with right answers: is the sheet
 * present, did the layout shift between deploys, is this target 44px. This job
 * asks the questions a person asks in the first two seconds and a script cannot
 * answer at all — does this screen look crowded, can you tell what it is for,
 * does one thing clearly matter most.
 *
 * REPORT-ONLY BY DEFAULT, and never blocking. These readings have NO golden set
 * behind them (unlike the yes/no gate, which is scored against vlm-golden.ts), so
 * they are one local model's impression and nothing more. Pass --pending to queue
 * the flagged ones as proposals for review. They supersede the previous run's
 * rather than stacking, because the job re-derives every reading each time.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/ux-impression.ts \
 *     [--url=https://reckons.ai] [--routes=/,/ingest,/review] [--width=1280] [--height=800] [--pending]
 *
 *   # first, prove the model can tell a bad screen from a good one:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/ux-impression.ts --calibrate
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { hasOllamaVlm, unloadVlm, VLM_MODEL } from '../../tests/visual/vision-vlm';
import { uxImpression, summarize, UX_DIMENSIONS, type UxImpression } from '../../tests/visual/vision-ux';
import { queueFindings, type Finding } from './pending-queue.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const URL_BASE = flag('url') ?? 'https://reckons.ai';
const ROUTES = (flag('routes') ?? '/,/ingest,/review,/reckoning,/kb').split(',').filter(Boolean);
const WIDTH = Number(flag('width') ?? 1280);
const HEIGHT = Number(flag('height') ?? 800);
const WRITE = raw.includes('--pending');
const CALIBRATE = raw.includes('--calibrate');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const RUNS_DIR = 'reckons-workspace/runs';

const C = { d: '\x1b[2m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' };

if (!hasOllamaVlm()) {
  console.error('OLLAMA_BASE_URL not set — this job needs the local VLM. Refusing to report a clean run.');
  process.exit(1);
}

async function ready(page: Page) {
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
}

function finding(route: string, imp: UxImpression): Finding {
  const worst = imp.flagged[0];
  const cited = [...new Set(imp.flagged.map((r) => r.cites))].join(', ');
  const detail = imp.flagged.map((r) => `${r.key}=${r.label} (${r.reason || 'no reason given'})`).join('; ');
  return {
    subject: `urn:sweep:ux-impression${route.replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: 'urn:sweep:pred/ux-impression',
    question:
      `${route} at ${WIDTH}x${HEIGHT} reads as ${worst.label} ${worst.key}. ${detail}. ` +
      `First impression: ${imp.impression || '(none given)'}. Biggest problem: ${imp.worst || '(none given)'}. ` +
      `Cites ${cited}. One local VLM's read (${imp.model}), not a measurement — accept or reject.`,
    kb: 'roadmap',
    type: 'question',
    priority: 'low',
  };
}

/**
 * CALIBRATION — does the model discriminate at all?
 *
 * The first real run of this job returned rank 0 or 1 on all 25 readings across
 * five different screens, never once reaching the bottom half of any scale. That
 * is indistinguishable from a model that answers "fine" to everything, and a
 * check that cannot fail is not a check. So: render one deliberately terrible
 * page and one deliberately clean one, and measure the gap. If the instrument
 * cannot separate those two, its readings on real screens carry no information
 * and the job says so instead of printing a green line.
 */
async function calibrate() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const controls = ['airy', 'crowded'] as const;
  const got: Record<string, UxImpression> = {};
  for (const name of controls) {
    const file = path.resolve('tests/visual/fixtures/ux-controls', `${name}.html`);
    await page.goto(`file://${file}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    got[name] = await uxImpression((await page.screenshot()).toString('base64'));
    console.log(`  ${C.c}${name.padEnd(9)}${C.x} ${summarize(got[name])}`);
  }
  await unloadVlm();
  await browser.close();

  console.log(`\n  ${C.b}separation${C.x}${C.d} — how far the bad control ranks below the good one${C.x}`);
  let discriminating = 0;
  let measurable = 0;
  for (const d of UX_DIMENSIONS) {
    const a = got.airy.readings.find((r) => r.key === d.key)!;
    const c = got.crowded.readings.find((r) => r.key === d.key)!;
    if (a.rank === null || c.rank === null) {
      console.log(`  ${d.key.padEnd(13)} ${C.d}unreadable (${a.label ?? '?'} vs ${c.label ?? '?'})${C.x}`);
      continue;
    }
    measurable++;
    const gap = c.rank - a.rank;
    if (gap > 0) discriminating++;
    const verdict = gap > 0 ? `${C.c}+${gap}${C.x}` : `${C.y}${gap} — no separation${C.x}`;
    console.log(`  ${d.key.padEnd(13)} ${String(a.label).padEnd(18)} → ${String(c.label).padEnd(18)} ${verdict}`);
  }

  const crowding = {
    airy: got.airy.readings.find((r) => r.key === 'crowding')!.rank,
    crowded: got.crowded.readings.find((r) => r.key === 'crowding')!.rank,
  };
  const headline = crowding.airy !== null && crowding.crowded !== null && crowding.crowded > crowding.airy;
  console.log(
    `\n  ${discriminating}/${measurable} dimension(s) separated the controls. ` +
      `Headline dimension (crowding): ${headline ? 'SEPARATED' : `${C.y}FLAT${C.x}`}`,
  );
  if (!headline) {
    console.error(
      `${C.y}  The model did not call the deliberately crowded control more crowded than the clean one.${C.x}\n` +
        `  Treat every reading from ${VLM_MODEL} as uninformative until this passes — try a larger VLM via VLM_MODEL=.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (CALIBRATE) await calibrate();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const proposals: Finding[] = [];
const results: { route: string; imp?: UxImpression; error?: string }[] = [];

console.log(
  `\n${C.b}UX impression${C.x}${C.d} — ${URL_BASE} · ${ROUTES.length} route(s) @ ${WIDTH}x${HEIGHT} · ${VLM_MODEL}${C.x}`,
);
console.log(`${C.d}  ${UX_DIMENSIONS.length} dimensions, no golden set — these are impressions, not measurements.${C.x}\n`);

for (const route of ROUTES) {
  process.stdout.write(`  ${C.c}${route.padEnd(12)}${C.x} `);
  try {
    await page.goto(URL_BASE + route, { waitUntil: 'domcontentloaded' });
    await ready(page);
    const imp = await uxImpression((await page.screenshot()).toString('base64'));
    results.push({ route, imp });
    console.log(imp.flagged.length ? `${C.y}${summarize(imp)}${C.x}` : `${C.d}${summarize(imp)}${C.x}`);
    if (imp.impression) console.log(`${C.d}      reads as: ${imp.impression}${C.x}`);
    if (imp.worst) console.log(`${C.d}      worst:    ${imp.worst}${C.x}`);
    if (imp.flagged.length) proposals.push(finding(route, imp));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ route, error });
    console.log(`${C.d}skipped (${error.slice(0, 80)})${C.x}`);
  }
}

await unloadVlm();
await browser.close();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(RUNS_DIR, { recursive: true });
const receipt = path.join(RUNS_DIR, `ux-impression_${stamp}.json`);
writeFileSync(
  receipt,
  JSON.stringify(
    {
      schema: 'reckons.ux-impression/v1',
      url: URL_BASE,
      viewport: { width: WIDTH, height: HEIGHT },
      model: VLM_MODEL,
      dimensions: UX_DIMENSIONS,
      results: results.map((r) => ({
        route: r.route,
        error: r.error,
        impression: r.imp?.impression,
        worst: r.imp?.worst,
        readings: r.imp?.readings,
      })),
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);

const skipped = results.filter((r) => r.error).length;
const unreadable = results.filter((r) => r.imp && r.imp.parsed < UX_DIMENSIONS.length);
console.log(
  `\n  ${proposals.length} screen(s) with a flagged reading · ${skipped} skipped · receipt ${receipt}`,
);
if (unreadable.length) {
  console.log(
    `${C.y}  ${unreadable.length} screen(s) answered outside the scale on some dimension — read the receipt before trusting those.${C.x}`,
  );
}

if (WRITE && proposals.length) {
  const q = queueFindings(proposals, {
    agent: `offline:ux-impression (${VLM_MODEL})`,
    path: PENDING,
    recomputes: true,
    kb: 'roadmap',
  });
  console.log(`  queued ${q.queued} proposal(s), ${q.skipped} duplicate(s) suppressed → ${PENDING}`);
} else if (proposals.length) {
  console.log(`${C.d}  Report-only. Pass --pending to queue these for review.${C.x}`);
}
if (skipped) process.exit(1);
