#!/usr/bin/env npx tsx
/**
 * Agentic Bench Runner
 *
 * Drives each local Ollama model as a tool-using agent through the tasks in
 * agentic-tasks.ts. For each model × task: spin up a sandbox temp dir with the
 * starter files, then loop — call the model with the tool schema, execute the
 * tool calls it emits (list_files/read_file/write_file/run_tests/finish), feed
 * results back — until it finishes or hits the turn cap. Then verify.
 *
 * Metrics beyond pass/fail: turns, self-verification (ran the tests?), scope
 * discipline (edited only allowed files?), spiral (hit the cap without
 * finishing?), tool errors, tokens, latency.
 *
 * SAFETY: run_tests only ever runs the task's FIXED testCmd. File tools are
 * path-jailed to the sandbox. As with the coding bench, model-authored code is
 * executed via tsx inside the throwaway sandbox — run only against local models
 * you trust, on tasks you control.
 *
 * Usage:
 *   npx tsx tests/bench/run-agentic-bench.ts
 *   npx tsx tests/bench/run-agentic-bench.ts --models qwen3-coder,devstral-small-2
 *   npx tsx tests/bench/run-agentic-bench.ts --save --max-turns 14
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, resolve, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { AGENTIC_TASKS, TOTAL_AGENTIC, type AgenticTask } from './agentic-tasks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(__dirname, 'results');

const args = process.argv.slice(2);
const save = args.includes('--save');
const getArg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const NUM_CTX = parseInt(getArg('--ctx', '32768'), 10);
const MAX_TURNS = parseInt(getArg('--max-turns', '14'), 10);
const DEFAULT_MODELS = ['qwen3-coder', 'devstral-small-2', 'gpt-oss:20b', 'nemotron3:33b', 'llama3.2:3b'];
const MODELS = getArg('--models', DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// ── Tool schema advertised to the model ──────────────────────────────────────
const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List files in the working directory.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file\'s full contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write (overwrite) a file with new contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_tests', description: 'Run the project test suite. Returns pass/fail and output.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'finish', description: 'Call when the task is complete and tests pass.', parameters: { type: 'object', properties: {}, required: [] } } },
];

const SYSTEM =
  'You are a coding agent working in a small TypeScript project. Use the provided tools to inspect ' +
  'and edit files and to run the tests. Make the smallest change that satisfies the goal, edit only ' +
  'the files the goal names, and always run_tests to confirm before you finish. Respond with tool ' +
  'calls, not prose.';

// ── Sandbox + jailed file ops ────────────────────────────────────────────────
function jail(sandbox: string, p: string): string {
  const cleaned = p.replace(/^\.\//, '');
  if (isAbsolute(cleaned) || cleaned.split('/').includes('..')) throw new Error('path not allowed');
  const full = resolve(sandbox, cleaned);
  if (relative(sandbox, full).startsWith('..')) throw new Error('path escapes sandbox');
  return full;
}

function runTests(sandbox: string, task: AgenticTask): { pass: boolean; output: string } {
  try {
    const out = execFileSync(task.testCmd[0], task.testCmd.slice(1), { cwd: sandbox, timeout: 30_000, stdio: 'pipe' });
    return { pass: true, output: out.toString().slice(-600) || 'ok' };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const text = `${err.stdout?.toString() ?? ''}\n${err.stderr?.toString() ?? err.message ?? 'failed'}`;
    return { pass: false, output: text.trim().slice(-600) };
  }
}

// ── Ollama chat with tools ───────────────────────────────────────────────────
interface ToolCall { name: string; args: Record<string, unknown>; }
interface Turn { content: string; toolCalls: ToolCall[]; rawAssistant: unknown; evalCount: number; ms: number; }

function parseArgs(a: unknown): Record<string, unknown> {
  if (a && typeof a === 'object') return a as Record<string, unknown>;
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
  return {};
}

async function chat(model: string, messages: unknown[]): Promise<Turn> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOLS, stream: false, keep_alive: '5m', options: { temperature: 0, num_ctx: NUM_CTX } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }; eval_count?: number };
  const msg = j.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: parseArgs(tc.function.arguments) }));
  return { content: msg.content ?? '', toolCalls, rawAssistant: msg, evalCount: j.eval_count ?? 0, ms: Date.now() - t0 };
}

async function unload(model: string) {
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [], keep_alive: 0 }) });
  } catch { /* best effort */ }
}

// ── One task run ─────────────────────────────────────────────────────────────
interface TaskOutcome {
  id: string; pass: boolean; turns: number; selfVerified: boolean; spiraled: boolean;
  scopeViolations: string[]; toolErrors: number; tokens: number; ms: number; detail: string;
}

async function runTask(model: string, task: AgenticTask): Promise<TaskOutcome> {
  const sandbox = join(tmpdir(), `agentbench-${task.id}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(sandbox, { recursive: true });
  for (const [name, content] of Object.entries(task.files)) writeFileSync(join(sandbox, name), content);

  const messages: unknown[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${task.goal}\n\nFiles present: ${Object.keys(task.files).join(', ')}` },
  ];
  const written = new Set<string>();
  let turns = 0, toolErrors = 0, tokens = 0, ms = 0, ranTests = false, finished = false, noOp = 0;

  while (turns < MAX_TURNS && !finished) {
    turns++;
    let turn: Turn;
    try { turn = await chat(model, messages); }
    catch (e) { return finalize(sandbox, task, { turns, ranTests, finished, toolErrors: toolErrors + 1, tokens, ms, written, spiraled: false, detail: (e as Error).message }); }
    tokens += turn.evalCount; ms += turn.ms;
    messages.push(turn.rawAssistant);

    if (turn.toolCalls.length === 0) {
      if (++noOp >= 3) break; // talking, not acting → spiral
      messages.push({ role: 'user', content: 'Use a tool (read_file / write_file / run_tests) or call finish.' });
      continue;
    }
    noOp = 0;

    for (const call of turn.toolCalls) {
      let result: string;
      try {
        if (call.name === 'list_files') result = readdirSync(sandbox).join('\n');
        else if (call.name === 'read_file') result = readFileSync(jail(sandbox, String(call.args.path)), 'utf8');
        else if (call.name === 'write_file') {
          const rel = String(call.args.path).replace(/^\.\//, '');
          writeFileSync(jail(sandbox, rel), String(call.args.content ?? ''));
          written.add(rel);
          result = `wrote ${rel}`;
        } else if (call.name === 'run_tests') {
          ranTests = true;
          const r = runTests(sandbox, task);
          result = `${r.pass ? 'PASS' : 'FAIL'}\n${r.output}`;
        } else if (call.name === 'finish') { finished = true; result = 'ok'; }
        else { toolErrors++; result = `unknown tool: ${call.name}`; }
      } catch (e) { toolErrors++; result = `error: ${(e as Error).message}`; }
      messages.push({ role: 'tool', name: call.name, content: result });
    }
  }

  return finalize(sandbox, task, { turns, ranTests, finished, toolErrors, tokens, ms, written, spiraled: !finished, detail: finished ? 'finished' : 'hit turn cap / no finish' });
}

function finalize(sandbox: string, task: AgenticTask, s: {
  turns: number; ranTests: boolean; finished: boolean; toolErrors: number; tokens: number; ms: number;
  written: Set<string>; spiraled: boolean; detail: string;
}): TaskOutcome {
  const verify = runTests(sandbox, task); // independent final check
  const scopeViolations = [...s.written].filter((f) => !task.allowedFiles.includes(f));
  rmSync(sandbox, { recursive: true, force: true });
  return {
    id: task.id, pass: verify.pass, turns: s.turns, selfVerified: s.ranTests, spiraled: s.spiraled,
    scopeViolations, toolErrors: s.toolErrors, tokens: s.tokens, ms: s.ms,
    detail: verify.pass ? s.detail : `verify FAIL: ${verify.output.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`.slice(0, 120),
  };
}

// ── Scoring ──────────────────────────────────────────────────────────────────
interface ModelReport {
  model: string; outcomes: TaskOutcome[];
  passRate: number; avgTurns: number; scopeViol: number; spirals: number; selfVerifyRate: number;
  tokens: number; ms: number; agentScore: number;
}

function score(model: string, outcomes: TaskOutcome[]): ModelReport {
  const n = outcomes.length;
  const passRate = outcomes.filter((o) => o.pass).length / n;
  const scopeViol = outcomes.reduce((s, o) => s + o.scopeViolations.length, 0);
  const spirals = outcomes.filter((o) => o.spiraled).length;
  const selfVerifyRate = outcomes.filter((o) => o.selfVerified).length / n;
  // per-task agent score, then mean: pass dominates; reward clean scope, no spiral, self-verify, efficiency
  const per = outcomes.map((o) => {
    const task = AGENTIC_TASKS.find((t) => t.id === o.id)!;
    const eff = Math.max(0, 1 - Math.max(0, o.turns - task.idealTurns) / (MAX_TURNS - task.idealTurns));
    return 0.55 * (o.pass ? 1 : 0)
      + 0.15 * (o.scopeViolations.length === 0 ? 1 : 0)
      + 0.1 * (o.spiraled ? 0 : 1)
      + 0.1 * (o.selfVerified ? 1 : 0)
      + 0.1 * eff;
  });
  return {
    model, outcomes, passRate, scopeViol, spirals, selfVerifyRate,
    avgTurns: outcomes.reduce((s, o) => s + o.turns, 0) / n,
    tokens: outcomes.reduce((s, o) => s + o.tokens, 0),
    ms: outcomes.reduce((s, o) => s + o.ms, 0),
    agentScore: per.reduce((a, b) => a + b, 0) / n,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────
function printReport(reports: ModelReport[]) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`AGENTIC BENCH — ${TOTAL_AGENTIC} tool-loop tasks, max ${MAX_TURNS} turns`);
  console.log('═'.repeat(78));
  const ranked = [...reports].sort((a, b) => b.agentScore - a.agentScore);

  console.log('\nLEADERBOARD (ranked by agent score)\n');
  console.log('model'.padEnd(20) + 'agent'.padStart(7) + 'pass'.padStart(7) + 'turns'.padStart(7) +
    'spiral'.padStart(7) + 'scope✗'.padStart(8) + 'self✓'.padStart(7) + 'tokens'.padStart(8));
  console.log('─'.repeat(71));
  for (const r of ranked) {
    console.log(
      r.model.padEnd(20) +
      r.agentScore.toFixed(2).padStart(7) +
      `${(100 * r.passRate).toFixed(0)}%`.padStart(7) +
      r.avgTurns.toFixed(1).padStart(7) +
      String(r.spirals).padStart(7) +
      String(r.scopeViol).padStart(8) +
      `${(100 * r.selfVerifyRate).toFixed(0)}%`.padStart(7) +
      String(r.tokens).padStart(8),
    );
  }
  console.log('\n  agent = .55·pass + .15·scope-clean + .1·no-spiral + .1·self-verify + .1·efficiency');
  console.log('  spiral = hit turn cap w/o finishing   scope✗ = files edited outside the goal   self✓ = ran tests');

  console.log('\nPER-TASK (✓ pass · ✗ fail · ~ spiral)\n');
  const head = 'task'.padEnd(20) + ranked.map((r) => r.model.slice(0, 11).padStart(12)).join('');
  console.log(head); console.log('─'.repeat(head.length));
  for (const task of AGENTIC_TASKS) {
    let row = task.id.padEnd(20);
    for (const r of ranked) {
      const o = r.outcomes.find((x) => x.id === task.id)!;
      const mark = o.pass ? `✓ ${o.turns}t` : (o.spiraled ? `~ ${o.turns}t` : `✗ ${o.turns}t`);
      row += mark.padStart(12);
    }
    console.log(row);
  }

  for (const r of ranked) {
    const notes = r.outcomes.filter((o) => !o.pass || o.scopeViolations.length);
    if (notes.length) {
      console.log(`\n• ${r.model}:`);
      for (const o of notes) {
        const sv = o.scopeViolations.length ? ` [scope: ${o.scopeViolations.join(',')}]` : '';
        console.log(`   ${o.id.padEnd(20)} ${o.pass ? 'pass' : o.detail}${sv}`);
      }
    }
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Ollama: ${OLLAMA_URL}\nModels: ${MODELS.join(', ')}\nMax turns: ${MAX_TURNS}`);
  let installed: string[] = [];
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as { models?: { name: string }[] };
    installed = (tags.models ?? []).map((m) => m.name);
  } catch (e) { console.error(`Cannot reach Ollama: ${(e as Error).message}`); process.exit(1); }

  const reports: ModelReport[] = [];
  for (const model of MODELS) {
    if (!installed.some((n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`))) {
      console.log(`\n• ${model} — NOT INSTALLED, skipping`); continue;
    }
    console.log(`\n• ${model} — ${TOTAL_AGENTIC} tasks…`);
    await unload(model);
    const outcomes: TaskOutcome[] = [];
    for (const task of AGENTIC_TASKS) {
      const o = await runTask(model, task);
      console.log(`   ${task.id.padEnd(20)} ${o.pass ? 'PASS' : (o.spiraled ? 'SPIRAL' : 'FAIL')}  ${o.turns}t  self:${o.selfVerified ? 'y' : 'n'}`);
      outcomes.push(o);
    }
    reports.push(score(model, outcomes));
    await unload(model);
  }
  printReport(reports);

  if (save) {
    if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `agentic-bench_${stamp}.json`);
    writeFileSync(out, JSON.stringify({ url: OLLAMA_URL, tasks: TOTAL_AGENTIC, maxTurns: MAX_TURNS, reports }, null, 2));
    console.log(`Saved → ${out}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
