#!/usr/bin/env npx tsx
/**
 * VLM Gate Bench Runner
 *
 * Scores local Ollama vision models as "does this appear" visual gates against
 * the human-labeled dataset in vlm-golden.ts. The gate pattern: a cheap local
 * VLM screens every screenshot; only its flags escalate to an expensive
 * reviewer (Claude Vision / Opus). So the metrics that matter are not just raw
 * accuracy but the *direction* of errors:
 *
 *   - false-"no"  (model says NO, truth YES)  → a MISS: the gate waved through
 *                                                something real. Worst outcome.
 *   - false-"yes" (model says YES, truth NO)  → a FALSE FLAG: wastes a reviewer
 *                                                pass. Throughput tax, not a miss.
 *   - ambiguous   (neither/both)              → treated as a flag (escalates).
 *
 * Usage:
 *   npx tsx tests/visual/run-vlm-gate-bench.ts
 *   npx tsx tests/visual/run-vlm-gate-bench.ts --models granite3.2-vision,moondream
 *   npx tsx tests/visual/run-vlm-gate-bench.ts --save
 *   npx tsx tests/visual/run-vlm-gate-bench.ts --url http://localhost:11434
 *
 * Requires: Ollama running with the vision models pulled.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VLM_GOLDEN, TOTAL_CHECKS, type YesNo } from './vlm-golden';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'screenshots');
const RESULTS = resolve(__dirname, 'results');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const save = args.includes('--save');
const getArg = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
// One screenshot encodes to a few thousand image tokens (granite ~6.6k); the full
// 128k VLM default just balloons VRAM. Big enough to hold an image, small enough
// that every model fits on one GPU without contention.
const NUM_CTX = parseInt(getArg('--ctx', '8192'), 10);
const DEFAULT_MODELS = ['granite3.2-vision', 'qwen2.5vl:3b', 'qwen2.5vl:7b', 'moondream'];
const MODELS = getArg('--models', DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// ── Ollama vision call ───────────────────────────────────────────────────────
async function askVLM(model: string, imgB64: string, question: string): Promise<{ raw: string; ms: number }> {
  const prompt = `${question}\nAnswer with exactly one word: YES or NO.`;
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [imgB64],
      stream: false,
      keep_alive: '10m',
      options: { temperature: 0, num_predict: 12, num_ctx: NUM_CTX },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response?: string };
  return { raw: (json.response ?? '').trim(), ms: Date.now() - t0 };
}

/** Evict a model from VRAM so the next candidate loads without contention. */
async function unload(model: string): Promise<void> {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
    });
  } catch { /* best-effort */ }
}

/** Parse a yes/no verdict; null = ambiguous (which the gate treats as a flag). */
function parseVerdict(raw: string): YesNo | null {
  const t = raw.toUpperCase().replace(/[^A-Z ]/g, ' ');
  const yes = /\bYES\b/.test(t);
  const no = /\bNO\b/.test(t) && !/\bKNOW\b/.test(t);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────
interface CheckOutcome {
  image: string; id: string; type: string; expect: YesNo;
  verdict: YesNo | null; correct: boolean; ms: number; raw: string;
}
interface ModelReport {
  model: string;
  outcomes: CheckOutcome[];
  total: number; correct: number; accuracy: number;
  misses: number;      // false-"no": said no, truth yes
  falseFlags: number;  // false-"yes": said yes, truth no
  ambiguous: number;
  p50: number; p95: number; meanMs: number;
  byType: Record<string, { total: number; correct: number }>;
  gateScore: number;   // 0.5*recall + 0.3*precision + 0.2*(1-normLatency)
  error?: string;
}

const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function b64(imgPath: string): Promise<string> {
  return readFileSync(imgPath).toString('base64');
}

async function benchModel(model: string): Promise<ModelReport> {
  const outcomes: CheckOutcome[] = [];
  // warm the model so the first real timing isn't dominated by load
  try {
    const first = VLM_GOLDEN[0];
    await askVLM(model, await b64(join(SHOTS, first.image)), 'Is this an image? Answer YES or NO.');
  } catch (e) {
    return blankReport(model, `warmup failed: ${(e as Error).message}`);
  }

  for (const cse of VLM_GOLDEN) {
    const img = await b64(join(SHOTS, cse.image));
    for (const chk of cse.checks) {
      try {
        const { raw, ms } = await askVLM(model, img, chk.q);
        const verdict = parseVerdict(raw);
        outcomes.push({
          image: cse.image, id: chk.id, type: chk.type, expect: chk.expect,
          verdict, correct: verdict === chk.expect, ms, raw,
        });
      } catch (e) {
        outcomes.push({
          image: cse.image, id: chk.id, type: chk.type, expect: chk.expect,
          verdict: null, correct: false, ms: 0, raw: `ERR:${(e as Error).message}`,
        });
      }
    }
  }
  return summarize(model, outcomes);
}

function blankReport(model: string, error: string): ModelReport {
  return { model, outcomes: [], total: 0, correct: 0, accuracy: 0, misses: 0, falseFlags: 0,
    ambiguous: 0, p50: 0, p95: 0, meanMs: 0, byType: {}, gateScore: 0, error };
}

function summarize(model: string, outcomes: CheckOutcome[]): ModelReport {
  const total = outcomes.length;
  const correct = outcomes.filter((o) => o.correct).length;
  // A "positive" = the flaggable condition is present (truth = yes).
  const truthYes = outcomes.filter((o) => o.expect === 'yes');
  const truthNo = outcomes.filter((o) => o.expect === 'no');
  const misses = truthYes.filter((o) => o.verdict === 'no').length;           // said no on a yes
  const caughtYes = truthYes.filter((o) => o.verdict !== 'no').length;         // yes or ambiguous → escalates
  const ambiguous = outcomes.filter((o) => o.verdict === null).length;
  const falseFlags = truthNo.filter((o) => o.verdict !== 'no').length;         // said yes/ambiguous on a no
  const recall = truthYes.length ? caughtYes / truthYes.length : 1;            // 1 - miss rate
  const flaggedTotal = caughtYes + falseFlags;
  const precision = flaggedTotal ? caughtYes / flaggedTotal : 1;

  const byType: Record<string, { total: number; correct: number }> = {};
  for (const o of outcomes) {
    const b = (byType[o.type] ??= { total: 0, correct: 0 });
    b.total++; if (o.correct) b.correct++;
  }

  const times = outcomes.map((o) => o.ms).filter((m) => m > 0);
  const meanMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const p50 = quantile(times, 0.5);
  const p95 = quantile(times, 0.95);
  // normalize latency against a 6s "slow" ceiling for the composite
  const normLat = Math.min(1, meanMs / 6000);
  const accuracy = correct / total;
  // Recall (miss-avoidance) dominates, but accuracy is included so a model that
  // just flags everything (perfect recall, useless discrimination) can't win.
  const gateScore = 0.4 * recall + 0.25 * precision + 0.2 * accuracy + 0.15 * (1 - normLat);

  return { model, outcomes, total, correct, accuracy: correct / total, misses, falseFlags,
    ambiguous, p50, p95, meanMs, byType, gateScore };
}

// ── Reporting ────────────────────────────────────────────────────────────────
function printReport(reports: ModelReport[]) {
  const allTypes = [...new Set(VLM_GOLDEN.flatMap((g) => g.checks.map((c) => c.type)))];
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`VLM GATE BENCH — ${VLM_GOLDEN.length} images, ${TOTAL_CHECKS} labeled checks`);
  console.log('═'.repeat(78));

  // leaderboard, sorted by gate score
  const ranked = [...reports].sort((a, b) => b.gateScore - a.gateScore);
  console.log('\nLEADERBOARD (ranked by gate score)\n');
  console.log(
    `${'model'.padEnd(20)}${'gate'.padStart(6)}${'acc'.padStart(7)}` +
    `${'miss'.padStart(6)}${'flag'.padStart(6)}${'amb'.padStart(5)}${'p50ms'.padStart(8)}${'p95ms'.padStart(8)}`,
  );
  console.log('─'.repeat(66));
  for (const r of ranked) {
    if (r.error) { console.log(`${r.model.padEnd(20)}  ERROR: ${r.error}`); continue; }
    console.log(
      r.model.padEnd(20) +
      r.gateScore.toFixed(2).padStart(6) +
      `${pct(r.correct, r.total).toFixed(0)}%`.padStart(7) +
      String(r.misses).padStart(6) +
      String(r.falseFlags).padStart(6) +
      String(r.ambiguous).padStart(5) +
      r.p50.toFixed(0).padStart(8) +
      r.p95.toFixed(0).padStart(8),
    );
  }
  console.log('\n  gate = 0.4·recall + 0.25·precision + 0.2·accuracy + 0.15·(1−latency)   ' +
    'miss = waved through a real positive (worst)   flag = false alarm');

  // per-capability accuracy matrix
  console.log('\nPER-CAPABILITY ACCURACY (% correct)\n');
  const header = 'check'.padEnd(12) + ranked.map((r) => r.model.slice(0, 12).padStart(13)).join('');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const t of allTypes) {
    let row = t.padEnd(12);
    for (const r of ranked) {
      const b = r.byType[t];
      row += (b ? `${pct(b.correct, b.total).toFixed(0)}%` : '—').padStart(13);
    }
    console.log(row);
  }

  // per-model miss detail (the dangerous errors)
  for (const r of ranked) {
    const missRows = r.outcomes.filter((o) => o.expect === 'yes' && o.verdict === 'no');
    if (missRows.length) {
      console.log(`\n⚠ ${r.model} MISSES (waved through truth=yes):`);
      for (const m of missRows) console.log(`   ${m.image}  [${m.id}]  → said "${m.raw.slice(0, 20)}"`);
    }
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Models: ${MODELS.join(', ')}`);
  // verify availability
  let installed: string[] = [];
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as { models?: { name: string }[] };
    installed = (tags.models ?? []).map((m) => m.name);
  } catch (e) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}: ${(e as Error).message}`);
    process.exit(1);
  }
  const reports: ModelReport[] = [];
  for (const model of MODELS) {
    const present = installed.some((n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`));
    if (!present) {
      console.log(`\n• ${model} — NOT INSTALLED, skipping (ollama pull ${model})`);
      reports.push(blankReport(model, 'not installed'));
      continue;
    }
    console.log(`\n• ${model} — running ${TOTAL_CHECKS} checks (num_ctx=${NUM_CTX})…`);
    await unload(model); // clear any prior/bad-state residency before loading fresh
    const t0 = Date.now();
    const rep = await benchModel(model);
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
      `acc ${pct(rep.correct, rep.total).toFixed(0)}%  miss ${rep.misses}  flag ${rep.falseFlags}`);
    reports.push(rep);
    await unload(model); // evict so the next model has the full GPU
  }

  printReport(reports);

  if (save) {
    if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `vlm-gate_${stamp}.json`);
    writeFileSync(out, JSON.stringify({ url: OLLAMA_URL, images: VLM_GOLDEN.length, checks: TOTAL_CHECKS, reports }, null, 2));
    console.log(`Saved → ${out}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
