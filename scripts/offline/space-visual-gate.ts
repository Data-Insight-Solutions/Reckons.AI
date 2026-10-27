#!/usr/bin/env npx tsx
/**
 * Space statement visual gate (F34.3) — takes screenshots of real Reckons spaces
 * via Playwright, runs local VLM gate checks on each, queues findings for review.
 *
 * Uses qwen2.5vl:7b locally instead of Claude tokens for per-shot cost of ~$0.
 * Requires OLLAMA_BASE_URL and a dev server at BASE_URL (defaults to :5174 mock).
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx scripts/offline/space-visual-gate.ts [--base=http://localhost:5174]
 */
import { chromium, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// ── Config ───────────────────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const BASE = process.argv.find(a => a.startsWith('--base='))?.split('=')[1]
  ?? process.env.BASE_URL ?? 'http://localhost:5174';
const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
];
/** Routes that render real space content with statements. */
const ROUTES = [
  '/kb',     // main knowledge graph space
  '/review', // review space with pending assertions
  '/ingest', // ingest space with extracted facts
  '/',       // root/home space
];

// ── Playwright screenshot capture ────────────────────────────────────────────
async function ready(page: Page) {
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
}

async function shot(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await ready(page);
  return (await page.screenshot()).toString('base64');
}

// ── VLM gate helpers (reuse existing vision-vlm module) ───────────────────────
async function askVLM(imgB64: string, criteria: string): Promise<{ pass: boolean; notes: string }> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5vl:7b',
      prompt: `You are a strict UI reviewer inspecting an app screenshot. Answer YES or NO on the first line, then a one-sentence reason.\n\n${criteria}`,
      images: [imgB64],
      stream: false,
      options: { num_ctx: 8192, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama VLM ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { response?: string };
  const raw = (json.response ?? '').trim();
  const pass = /^\s*(yes|true|pass)\b/i.test(raw.split('\n')[0]);
  return { pass, notes: raw };
}

function unloadVLM(): Promise<void> {
  return fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5vl:7b', prompt: '', keep_alive: 0 }),
  }).catch(() => {});
}

// ── Gate criteria per route type ─────────────────────────────────────────────
function gateCriteria(route: string, viewportLabel: string): string[] {
  const criteria: string[] = [];

  if (viewportLabel === 'mobile' && !['/kb'].includes(route)) {
    criteria.push('Is the page content readable on a narrow screen without horizontal scrolling?');
  } else if (viewportLabel === 'desktop') {
    criteria.push('Is there meaningful graph or space content visible in the viewport (nodes, statements, cards — not just chrome)?');
  }

  // Universal gates
  criteria.push('Are any text labels or node labels visible and not overlapping/colliding with each other?');
  criteria.push('Does the page layout appear coherent (no broken panels, cut-off elements, or missing regions)?');

  // Route-specific
  if (route === '/kb') {
    criteria.push('Can you see graph nodes or a knowledge space visualization on the canvas?');
    criteria.push('Is the left navigation panel visible and not covering the graph?');
  } else if (route === '/review') {
    criteria.push('Are pending assertions or review items listed in cards or rows?');
    criteria.push('Can you see a status indicator (badge, color) on each item?');
  } else if (route === '/ingest') {
    criteria.push('Is the extract/source area visible with statement content?');
  } else if (route === '/') {
    criteria.push('Is the Shelly prompt or call-to-action visible at the top of the page?');
  }

  // Statement-specific gates (Matt's focus: validate that actual statements render correctly)
  criteria.push('If text is displayed as content, can you read it without ambiguity (not just blocks of identical characters)?');
  criteria.push('If a statement or card shows a claim/predicate/object structure, are the different parts visually separated?');

  return criteria;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Space visual gate — ${BASE} · ${ROUTES.length} routes × ${VIEWPORTS.length} viewports · qwen2.5vl:7b\n`);

  const browser = await chromium.launch({ headless: true });
  const findings: { subject: string; predicate: string; question: string; kb: string; type: string; priority: string }[] = [];
  let totalChecks = 0, passed = 0, failed = 0, errored = 0, skippedPages = 0;

  for (const route of ROUTES) {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      try {
        console.log(`\n${route} (${vp.label}) …`);

        // Phase 1: Screenshot with real data
        const imgB64 = await shot(page, BASE + route);

        // Save screenshot for review — under runs/ (gitignored), so a scheduled run never dirties the tree
        const snapDir = 'reckons-workspace/runs/space-gate';
        mkdirSync(snapDir, { recursive: true });
        writeFileSync(
          path.join(snapDir, `${route.replace(/\//g, '_')}_${vp.label}.png`),
          Buffer.from(imgB64, 'base64'),
        );

        // Phase 2: VLM gate checks against real content
        const criteria = gateCriteria(route, vp.label);
        let routeFailed = false;

        for (let i = 0; i < criteria.length; i++) {
          totalChecks++;
          try {
            const result = await askVLM(imgB64, `${criteria[i]}\n(Use "viewport" to refer to what is visible on screen.)`);
            if (result.pass) {
              passed++;
            } else {
              failed++;
              routeFailed = true;
              findings.push({
                subject: `urn:sweep:space-gate${route.replace(/[^a-z0-9]+/gi, '-')}${vp.label}`,
                predicate: 'urn:sweep:pred/visual-regression',
                question: `[space-visual-gate] ${route} @ ${vp.label}: FAIL #${i + 1}\nCheck: ${criteria[i]}\n\nVLM response:\n${result.notes}`,
                kb: 'roadmap',
                type: 'question',
                priority: failed >= 3 ? 'high' : 'medium',
              });
            }
          } catch (e) {
            // VLM error — note it but don't let it fail the whole run
            errored++;
            console.log(`  ⚠ gate check #${i + 1} error: ${(e as Error).message.slice(0, 80)}`);
          }
        }

        const status = routeFailed ? '⚠ HAS ISSUES' : '✓ all gates passed';
        console.log(`  ${status} (${criteria.length} gates)`);
      } catch (e) {
        skippedPages++;
        console.log(`  ⏭ skipped (${(e as Error).message.slice(0, 80)})`);
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  await unloadVLM();

  // Write receipt
  const runsDir = 'reckons-workspace/runs';
  mkdirSync(runsDir, { recursive: true });
  const receipt = path.join(runsDir, `space-visual-gate_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(receipt, JSON.stringify({
    schema: 'reckons.space-visual-gate/v1',
    url: BASE,
    totalChecks, passed, failed, errored, skippedPages,
    findingsCount: findings.length,
    finishedAt: new Date().toISOString(),
  }, null, 2));

  // Queue findings via pending queue (mimic the existing pattern). Dedup on page + check, not page
  // alone: keyed by subject only, the first failing check on a page hid every later one forever.
  const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
  const keyOf = (subject: string, question: string) => `${subject}\u0000${question.split('\n')[1] ?? ''}`;
  const seen = new Set<string>();
  if (existsSync(PENDING)) {
    for (const l of readFileSync(PENDING, 'utf8').split('\n')) {
      if (!l.includes('urn:sweep:space-gate')) continue;
      try { const e = JSON.parse(l) as { subject?: string; question?: string }; if (e.subject && e.question) seen.add(keyOf(e.subject, e.question)); } catch { /* skip malformed */ }
    }
  }
  let queued = 0;
  for (const f of findings) {
    const k = keyOf(f.subject, f.question);
    if (seen.has(k)) continue;
    seen.add(k);
    appendFileSync(PENDING, JSON.stringify({ ...f, agent: 'offline:space-visual-gate (qwen2.5vl:7b)', addedAt: new Date().toISOString() }) + '\n');
    queued++;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Space visual gate done: ${passed}/${totalChecks} gates passed, ${failed} failures, ${errored} VLM errors, ${skippedPages} pages skipped → ${queued} new pending findings`);
  console.log(`Receipt: ${receipt}`);
  if (failed > 0) {
    console.log('⚠ Visual issues detected — review in Reckons.AI (Review tab).');
  }
  // Nothing checked is not a pass: no dev server or no VLM must fail loudly, not report "all 0 gates passed".
  if (passed + failed === 0) {
    console.error(`✗ no gate was evaluated — is the dev server up at ${BASE} and qwen2.5vl:7b pulled at ${OLLAMA_URL}?`);
    process.exit(2);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
