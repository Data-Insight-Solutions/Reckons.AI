#!/usr/bin/env npx tsx
/**
 * Offline visual branch/environment diff (F42) — runs WITHOUT Opus / any cloud.
 *
 * Captures the same routes on TWO deploys (e.g. prod reckons.ai vs
 * dev.reckons-ai.pages.dev, or staging vs dev) and has the LOCAL VLM
 * (qwen2.5vl:7b) diff-detect visual regressions. Each meaningful difference is
 * queued as a pending QUESTION for review in Reckons.AI. Opt-in via
 * OLLAMA_BASE_URL; screenshots + review are all local and free.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/visual-diff.ts \
 *     --base=https://reckons.ai --head=https://dev.reckons-ai.pages.dev \
 *     [--routes=/,/ingest,/review,/reckoning,/kb] [--width=390] [--height=844]
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { diffImagesVLM, hasOllamaVlm, unloadVlm, VLM_MODEL } from '../../tests/visual/vision-vlm';
import { queueFindings, type Finding } from './pending-queue.js';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const BASE = flag('base');
const HEAD = flag('head');
const ROUTES = (flag('routes') ?? '/,/ingest,/review,/reckoning,/kb').split(',');
const WIDTH = Number(flag('width') ?? 390);
const HEIGHT = Number(flag('height') ?? 844);
const CONTRACT_REPORT = flag('report');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const RUNS_DIR = 'reckons-workspace/runs';

if (!BASE || !HEAD) {
  console.log('Usage: npx tsx scripts/offline/visual-diff.ts --base=<url> --head=<url> [--routes=/,/kb] [--width] [--height]');
  process.exit(BASE || HEAD ? 1 : 0);
}
if (!hasOllamaVlm()) {
  console.error('OLLAMA_BASE_URL not set — the local VLM is required for the diff.');
  process.exit(1);
}

async function ready(page: Page) {
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
}

async function shot(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await ready(page);
  return (await page.screenshot()).toString('base64');
}

function finding(route: string, notes: string): Finding {
  return {
    subject: `urn:sweep:visual-diff${route.replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: 'urn:sweep:pred/visual-regression',
    question: `Visual diff ${BASE} → ${HEAD} at ${route} (${WIDTH}x${HEIGHT}): ${notes.slice(0, 500)}`,
    kb: 'roadmap',
    type: 'question',
    priority: 'medium',
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
let flagged = 0;
const skipped: { route: string; reason: string }[] = [];
const proposals: Finding[] = [];

console.log(`Visual diff — ${BASE} → ${HEAD} · ${ROUTES.length} route(s) @ ${WIDTH}x${HEIGHT} · ${VLM_MODEL}\n`);
for (const route of ROUTES) {
  process.stdout.write(`  ${route} … `);
  try {
    const [b, h] = [await shot(page, BASE + route), await shot(page, HEAD + route)];
    const { changed, notes } = await diffImagesVLM(b, h, `page ${route}`);
    if (changed) {
      flagged++;
      proposals.push(finding(route, notes));
      console.log('CHANGED → queued');
    } else {
      console.log('identical');
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    skipped.push({ route, reason });
    console.log(`skipped (${reason})`);
  }
}

await unloadVlm();
await browser.close();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const receipt = path.join(RUNS_DIR, `visual-diff_${stamp}.json`);
mkdirSync(RUNS_DIR, { recursive: true });
const report = JSON.stringify({
  schema: 'reckons.visual-diff/v1',
  base: BASE,
  head: HEAD,
  routes: ROUTES,
  viewport: { width: WIDTH, height: HEIGHT },
  flagged,
  skipped,
  finishedAt: new Date().toISOString(),
}, null, 2) + '\n';
writeFileSync(receipt, report);
if (CONTRACT_REPORT) {
  mkdirSync(path.dirname(CONTRACT_REPORT), { recursive: true });
  writeFileSync(CONTRACT_REPORT, report);
}
const queued = queueFindings(proposals, {
  agent: `offline:visual-diff (${VLM_MODEL})`, path: PENDING, recomputes: false, kb: 'roadmap',
});
console.log(`\nDone: ${queued.queued} new regression proposal(s), ${queued.skipped} duplicate(s) suppressed → ${PENDING}.`);
console.log(`Run receipt: ${receipt}. Review in Reckons.AI (Review tab).`);
if (skipped.length) {
  console.error(`${skipped.length}/${ROUTES.length} route(s) could not be compared — refusing a clean result.`);
  process.exit(1);
}
