#!/usr/bin/env npx tsx
/**
 * Cost Bench Runner — full system vs. Opus alone.
 *
 * Compares Opus token cost across three arms on KB-grounded generation tasks:
 *   A0  Opus alone    — raw KB corpus in context; Opus writes the blurb
 *   A1  Opus + graph  — compressed subgraph in context; Opus writes the blurb
 *   A2  full system   — local model writes the blurb from the compressed subgraph;
 *                       Opus reviews/corrects (short output)
 *
 * Opus is billed pay-per-use; local (Ollama) tokens are ~free (electricity). We
 * read exact token usage from each API response and infer $ from published prices.
 * Quality is graded identically per arm (expected-fact coverage), so a cheaper arm
 * only "wins" if it stays correct.
 *
 * SAFETY / COST: this makes live Opus calls. It caps output tokens and omits
 * thinking to keep spend predictable. Uses VITE_ANTHROPIC_API_KEY from .env.
 *
 * Usage:
 *   npx tsx tests/bench/run-cost-bench.ts            # dry-run: prints token/cost estimate, no Opus calls
 *   npx tsx tests/bench/run-cost-bench.ts --run      # actually call Opus (spends a few cents)
 *   npx tsx tests/bench/run-cost-bench.ts --run --save
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { COST_TASKS, CORPUS_FILES, TOTAL_COST_TASKS, type CostTask } from './cost-golden';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const RESULTS = resolve(__dirname, 'results');

const args = process.argv.slice(2);
const doRun = args.includes('--run');
const save = args.includes('--save');
const getArg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const LOCAL_MODEL = getArg('--local', 'gpt-oss:20b');
const ONLY = getArg('--only', ''); // run a single task id
const OPUS_MODEL = 'claude-opus-4-8';

// Opus 4.8 pricing, $/token (from the claude-api skill).
const PRICE = { in: 5 / 1e6, out: 25 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 };

// Load .env for VITE_ANTHROPIC_API_KEY
function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ── Context builders ─────────────────────────────────────────────────────────
function rawCorpus(): string {
  return CORPUS_FILES
    .map((f) => { try { return readFileSync(join(ROOT, f), 'utf8'); } catch { return ''; } })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * kb_compress-style compression: split the corpus into entity blocks, rank each by
 * overlap with the query terms, keep the top blocks under a char budget, always
 * retain @prefix lines. Mirrors the MCP server's search→subgraph→compact pipeline
 * (this is a faithful stand-in, not a call into compressTriples itself).
 */
function compress(corpus: string, query: string, budgetChars = 9000): string {
  const prefixes = corpus.split('\n').filter((l) => l.startsWith('@prefix')).join('\n');
  const blocks = corpus.split(/\n\s*\n/).filter((b) => b.trim() && !b.trim().startsWith('@prefix'));
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const scored = blocks.map((b) => {
    const low = b.toLowerCase();
    return { b, score: terms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  let out = prefixes + '\n\n', used = out.length;
  for (const { b } of scored) {
    if (used + b.length > budgetChars) break;
    out += b + '\n\n'; used += b.length + 2;
  }
  return out.trim();
}

// ── Model calls ──────────────────────────────────────────────────────────────
interface Usage { in: number; out: number; cacheRead: number; cacheWrite: number; }
const zero = (): Usage => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a: Usage, b: Usage): Usage => ({ in: a.in + b.in, out: a.out + b.out, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const dollars = (u: Usage) => u.in * PRICE.in + u.out * PRICE.out + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite;

let client: Anthropic;
async function opus(system: string, user: string, maxTokens: number): Promise<{ text: string; usage: Usage }> {
  const r = await client.messages.create({
    model: OPUS_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }); // thinking omitted → Opus 4.8 runs without thinking (predictable, cheap output)
  const text = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  const u = r.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  return { text, usage: { in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
}

async function local(prompt: string, numPredict = 400): Promise<{ text: string; evalCount: number }> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_MODEL, prompt, stream: false, keep_alive: '5m', options: { temperature: 0, num_ctx: 8192, num_predict: numPredict } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = (await res.json()) as { response?: string; eval_count?: number };
  return { text: (j.response ?? '').trim(), evalCount: j.eval_count ?? 0 };
}

function grade(text: string, expect: string[]): number {
  const low = text.toLowerCase();
  return expect.filter((e) => low.includes(e.toLowerCase())).length / expect.length;
}

// ── Arms ─────────────────────────────────────────────────────────────────────
interface ArmResult { arm: string; usage: Usage; localTokens: number; cov: number; text: string; }

async function runTask(task: CostTask, raw: string): Promise<ArmResult[]> {
  const comp = compress(raw, task.query);
  const maxOut = task.maxOut ?? 400;
  const sys = 'You write concise, accurate documentation grounded strictly in the provided knowledge-graph context. Do not invent facts.';
  const out: ArmResult[] = [];

  // A0 — Opus alone, raw corpus
  {
    const { text, usage } = await opus(sys, `KNOWLEDGE GRAPH:\n${raw}\n\nTASK: ${task.prompt}`, maxOut);
    out.push({ arm: 'A0 opus-alone', usage, localTokens: 0, cov: grade(text, task.expect), text });
  }
  // A1 — Opus + compressed graph
  {
    const { text, usage } = await opus(sys, `KNOWLEDGE GRAPH (compressed):\n${comp}\n\nTASK: ${task.prompt}`, maxOut);
    out.push({ arm: 'A1 opus+graph', usage, localTokens: 0, cov: grade(text, task.expect), text });
  }
  // A2 — local writes from compressed graph, Opus reviews (short output = the saving)
  {
    const draft = await local(`KNOWLEDGE GRAPH (compressed):\n${comp}\n\nTASK: ${task.prompt}\n\nWrite it now:`, maxOut);
    const review = await opus(
      'You are reviewing a draft for factual accuracy against the provided compressed knowledge graph. If it is accurate and complete, reply with only "APPROVED". Otherwise return a corrected version. Do not pad.',
      `COMPRESSED GRAPH:\n${comp}\n\nTASK: ${task.prompt}\n\nDRAFT:\n${draft.text}\n\nReview:`,
      Math.min(400, maxOut),
    );
    // if Opus approved, the delivered text is the local draft; else Opus's correction
    const finalText = /^\s*APPROVED\b/i.test(review.text) ? draft.text : review.text;
    out.push({ arm: 'A2 full-system', usage: review.usage, localTokens: draft.evalCount, cov: grade(finalText, task.expect), text: finalText });
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();
  const raw = rawCorpus();
  console.log(`Corpus: ${CORPUS_FILES.join(', ')}  (~${Math.round(raw.length / 4)} tokens)`);
  console.log(`Tasks: ${TOTAL_COST_TASKS}   Local model (A2): ${LOCAL_MODEL}   Opus: ${OPUS_MODEL}`);

  if (!doRun) {
    // Dry run: estimate only, no Opus calls
    const est = Math.round(raw.length / 4);
    console.log('\n[dry-run] pass --run to make live Opus calls. Rough per-task estimate:');
    console.log(`  A0 ~${est} in + 400 out  ≈ $${(est * PRICE.in + 400 * PRICE.out).toFixed(3)}`);
    console.log(`  A1 ~2200 in + 400 out    ≈ $${(2200 * PRICE.in + 400 * PRICE.out).toFixed(3)}`);
    console.log(`  A2 ~2500 in + 200 out    ≈ $${(2500 * PRICE.in + 200 * PRICE.out).toFixed(3)} (+ free local)`);
    console.log(`  → full run of ${TOTAL_COST_TASKS} tasks ≈ $${(TOTAL_COST_TASKS * (est * PRICE.in + 400 * PRICE.out + 2200 * PRICE.in + 400 * PRICE.out + 2500 * PRICE.in + 200 * PRICE.out)).toFixed(2)}`);
    return;
  }

  const key = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('No VITE_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY found in env/.env'); process.exit(1); }
  client = new Anthropic({ apiKey: key });

  const tasks = ONLY ? COST_TASKS.filter((t) => t.id === ONLY) : COST_TASKS;
  if (!tasks.length) { console.error(`No task matches --only ${ONLY}`); process.exit(1); }
  const byArm: Record<string, { usage: Usage; localTokens: number; cov: number[] }> = {};
  for (const task of tasks) {
    process.stdout.write(`\n• ${task.id}… `);
    const results = await runTask(task, raw);
    for (const r of results) {
      const a = (byArm[r.arm] ??= { usage: zero(), localTokens: 0, cov: [] });
      a.usage = add(a.usage, r.usage); a.localTokens += r.localTokens; a.cov.push(r.cov);
      process.stdout.write(`${r.arm.split(' ')[0]}:$${dollars(r.usage).toFixed(4)}(${(r.cov * 100).toFixed(0)}%) `);
    }
  }

  // Report
  console.log(`\n\n${'═'.repeat(76)}`);
  console.log(`COST BENCH — ${TOTAL_COST_TASKS} KB-grounded generation tasks  (Opus ${OPUS_MODEL} pay-per-use)`);
  console.log('═'.repeat(76));
  console.log('\narm'.padEnd(18) + 'opus_in'.padStart(9) + 'opus_out'.padStart(9) + 'local_tok'.padStart(10) + 'opus_$'.padStart(9) + 'quality'.padStart(9) + '$/success'.padStart(11));
  console.log('─'.repeat(75));
  const arms = ['A0 opus-alone', 'A1 opus+graph', 'A2 full-system'];
  const rows: Record<string, { d: number; q: number }> = {};
  for (const arm of arms) {
    const a = byArm[arm]; if (!a) continue;
    const d = dollars(a.usage);
    const q = a.cov.reduce((s, c) => s + c, 0) / a.cov.length;
    rows[arm] = { d, q };
    console.log(
      arm.padEnd(18) +
      String(a.usage.in).padStart(9) + String(a.usage.out).padStart(9) +
      String(a.localTokens).padStart(10) +
      `$${d.toFixed(4)}`.padStart(9) +
      `${(q * 100).toFixed(0)}%`.padStart(9) +
      `$${(q ? d / q : d).toFixed(4)}`.padStart(11),
    );
  }
  const a0 = rows['A0 opus-alone'];
  if (a0) {
    console.log('\nSavings vs A0 (Opus alone):');
    for (const arm of ['A1 opus+graph', 'A2 full-system']) {
      const r = rows[arm]; if (!r) continue;
      console.log(`  ${arm.padEnd(16)} ${(100 * (1 - r.d / a0.d)).toFixed(0)}% cheaper Opus spend   quality ${(r.q * 100).toFixed(0)}% (vs ${(a0.q * 100).toFixed(0)}%)`);
    }
  }
  console.log('\n  local tokens are ~free (your GPUs); opus_$ is the pay-per-use axis. quality = expected-fact coverage.');

  if (save) {
    if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `cost-bench_${stamp}.json`);
    writeFileSync(out, JSON.stringify({ opusModel: OPUS_MODEL, localModel: LOCAL_MODEL, tasks: TOTAL_COST_TASKS, price: PRICE, arms: byArm, rows }, null, 2));
    console.log(`\nSaved → ${out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
