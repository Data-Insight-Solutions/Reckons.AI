#!/usr/bin/env npx tsx
/**
 * Coding Bench Runner
 *
 * Scores local Ollama models on self-contained code-gen/edit tasks (see
 * coding-golden.ts). For each model × task: prompt the model, extract its
 * TypeScript code block, run the task's driver with tsx in an isolated temp
 * dir, and record pass/fail + latency + tokens + output cleanliness.
 *
 * Usage:
 *   npx tsx tests/bench/run-coding-bench.ts
 *   npx tsx tests/bench/run-coding-bench.ts --models qwen3-coder,devstral-small-2
 *   npx tsx tests/bench/run-coding-bench.ts --save
 *   npx tsx tests/bench/run-coding-bench.ts --ctx 8192
 *
 * Requires: Ollama running with the models pulled.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CODING_TASKS, TOTAL_TASKS, type CodingTask } from './coding-golden';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(__dirname, 'results');

const args = process.argv.slice(2);
const save = args.includes('--save');
const getArg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const NUM_CTX = parseInt(getArg('--ctx', '8192'), 10);
const DEFAULT_MODELS = ['qwen3-coder', 'devstral-small-2', 'gpt-oss:20b', 'nemotron3:33b', 'llama3.2:3b'];
const MODELS = getArg('--models', DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const SYSTEM = 'You are a precise coding assistant. Respond with exactly one TypeScript code block ' +
  'implementing the requested export, and nothing else — no explanation before or after.';

interface ChatResult { text: string; ms: number; evalCount: number; }

async function chat(model: string, prompt: string): Promise<ChatResult> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      stream: false,
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: NUM_CTX },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { message?: { content?: string }; eval_count?: number };
  return { text: j.message?.content ?? '', ms: Date.now() - t0, evalCount: j.eval_count ?? 0 };
}

async function unload(model: string) {
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
    });
  } catch { /* best effort */ }
}

/** Pull the largest fenced code block; fall back to stripping stray fences. */
function extractCode(text: string): { code: string; hadFence: boolean } {
  const blocks = [...text.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (blocks.length) {
    const code = blocks.sort((a, b) => b.length - a.length)[0];
    return { code: code.trim(), hadFence: true };
  }
  return { code: text.replace(/```/g, '').trim(), hadFence: false };
}

interface TaskOutcome {
  id: string; kind: string; pass: boolean; hadFence: boolean; cleanOnly: boolean;
  ms: number; evalCount: number; detail: string;
}
interface ModelReport {
  model: string; outcomes: TaskOutcome[];
  passed: number; total: number; passRate: number;
  cleanRate: number; meanMs: number; totalTokens: number; error?: string;
}

function runDriver(task: CodingTask, code: string): { pass: boolean; detail: string } {
  // mkdtempSync, not mkdirSync+Math.random: it creates the directory ATOMICALLY with a
  // unique, unpredictable suffix. The old form was guessable and racy — another process
  // could pre-create the path and have our code write into a directory it controls,
  // which matters because we then EXECUTE a file from it (CodeQL js/insecure-temporary-file).
  const dir = mkdtempSync(join(tmpdir(), `codebench-${task.id}-`));
  try {
    writeFileSync(join(dir, 'solution.ts'), code);
    writeFileSync(join(dir, 'driver.ts'), task.driver);
    execFileSync('npx', ['tsx', join(dir, 'driver.ts')], { cwd: dir, timeout: 30_000, stdio: 'pipe' });
    return { pass: true, detail: 'ok' };
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    const lines = (err.stderr?.toString() || err.message || 'failed').split('\n').map((l) => l.trim()).filter(Boolean);
    // prefer the actual error/assertion line over the Node version banner or stack frames
    const informative = lines.find((l) => /(Assertion|Error|expected|Cannot|is not|SyntaxError|Type)/i.test(l) && !/^at\s/.test(l));
    return { pass: false, detail: (informative ?? lines[0] ?? 'failed').slice(0, 120) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function benchModel(model: string): Promise<ModelReport> {
  const outcomes: TaskOutcome[] = [];
  for (const task of CODING_TASKS) {
    try {
      const { text, ms, evalCount } = await chat(model, task.prompt);
      const { code, hadFence } = extractCode(text);
      // "cleanOnly": the response was essentially just the code block (good instruction-following)
      const cleanOnly = hadFence && text.trim().length - code.length < 40;
      const { pass, detail } = code ? runDriver(task, code) : { pass: false, detail: 'no code produced' };
      outcomes.push({ id: task.id, kind: task.kind, pass, hadFence, cleanOnly, ms, evalCount, detail });
    } catch (e) {
      outcomes.push({ id: task.id, kind: task.kind, pass: false, hadFence: false, cleanOnly: false, ms: 0, evalCount: 0, detail: (e as Error).message.slice(0, 120) });
    }
  }
  const passed = outcomes.filter((o) => o.pass).length;
  const times = outcomes.map((o) => o.ms).filter((m) => m > 0);
  return {
    model, outcomes, passed, total: outcomes.length, passRate: passed / outcomes.length,
    cleanRate: outcomes.filter((o) => o.cleanOnly).length / outcomes.length,
    meanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    totalTokens: outcomes.reduce((s, o) => s + o.evalCount, 0),
  };
}

function printReport(reports: ModelReport[]) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`CODING BENCH — ${TOTAL_TASKS} tasks (${CODING_TASKS.map((t) => t.kind).join(', ')})`);
  console.log('═'.repeat(72));
  const ranked = [...reports].sort((a, b) => b.passRate - a.passRate || a.meanMs - b.meanMs);

  console.log('\nLEADERBOARD (ranked by pass rate, then speed)\n');
  console.log('model'.padEnd(22) + 'pass'.padStart(8) + 'clean'.padStart(8) + 'meanMs'.padStart(9) + 'tokens'.padStart(8));
  console.log('─'.repeat(55));
  for (const r of ranked) {
    if (r.error) { console.log(`${r.model.padEnd(22)}  ERROR: ${r.error}`); continue; }
    console.log(
      r.model.padEnd(22) +
      `${r.passed}/${r.total}`.padStart(8) +
      `${(100 * r.cleanRate).toFixed(0)}%`.padStart(8) +
      r.meanMs.toFixed(0).padStart(9) +
      String(r.totalTokens).padStart(8),
    );
  }
  console.log('\n  pass = driver-verified correct   clean = response was code-only (instruction-following)');

  // per-task matrix
  console.log('\nPER-TASK (✓ pass · ✗ fail)\n');
  const head = 'task'.padEnd(22) + ranked.map((r) => r.model.slice(0, 10).padStart(11)).join('');
  console.log(head); console.log('─'.repeat(head.length));
  for (const task of CODING_TASKS) {
    let row = `${task.id} (${task.kind})`.padEnd(22);
    for (const r of ranked) {
      const o = r.outcomes.find((x) => x.id === task.id);
      row += (o?.pass ? '✓' : '✗').padStart(11);
    }
    console.log(row);
  }

  // failure detail
  for (const r of ranked) {
    const fails = r.outcomes.filter((o) => !o.pass);
    if (fails.length) {
      console.log(`\n✗ ${r.model} failures:`);
      for (const f of fails) console.log(`   ${f.id.padEnd(22)} ${f.detail}`);
    }
  }
  console.log('');
}

async function main() {
  console.log(`Ollama: ${OLLAMA_URL}\nModels: ${MODELS.join(', ')}`);
  let installed: string[] = [];
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as { models?: { name: string }[] };
    installed = (tags.models ?? []).map((m) => m.name);
  } catch (e) { console.error(`Cannot reach Ollama: ${(e as Error).message}`); process.exit(1); }

  const reports: ModelReport[] = [];
  for (const model of MODELS) {
    const present = installed.some((n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`));
    if (!present) { console.log(`\n• ${model} — NOT INSTALLED, skipping`); continue; }
    console.log(`\n• ${model} — ${TOTAL_TASKS} tasks…`);
    await unload(model);
    const rep = await benchModel(model);
    console.log(`  ${rep.passed}/${rep.total} pass · ${rep.meanMs.toFixed(0)}ms mean · ${rep.totalTokens} tokens`);
    reports.push(rep);
    await unload(model);
  }
  printReport(reports);

  if (save) {
    if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `coding-bench_${stamp}.json`);
    writeFileSync(out, JSON.stringify({ url: OLLAMA_URL, tasks: TOTAL_TASKS, reports }, null, 2));
    console.log(`Saved → ${out}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
