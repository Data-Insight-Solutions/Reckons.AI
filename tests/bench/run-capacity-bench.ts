#!/usr/bin/env npx tsx
/**
 * CAPACITY BENCH — how many concurrent deputies/jobs can run on this machine.
 *
 * Measures:
 * 1. GPU VRAM ceiling (concurrent model loading)
 * 2. Throughput per job type (script / agent-reasoning / agent-extraction)
 * 3. Concurrent vs serial tradeoff
 * 4. Queue capacity projection (how long to drain the held schedules)
 *
 * Usage:
 *   npx tsx tests/bench/run-capacity-bench.ts
 *   npx tsx tests/bench/run-capacity-bench.ts --models qwen3.8,qwen3-coder,nuextract
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openByProducer, tallyWorkspace } from '../../scripts/offline/lib/proposal-tally.js';
import { DEFAULT_HOLD_UNREVIEWED } from '../../scripts/agent/session-schedule.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(__dirname, 'results');

const args = process.argv.slice(2);
const save = args.includes('--save');
const getArg = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const DEFAULT_MODELS = getArg('--models', 'qwen3.8,qwen3-coder,nuextract').split(',').map((s) => s.trim()).filter(Boolean);

// ── GPU VRAM detection ───────────────────────────────────────────────────────────

interface GpuInfo {
  model: string;
  vramMB: number;
  usedMB: number;
  freeMB: number;
}

function detectGPU(): GpuInfo[] {
  const gpus: GpuInfo[] = [];

  try {
    // nvidia-smi if available
    if (existsSync('/usr/bin/nvidia-smi')) {
      const out = execFileSync('/usr/bin/nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
      for (const line of out.trim().split('\n').filter(Boolean)) {
        const cols = line.split(',').map((c) => c.trim());
        if (cols.length >= 4) {
          gpus.push({ model: cols[1], vramMB: Number(cols[2]) * 1024, usedMB: Number(cols[3]) * 1024, freeMB: Number(cols[4]) * 1024 });
        }
      }
    }

    // Ollama GPU status if available (0.5.0+)
    const ollamaGpu = execFileSync('ollama', ['info'], { encoding: 'utf8' });
    // Parse GPU info from ollama info output
  } catch { /* No GPU detected or nvidia-smi unavailable */ }

  return gpus.length > 0 ? gpus : [{ model: 'unknown', vramMB: 0, usedMB: 0, freeMB: 0 }];
}

// ── System info ──────────────────────────────────────────────────────────────────

function getSystemInfo(): Record<string, string> {
  return {
    cpu: (() => { try { const m = readFileSync('/proc/cpuinfo', 'utf8'); const cores = (m.match(/processor/g) || []).length; const model = m.split('\n').find(l => l.startsWith('model name'))?.split(':')[1]?.trim(); return `${cores} cores, ${model}`; } catch { return 'unknown'; } })(),
    ram: (() => { try { const info = readFileSync('/proc/meminfo', 'utf8'); const totalKB = parseInt(info.match(/MemTotal:\s+(\d+)/)?.[1] || '0'); return `${Math.round(totalKB / 1024 / 1024)} GB`; } catch { return 'unknown'; } })(),
    os: process.platform === 'linux' ? (() => { try { return execFileSync('lsb_release', ['-rs'], { encoding: 'utf8' }).trim(); } catch { return 'linux'; } })() : process.platform,
    ollamaVersion: (() => { try { return execFileSync('ollama', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    gpu: detectGPU().map((g) => `${g.model}: ${Math.round(g.vramMB / 1024)} GB`).join(', ') || 'none',
  };
}

// ── Ollama helpers ────────────────────────────────────────────────────────────────

interface ChatResult { content: string; tokensIn: number; tokensOut: number; ms: number; error?: string }

async function chat(model: string, systemPrompt: string, userPrompt: string): Promise<ChatResult> {
  const t0 = Date.now();
  try {
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
        options: { temperature: 0, num_ctx: 16384 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      content: j.message?.content ?? '',
      tokensIn: j.prompt_eval_count ?? 0,
      tokensOut: j.eval_count ?? 0,
      ms: Date.now() - t0,
    };
  } catch (e) {
    const err = e as Error;
    return { content: '', tokensIn: 0, tokensOut: 0, ms: Date.now() - t0, error: err.message.slice(0, 120) };
  }
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

// ── VRAM ceiling test ────────────────────────────────────────────────────────────

async function measureVRAMCeiling(models: string[]): Promise<{ concurrent: number; perModel: Record<string, { loaded: boolean; vram?: number }> }> {
  const results = await detectModelVRAM(models);

  // Find maximum concurrent loading
  let maxConcurrent = 0;
  let loadedModels: string[] = [];

  for (const model of models) {
    try {
      await chat(model, 'respond with "loaded" in one word', 'Say loaded');
      loadedModels.push(model);
      maxConcurrent = Math.max(maxConcurrent, loadedModels.length);
    } catch { /* model failed to load */ }
  }

  // Unload all
  for (const model of [...loadedModels]) await unload(model);

  return { concurrent: maxConcurrent, perModel: results };
}

async function detectModelVRAM(models: string[]): Promise<Record<string, { loaded: boolean; vram?: number }>> {
  const nvidiaSmi = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']).toString().trim();
  const results: Record<string, { loaded: boolean; vram?: number }> = {};

  for (const model of models) {
    try {
      // Check if model is installed
      const tags = await (await fetch(`${OLLAMA_URL}/api/tags`)).json() as { models?: { name: string }[] };
      const installed = (tags.models ?? []).some((m) => m.name === model || m.name.startsWith(`${model}:`));

      if (!installed) {
        results[model] = { loaded: false };
        continue;
      }

      // Load and measure VRAM delta
      const before = parseInt(nvidiaSmi.split('\n').find(l => l.trim())?.trim() || '0', 10);

      await chat(model, 'Say one word', 'Hi');

      const after = parseInt(nvidiaSmi.split('\n').find(l => l.trim())?.trim() || '0', 10);
      const delta = after - before;

      results[model] = { loaded: true, vram: delta };
      await unload(model);
    } catch {
      results[model] = { loaded: false };
    }
  }

  return results;
}

// ── Throughput tests by job type ─────────────────────────────────────────────────

interface ThroughputResult {
  model: string;
  jobType: 'script' | 'reasoning' | 'extraction' | 'decomposition';
  msPerTask: number;
  tasksCompleted: number;
  tokensGenerated: number;
  errors: number;
}

// Simple prompt categories that map to real work types
const JOB_PROMPTS = {
  // Script tier — simple deterministic queries (no LLM reasoning needed in practice, but we measure the cost)
  script: [
    "List all TypeScript files in scripts/agent/ and count them by directory.",
    "Parse this JSONL queue and report how many entries have type=drift-warning vs type=suggestion: [{\"type\":\"drift-warning\"},{\"type\":\"suggestion\"},{\"type\":\"drift-warning\"}]",
    "Given these feature entities with labels, group them into phases: F80=mesh, F79=voice, F78=chat, F77=storage",
  ],
  // Reasoning tier — needs LLM analysis (orchestrator work)
  reasoning: [
    "A pending queue has 3 entries about schema drift. Should they be handled as a script or agent task? Explain.",
    "Given these 5 failing test categories, which ones can be fixed deterministically vs which need architectural review?",
    "Review this TTL block and identify any entities missing their kpred:description.",
  ],
  // Extraction tier — information extraction from structured data
  extraction: [
    "Extract all feature numbers (F##) and their status from this text and return as JSON array.",
    "Given these 8 code paths, identify which ones read user input without validation.",
    "Parse the pending queue below and extract each entry's subject, predicate, object, and type as a table.",
  ],
  // Decomposition tier — complex planning work (heaviest)
  decomposition: [
    "Decompose these 6 pending queue entries into sub-agent jobs. Assign tiers, models, urgency for each.",
    "Plan the batch triage for these findings: group by feature entity, suggest which to accept/reject/hold.",
    "Design a task file for describing entities in the roadmap — what parameters, schema, and concurrency?",
  ],
};

async function measureThroughput(model: string): Promise<ThroughputResult[]> {
  const results: ThroughputResult[] = [];

  for (const [jobType, prompts] of Object.entries(JOB_PROMPTS)) {
    let totalMs = 0;
    let completed = 0;
    let tokensGenerated = 0;
    let errors = 0;

    // Run 3 tasks per type and average
    for (const prompt of prompts) {
      const result = await chat(model, 'You are a maintenance assistant for Reckons.AI. Respond with clear structured output.', prompt);
      totalMs += result.ms;
      tokensGenerated += result.tokensOut;

      if (result.error || !result.content.trim()) {
        errors++;
      } else {
        completed++;
      }
    }

    const avgMs = completed > 0 ? Math.round(totalMs / completed) : 999999;
    results.push({ model, jobType: jobType as ThroughputResult['jobType'], msPerTask: avgMs, tasksCompleted: completed, tokensGenerated: tokensGenerated / (completed || 1), errors });
  }

  return results;
}

// ── Concurrent workload test ──────────────────────────────────────────────────────

async function measureConcurrentWorkload(models: string[]): Promise<{ serialMs: number; concurrentMs: number; speedup: number }> {
  const workItems = JOB_PROMPTS.reasoning.map((prompt) => ({ model: models[0], prompt }));

  // Serial timing
  console.log('  Measuring serial baseline...');
  let serialTotal = 0;
  for (const item of workItems) {
    const result = await chat(item.model, 'You are a maintenance assistant.', item.prompt);
    serialTotal += result.ms;
  }

  // Unload between serial and concurrent tests
  for (const model of models) await unload(model);

  // Concurrent timing
  console.log('  Measuring concurrent workload...');
  const concurrentStart = Date.now();
  const promises = workItems.map((item) => chat(item.model, 'You are a maintenance assistant.', item.prompt));
  const results = await Promise.all(promises);
  const concurrentMs = Date.now() - concurrentStart;

  return {
    serialMs: serialTotal,
    concurrentMs,
    speedup: serialTotal > 0 ? +(serialTotal / concurrentMs).toFixed(2) : 1,
  };
}

// ── Queue drain projection ───────────────────────────────────────────────────────

interface HeldSchedule { name: string; pending: number; avgMsPerTask?: number }

/**
 * Producers at or over the back-pressure limit, counted the way queue-worker counts them
 * (proposal-tally.ts), so this projection drains the same backlog the holds see.
 */
function readPendingQueue(): HeldSchedule[] {
  const root = resolve(__dirname, '..', '..');
  const open = openByProducer(tallyWorkspace(root).tallies);
  return [...open.entries()]
    .filter(([, n]) => n >= DEFAULT_HOLD_UNREVIEWED)
    .sort((a, b) => b[1] - a[1])
    .map(([name, pending]) => ({ name, pending }));
}

function projectQueueDrain(queue: HeldSchedule[], msPerTask: number): Record<string, { tasksRemaining: number; estimatedMinutes: number; completedBy: string }> {
  const projections: ReturnType<typeof projectQueueDrain> = {};
  for (const s of queue) {
    const totalMs = s.pending * msPerTask;
    projections[s.name] = {
      tasksRemaining: s.pending,
      estimatedMinutes: Math.round(totalMs / 60000),
      completedBy: new Date(Date.now() + totalMs).toISOString().slice(0, 16).replace('T', ' '),
    };
  }
  return projections;
}

// ── Report formatting ─────────────────────────────────────────────────────────────

function printReport(systemInfo: Record<string, string>, vramResults: Awaited<ReturnType<typeof measureVRAMCeiling>>, throughput: ThroughputResult[], concurrent: { serialMs: number; concurrentMs: number; speedup: number }, queueProjections: ReturnType<typeof projectQueueDrain>) {
  console.log('\n' + '═'.repeat(78));
  console.log('CAPACITY BENCH — Local Deputy Hardware & Workload Analysis');
  console.log('═'.repeat(78));

  // System info
  console.log('\nSYSTEM INFO:');
  for (const [k, v] of Object.entries(systemInfo)) {
    console.log(`  ${k}: ${v}`);
  }

  // VRAM ceiling
  console.log('\nGPU VRAM CEILING:');
  console.log(`  Max concurrent models: ${vramResults.concurrent} of ${Object.keys(vramResults.perModel).length}`);
  for (const [model, info] of Object.entries(vramResults.perModel)) {
    const vramStr = info.vram != null ? `${Math.round(info.vram / 1024)} GB` : 'N/A';
    console.log(`  ${model}: ${info.loaded ? 'loaded' : 'not-installed'} — ~${vramStr} VRAM`);
  }

  // Throughput table
  console.log('\nTHROUGHPUT BY JOB TYPE (ms per task):');
  const hdr = 'model'.padEnd(20) + 'script'.padStart(10) + 'reasoning'.padStart(14) + 'extraction'.padStart(12) + 'decomposition'.padStart(16);
  console.log(hdr);
  console.log('─'.repeat(hdr.length));

  for (const result of throughput) {
    const row = result.model.padEnd(20);
    const typeRow = throughput.find((t) => t.model === result.model && t.jobType === 'script')?.msPerTask ?? 99999;
    const reasonRow = throughput.find((t) => t.model === result.model && t.jobType === 'reasoning')?.msPerTask ?? 99999;
    const extractRow = throughput.find((t) => t.model === result.model && t.jobType === 'extraction')?.msPerTask ?? 99999;
    const decompRow = throughput.find((t) => t.model === result.model && t.jobType === 'decomposition')?.msPerTask ?? 99999;

    console.log(`${row}${String(typeRow).padStart(10)}${String(reasonRow).padStart(14)}${String(extractRow).padStart(12)}${String(decompRow).padStart(16)}`);
    if (result.errors > 0) {
      console.log(`    ⚠ ${result.model} had ${result.errors}/3 errors in this task type`);
    }
  }

  // Concurrent vs serial
  console.log('\nCONCURRENT VS SERIAL:');
  console.log(`  Serial baseline: ${Math.round(concurrent.serialMs / 1000)}s for ${JOB_PROMPTS.reasoning.length} tasks`);
  console.log(`  Concurrent peak: ${Math.round(concurrent.concurrentMs / 1000)}s for same work`);
  console.log(`  Speedup factor: ${concurrent.speedup}x`);

  // Queue drain projection
  console.log('\nQUEUE DRAIN PROJECTIONS (per task, single deputy):');
  const hdr2 = 'schedule'.padEnd(18) + 'pending'.padStart(9) + 'est. minutes'.padStart(14) + 'completed by'.padStart(20);
  console.log(hdr2);
  console.log('─'.repeat(hdr2.length));

  for (const [name, proj] of Object.entries(queueProjections)) {
    console.log(`${name.padEnd(18)}${String(proj.tasksRemaining).padStart(9)}${String(proj.estimatedMinutes).padStart(14)}${proj.completedBy.slice(0, 16).padEnd(20)}`);
  }

  // Capacity recommendation
  const avgReasoning = throughput.find((t) => t.model === 'qwen3.8')?.msPerTask ?? 99999;
  console.log('\nRECOMMENDATION:');
  console.log(`  Single deputy (qwen3.8): ~${Math.round(avgReasoning / 1000)}s/task for reasoning work`);

  if (vramResults.concurrent > 1) {
    const concurrentRate = avgReasoning / concurrent.speedup;
    console.log(`  With concurrent deputies: ~${Math.round(concurrentRate / 1000)}s/task (estimated with ${concurrent.speedup}x speedup)`);
    console.log(`  Estimated full queue drain: ${Object.values(queueProjections).reduce((s, p) => s + p.estimatedMinutes, 0)} minutes single deputy`);
  }

  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  const systemInfo = getSystemInfo();

  // Check Ollama connection
  let installed: string[] = [];
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as { models?: { name: string }[] };
    installed = (tags.models ?? []).map((m) => m.name);
    console.log(`Ollama: ${OLLAMA_URL} (${systemInfo.ollamaVersion})`);
    console.log(`Installed: ${installed.slice(0, 8).join(', ')}${installed.length > 8 ? ` (+${installed.length - 8} more)` : ''}`);
  } catch (e) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}: ${(e as Error).message}`);
    process.exit(1);
  }

  const models = DEFAULT_MODELS.filter((m) => installed.some((n) => n === m || n.startsWith(`${m}:`)));
  if (models.length === 0) {
    console.error('None of the requested models are installed. Use --models to specify available models.');
    process.exit(1);
  }

  // Run benchmarks
  console.log('\n🔍 Measuring GPU VRAM ceiling...\n');
  const vramResults = await measureVRAMCeiling(models);

  console.log('\n⏱ Measuring throughput by job type...\n');
  const allThroughput: ThroughputResult[] = [];
  for (const model of models) {
    const results = await measureThroughput(model);
    allThroughput.push(...results);
  }

  console.log('\n🔄 Measuring concurrent vs serial tradeoff...\n');
  const concurrent = await measureConcurrentWorkload(models.slice(0, Math.min(2, models.length)));

  const queueProjections = projectQueueDrain(readPendingQueue(), allThroughput.find((t) => t.model === 'qwen3.8' && t.jobType === 'reasoning')?.msPerTask ?? 99999);

  // Print report
  printReport(systemInfo, vramResults, allThroughput, concurrent, queueProjections);

  if (save) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(RESULTS, `capacity-bench_${stamp}.json`);
    writeFileSync(out, JSON.stringify({ systemInfo, vram: vramResults, throughput: allThroughput, concurrent, queueProjections }, null, 2));
    console.log(`\nSaved → ${out}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
