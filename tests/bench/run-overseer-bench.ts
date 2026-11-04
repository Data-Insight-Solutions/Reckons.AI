/**
 * Run the overseer bench (F273 phase 0) through ONE harness for both models: headless Claude Code
 * (`claude -p`), read-only tools. Sonnet goes through the cloud login; gpt-oss:120b goes through
 * scripts/agent/local-claude.sh (the same binary, pointed at Ollama).
 *
 *   npx tsx tests/bench/run-overseer-bench.ts --model=sonnet|<ollama tag> [--ctx=131072] [--repeat=5]
 *                                              [--task=a-ci-triage] [--timeout-min=20]
 *
 * Appends one row per run to tests/bench/results/overseer-<run date>.jsonl: verdict, stop condition,
 * wall time, tokens, peak VRAM sampled during the run. A timeout is recorded as a row, not dropped.
 * --repeat runs the whole task list N times (round-robin, not N in a row), so a rate per task is not
 * skewed by a model's warm or cold state on one task. The 2026-10-28 gpt-oss rows used
 * --model=gpt-oss:120b --ctx=131072.
 * WEAKNESS: Claude Code loads the repo's AGENTS.md for both models, and the fixture sits inside a
 * repo whose git history holds the real answers; the prompt confines the model to the fixture, but
 * nothing enforces it beyond the read-only tool list.
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERSEER_TASKS, buildPrompt, scoreAnswer, parseRunArgs, launchCommand, resultsFile, modelLabel } from './overseer-tasks';

const { model, ctx, repeat, task: only, timeoutMin } = parseRunArgs(process.argv.slice(2));
const timeoutMs = timeoutMin * 60_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const started = new Date();
const OUT = resultsFile(started);

function vramMiB(): number {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
      .trim().split('\n').reduce((s, l) => s + Number(l), 0);
  } catch { return -1; }
}

async function run(taskId: string, runIndex: number) {
  const task = OVERSEER_TASKS.find((t) => t.id === taskId)!;
  const base = ['-p', buildPrompt(task), '--allowedTools', 'Read,Grep,Glob', '--output-format', 'json'];
  const [cmd, args] = launchCommand(model, ctx, base);
  const t0 = Date.now();
  let peak = vramMiB();
  const sampler = setInterval(() => { peak = Math.max(peak, vramMiB()); }, 5000);
  const env = { ...process.env }; delete env.CLAUDECODE; // nested-session guard; the child is read-only
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const code: number | null = await new Promise((r) => child.on('close', r));
  clearTimeout(timer); clearInterval(sampler);
  const wallS = Math.round((Date.now() - t0) / 1000);
  let result = '', usage: Record<string, number> = {}, turns = 0, cost = 0;
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    result = String(j.result ?? ''); usage = j.usage ?? {}; turns = j.num_turns ?? 0; cost = j.total_cost_usd ?? 0;
  } catch { result = out.slice(-500); }
  const score = timedOut ? { parsed: false, causeCorrect: false, stopRespected: null, correct: false } : scoreAnswer(task, result);
  const row = {
    date: started.toISOString().slice(0, 10), model: modelLabel(model, ctx), task: taskId, run: runIndex,
    timedOut, exit: code, wallS, turns,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0, costUsd: cost, peakVramMiB: peak, ...score,
    answerTail: result.slice(-300), stderrTail: err.slice(-200),
  };
  mkdirSync(resolve(OUT, '..'), { recursive: true });
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ ...row, answerTail: undefined }));
}

for (let i = 1; i <= repeat; i++) for (const t of OVERSEER_TASKS) if (!only || t.id === only) await run(t.id, i);
