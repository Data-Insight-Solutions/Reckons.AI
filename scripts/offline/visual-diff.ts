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
import { appendFileSync } from 'fs';
import { diffImagesVLM, hasOllamaVlm, unloadVlm, VLM_MODEL } from '../../tests/visual/vision-vlm';

const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const BASE = flag('base');
const HEAD = flag('head');
const ROUTES = (flag('routes') ?? '/,/ingest,/review,/reckoning,/kb').split(',');
const WIDTH = Number(flag('width') ?? 390);
const HEIGHT = Number(flag('height') ?? 844);
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

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

function queue(route: string, notes: string) {
  const line = JSON.stringify({
    subject: `urn:sweep:visual-diff${route.replace(/[^a-z0-9]+/gi, '-')}`,
    predicate: 'urn:sweep:pred/visual-regression',
    question: `Visual diff ${BASE} → ${HEAD} at ${route} (${WIDTH}x${HEIGHT}): ${notes.slice(0, 500)}`,
    type: 'question',
    agent: `offline:visual-diff (${VLM_MODEL})`,
    priority: 'medium',
    addedAt: new Date().toISOString(),
    addedByMcp: true,
  });
  appendFileSync(PENDING, line + '\n');
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
let flagged = 0;

console.log(`Visual diff — ${BASE} → ${HEAD} · ${ROUTES.length} route(s) @ ${WIDTH}x${HEIGHT} · ${VLM_MODEL}\n`);
for (const route of ROUTES) {
  process.stdout.write(`  ${route} … `);
  try {
    const [b, h] = [await shot(page, BASE + route), await shot(page, HEAD + route)];
    const { changed, notes } = await diffImagesVLM(b, h, `page ${route}`);
    if (changed) {
      flagged++;
      queue(route, notes);
      console.log('CHANGED → queued');
    } else {
      console.log('identical');
    }
  } catch (e) {
    console.log(`skipped (${e instanceof Error ? e.message : e})`);
  }
}

await unloadVlm();
await browser.close();
console.log(`\nDone: ${flagged} regression(s) queued → ${PENDING}. Review in Reckons.AI (Review tab).`);
