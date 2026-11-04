#!/usr/bin/env npx tsx
/**
 * ORCHESTRATOR BENCH — how well each local model acts as an offline orchestrator.
 *
 * Tests the decisions a deputy makes: decomposing pending queue entries into sub-agent jobs,
 * writing TTL space statements for new schedules/entities, routing findings through the ladder
 * (script → agent-local → agent-subagent → opus), batch-triage of related items, and editing
 * entity properties in TTL graphs.
 *
 * Single-shot per task: model receives a prompt and produces structured output (JSON, Turtle, or
 * FINDING lines). The answer is PARSED, and each expectation is a predicate over the parse, 1 point
 * each — TTL must parse with N3, JSON must parse (see orchestration-scoring.ts). Per-expectation
 * pass rate reveals which models fail on which dimensions.
 *
 * Metrics: overall score, per-task pass rate, per-expectation pass rate, tokens, latency.
 *
 * SAFETY: runs against LOCAL Ollama models only. No network access, no file editing.
 *
 * Usage:
 *   npx tsx tests/bench/run-orchestrator-bench.ts
 *   npx tsx tests/bench/run-orchestrator-bench.ts --models qwen3.8,qwen3:32b,mistral-small3.2:24b
 *   npx tsx tests/bench/run-orchestrator-bench.ts --save
 *   npx tsx tests/bench/run-orchestrator-bench.ts --models qwen3.8 --tasks t2-write-schedule-ttl --save
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCHESTRATION_TASKS, TOTAL } from './orchestration-tasks.js';
import { scoreOutput, type ExpectationResult, type ScoredTask } from './orchestration-scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(__dirname, 'results');

const args = process.argv.slice(2);
const save = args.includes('--save');
const getArg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const NUM_CTX = parseInt(getArg('--ctx', '16384'), 10);
const TEMPERATURE = parseFloat(getArg('--temp', '0') as string);
const TASK_FILTER = getArg('--tasks', '').split(',').map((s) => s.trim()).filter(Boolean);
const TASKS = TASK_FILTER.length ? ORCHESTRATION_TASKS.filter((t) => TASK_FILTER.includes(t.id)) : ORCHESTRATION_TASKS;
const DEFAULT_MODELS = ['qwen3.6-160k', 'qwen3.8', 'qwen3:32b', 'mistral-small3.2:24b'];
const MODELS = getArg('--models', DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// ── Ollama chat (single-shot, no tools) ──────────────────────────────────────────

interface ChatResult { content: string; tokens: number; ms: number; }

async function chat(model: string, systemPrompt: string, userPrompt: string): Promise<ChatResult> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      keep_alive: '5m',
      options: { temperature: TEMPERATURE, num_ctx: NUM_CTX },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { message?: { content?: string }; eval_count?: number };
  return { content: j.message?.content ?? '', tokens: j.eval_count ?? 0, ms: Date.now() - t0 };
}

async function unload(model: string) {
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
    });
  } catch { /* best effort */ }
}

// ── Task scoring (parsing + per-expectation predicates live in orchestration-scoring.ts) ──

type TaskOutcome = ScoredTask & {
  taskId: string; taskLabel: string; tokens: number; ms: number; contentLength: number; content: string;
};

function scoreTask(task: typeof ORCHESTRATION_TASKS[number], result: ChatResult): TaskOutcome {
  return {
    ...scoreOutput(task, result.content),
    taskId: task.id,
    taskLabel: task.label,
    tokens: result.tokens,
    ms: result.ms,
    contentLength: result.content.length,
    content: result.content,
  };
}

// ── Report formatting ────────────────────────────────────────────────────────────

function printReport(modelResults: Map<string, TaskOutcome[]>) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`ORCHESTRATOR BENCH — ${TOTAL} expectations across ${ORCHESTRATION_TASKS.length} tasks`);
  console.log('═'.repeat(78));

  const ranked = Array.from(modelResults.entries())
    .map(([model, outcomes]) => {
      const totalExpectations = outcomes.reduce((s, o) => s + o.maxScore, 0);
      const totalPassed = outcomes.reduce((s, o) => s + o.score, 0);
      return { model, totalExpectations, totalPassed, outcomes };
    })
    .sort((a, b) => b.totalPassed / b.totalExpectations - a.totalPassed / a.totalExpectations);

  // Leaderboard
  console.log('\nLEADERBOARD (ranked by overall expectation score)\n');
  const hdr = 'model'.padEnd(22) + 'exp✓'.padStart(7) + '%'.padStart(6) + 'tasks'.padStart(7) +
    'tokens'.padStart(9) + 'ms'.padStart(8);
  console.log(hdr);
  console.log('─'.repeat(hdr.length));

  for (const r of ranked) {
    const pct = ((r.totalPassed / r.totalExpectations) * 100).toFixed(0);
    console.log(
      r.model.padEnd(22) +
      `${r.totalPassed}/${r.totalExpectations}`.padStart(7) +
      `${pct}%`.padStart(6) +
      `${r.outcomes.length}/${ORCHESTRATION_TASKS.length}`.padStart(7) +
      String(r.outcomes.reduce((s, o) => s + o.tokens, 0)).padStart(9) +
      `${Math.round(r.outcomes.reduce((s, o) => s + o.ms, 0))}`.padStart(8),
    );
  }

  // Per-task detail
  console.log('\nPER-TASK (expectation scores out of max)\n');
  const taskHead = 'task'.padEnd(24) + ranked.map((r) => r.model.slice(0, 16).padStart(18)).join('');
  console.log(taskHead);
  console.log('─'.repeat(taskHead.length));

  for (const task of TASKS) {
    let row = `${task.id} (${task.label.slice(0, 24)})`.padEnd(24);
    for (const r of ranked) {
      const o = r.outcomes.find((x) => x.taskId === task.id);
      if (o) {
        const scoreStr = `${o.score}/${o.maxScore}`;
        row += scoreStr.padStart(18);
      } else {
        row += 'N/A'.padStart(18);
      }
    }
    console.log(row);
  }

  // Failure detail
  for (const r of ranked) {
    const failures = r.outcomes.flatMap((o) =>
      o.expectations.filter((e) => !e.pass).map((e) => ({ ...e, taskLabel: o.taskLabel, model: r.model }))
    );
    if (failures.length > 0) {
      console.log(`\n• ${r.model} — failures (${failures.length}):`);
      const grouped = new Map<string, ExpectationResult[]>();
      for (const f of failures) {
        const group = f.taskLabel;
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group)!.push(f);
      }
      for (const [task, fails] of grouped) {
        console.log(`  [${task}]:`);
        for (const f of fails.slice(0, 3)) { // top 3 per task
          const n = `#${f.n}`.padStart(4);
          const detail = f.detail ? ` (${f.detail})` : '';
          console.log(`    ${n} ${f.text.slice(0, 75)}${detail}`);
        }
      }
    }

    // Structured output that could not be read at all
    const unreadable = r.outcomes.filter((o) => o.parseNote);
    if (unreadable.length > 0) {
      console.log(`\n  Unreadable output in ${unreadable.length} task(s):`);
      for (const o of unreadable) console.log(`    [${o.taskId}] ${o.parseNote}`);
    }
  }

  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log(`Context: ${NUM_CTX}, Temperature: ${TEMPERATURE}\n`);

  // Check installed models
  let installed: string[] = [];
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as { models?: { name: string }[] };
    installed = (tags.models ?? []).map((m) => m.name);
  } catch (e) {
    console.error(`Cannot reach Ollama: ${(e as Error).message}`);
    process.exit(1);
  }

  const allResults = new Map<string, TaskOutcome[]>();

  for (const model of MODELS) {
    // Check if model is installed (exact match or prefix match)
    const isInstalled = installed.some((n) => n === model || n.startsWith(`${model}:`));
    if (!isInstalled) {
      console.log(`\n⊘ ${model} — NOT INSTALLED, skipping`);
      continue;
    }

    console.log(`\n◇ ${model} — ${TASKS.length} tasks…`);
    await unload(model);

    const outcomes: TaskOutcome[] = [];
    for (const task of TASKS) {
      const result = await chat(model, 'You are an offline orchestrator for Reckons.AI. You decompose pending queue entries into sub-agent jobs, write TTL space statements, route findings through the tiering ladder, and triage batches of related items.', task.prompt);

      const outcome = scoreTask(task, result);
      const status = outcome.score === outcome.maxScore ? '✓' : `${outcome.score}/${outcome.maxScore}`;
      console.log(`  ${status.padEnd(6)} ${task.id.padEnd(28)} ${result.ms}ms ${outcome.tokens.toLocaleString()}tok`);

      if (outcome.score < outcome.maxScore) {
        const failTexts = outcome.expectations.filter((e) => !e.pass).map((e) => `#${e.n}:${e.text.slice(0, 50)}`).join('; ');
        console.log(`    ✗ ${failTexts}`);
      }

      outcomes.push(outcome);
    }

    allResults.set(model, outcomes);
    await unload(model);
  }

  printReport(allResults);

  if (save) {
    if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `orchestrator-bench_${stamp}.json`);
    const data = Array.from(allResults.entries()).map(([model, outcomes]) => ({
      model,
      tasks: outcomes.map((o) => ({
        id: o.taskId,
        label: o.taskLabel,
        score: `${o.score}/${o.maxScore}`,
        failed: o.expectations.filter((e) => !e.pass).map((e) => e.n),
        parseNote: o.parseNote,
        tokens: o.tokens,
        ms: o.ms,
        content: o.content,
      })),
    }));
    writeFileSync(out, JSON.stringify({ url: OLLAMA_URL, ctx: NUM_CTX, temp: TEMPERATURE, reports: data }, null, 2));
    console.log(`\nSaved → ${out}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
