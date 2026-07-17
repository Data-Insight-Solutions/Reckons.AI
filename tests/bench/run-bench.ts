#!/usr/bin/env npx tsx
/**
 * WASM LLM Bench Runner
 *
 * Runs WASM models against a fixture document and scores extraction + chat
 * quality against pre-computed golden (Claude Opus) outputs.
 *
 * Usage:
 *   npx tsx tests/bench/run-bench.ts                    # run all default models
 *   npx tsx tests/bench/run-bench.ts --model org/model   # run a single model
 *   npx tsx tests/bench/run-bench.ts --model a --model b # run specific models
 *   npx tsx tests/bench/run-bench.ts --save              # persist results as JSON
 *   npx tsx tests/bench/run-bench.ts --list              # show available models
 *
 * The golden outputs are generated once (fixtures/golden/) and reused across
 * all model runs. No API calls are made during benchmarking.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, parseTriplesJSON } from '../../src/lib/integrations/llm/extractor';
import { ETHICS_PREAMBLE } from '../../src/lib/safety/content-policy';
import { buildReport, formatReport } from './scoring';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor';
import type { ChatTestCase, BenchReport } from './scoring';

// Load .env for API keys (enables cloud provider comparison)
const envPath = resolve(import.meta.dirname || __dirname, '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// ── Default model catalogue ──────────────────────────────────────────────────
// These match the WASM_MODELS list in settings + a few extras worth testing.
// To test a new HuggingFace model, just pass --model org/model-name.

// sizeMB = approximate q4 ONNX download size (the number that matters for a memory-constrained
// device — see device-capability.ts / F36 iOS policy). Verified against HF content-length.
const CATALOGUE: Record<string, { label: string; note: string; sizeMB: number }> = {
  // ── SmolLM2 family ──
  'HuggingFaceTB/SmolLM2-135M-Instruct':          { label: 'SmolLM2-135M',    note: 'ultra-light · iOS candidate', sizeMB: 180 },
  'HuggingFaceTB/SmolLM2-360M-Instruct':          { label: 'SmolLM2-360M',    note: 'light',                       sizeMB: 370 },
  'HuggingFaceTB/SmolLM2-1.7B-Instruct':          { label: 'SmolLM2-1.7B',    note: 'largest SmolLM',              sizeMB: 1700 },
  // ── Qwen family ──
  'onnx-community/Qwen2.5-0.5B-Instruct':         { label: 'Qwen2.5-0.5B',    note: 'multilingual · desktop default', sizeMB: 500 },
  'onnx-community/Qwen2.5-Coder-0.5B-Instruct':   { label: 'Qwen2.5-Coder',   note: 'code-focused',                sizeMB: 500 },
  'onnx-community/Qwen2.5-1.5B-Instruct':         { label: 'Qwen2.5-1.5B',    note: 'best ingest so far',          sizeMB: 1500 },
  // ── Other families ──
  'onnx-community/Llama-3.2-1B-Instruct':         { label: 'Llama-3.2-1B',    note: 'Meta small',                  sizeMB: 1000 },
};

/** Approx download size (MB) for a model — known catalogue value, else 0 (unknown). */
function modelSizeMB(modelId: string): number {
  return CATALOGUE[modelId]?.sizeMB ?? 0;
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');
const queryHF = args.includes('--hf');

if (args.includes('--list')) {
  console.log('\nAvailable models:');
  for (const [id, m] of Object.entries(CATALOGUE)) {
    console.log(`  ${m.label.padEnd(16)} ${id.padEnd(48)} ${m.note}`);
  }
  console.log('\nPass --model <id> to run a specific model, or any HuggingFace model ID.');
  console.log('Pass --hf to query HuggingFace for top text-generation models.');
  process.exit(0);
}

function parseModels(): string[] {
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      models.push(args[++i]);
    }
  }
  // Default: run all catalogue models
  return models.length > 0 ? models : Object.keys(CATALOGUE);
}

async function queryHFModels(): Promise<string[]> {
  if (!queryHF) return [];
  console.log('\nQuerying HuggingFace for top text-generation ONNX models...');
  try {
    const params = new URLSearchParams({
      pipeline_tag: 'text-generation',
      sort: 'downloads',
      direction: '-1',
      limit: '30',
    });
    const res = await fetch(`https://huggingface.co/api/models?${params}`);
    if (!res.ok) throw new Error(`HF API ${res.status}`);
    const models: Array<{ modelId: string; tags: string[]; downloads: number; library_name?: string }> = await res.json();
    // Filter for ONNX-compatible small models
    const onnxModels = models.filter(m => {
      const tags = m.tags ?? [];
      return (tags.includes('onnx') || tags.includes('transformers.js') || m.library_name === 'onnx')
        && !CATALOGUE[m.modelId]; // skip already-catalogued
    });
    console.log(`  Found ${onnxModels.length} additional ONNX text-generation models`);
    for (const m of onnxModels.slice(0, 5)) {
      console.log(`    ${m.modelId} (${m.downloads.toLocaleString()} downloads)`);
    }
    return onnxModels.slice(0, 3).map(m => m.modelId);
  } catch (e) {
    console.warn(`  HF query failed: ${(e as Error).message}`);
    return [];
  }
}

const modelsToRun = parseModels();

// ── Paths & fixtures (loaded once) ───────────────────────────────────────────

const BENCH_DIR = import.meta.dirname || __dirname;
const FIXTURES_DIR = join(BENCH_DIR, 'fixtures');
const RESULTS_DIR = join(BENCH_DIR, 'results');

const sourceText = readFileSync(join(FIXTURES_DIR, 'octopus.txt'), 'utf-8');
const goldenIngest: ExtractedTriple[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'golden', 'octopus-ingest.json'), 'utf-8')
);
const chatTestCases: ChatTestCase[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'golden', 'octopus-chat.json'), 'utf-8')
);

// ── Chat system prompt (mirrors turtle-chat.ts) ──────────────────────────────

function buildChatSystem(triples: ExtractedTriple[]): string {
  const entityLines = triples.slice(0, 15).map(t =>
    `  - ${t.subject} · ${t.predicate} -> ${t.object}`
  ).join('\n');

  return ETHICS_PREAMBLE + `You are Shelly, a friendly low-poly turtle companion for Reckons.AI — a personal knowledge base tool built on RDF Turtle format (.ttl).

Your personality: warm, curious, occasionally uses turtle puns, never condescending. Keep responses concise (2-4 sentences for simple questions, up to ~100 words for complex ones). Never repeat yourself or pad with filler.

GROUNDING RULES (critical — follow these strictly):
- ONLY state facts that appear in the KB SNAPSHOT below. If something isn't in the snapshot, say so — never invent or assume facts.
- When describing an entity, cite the specific triples you see: e.g. "According to your KB, Matt works-at -> Anthropic."
- If a user asks about something not in the KB, say "I don't see that in your KB yet" and offer to add it.
- Never make claims about the KB's purpose, history, or significance beyond what the triples show.
- Do not embellish, editorialize, or add superlatives. Describe what the data says, nothing more.

---
KB SNAPSHOT — THIS IS YOUR ONLY SOURCE OF TRUTH. Only reference facts shown here.
Triples (subject · predicate -> object):
${entityLines}`;
}

// ── Model lifecycle ──────────────────────────────────────────────────────────

let generator: any = null;
let currentModel: string | null = null;

async function loadModel(modelId: string): Promise<void> {
  // Lazy-import so the script starts fast and shows --list/--help instantly
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(process.env.HOME || '.', '.cache', 'huggingface');

  if (currentModel === modelId && generator) return; // already loaded

  // Release previous model
  if (generator?.dispose) {
    try { await generator.dispose(); } catch { /* ignore */ }
  }
  generator = null;
  currentModel = null;

  console.log(`  Loading ${modelId} ...`);
  const start = Date.now();
  generator = await pipeline('text-generation', modelId, {
    dtype: 'q4' as any,
    device: 'cpu',
  });
  currentModel = modelId;
  console.log(`  Loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function generate(systemPrompt: string, userPrompt: string, maxTokens = 1024): Promise<string> {
  if (!generator) throw new Error('Model not loaded');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const result = await (generator as any)(messages, {
    max_new_tokens: maxTokens,
    temperature: 0.1,
    do_sample: true,
  });

  const generated = Array.isArray(result) ? result[0] : result;
  if (generated?.generated_text) {
    const texts = Array.isArray(generated.generated_text)
      ? generated.generated_text
      : [generated.generated_text];
    const last = texts[texts.length - 1];
    if (typeof last === 'object' && last.role === 'assistant') return last.content;
    if (typeof last === 'string') return last;
  }
  return String(generated);
}

// ── Bench steps ──────────────────────────────────────────────────────────────

async function benchIngest(modelId: string): Promise<ExtractedTriple[]> {
  console.log('  Ingest: extracting triples …');
  const start = Date.now();

  const raw = await generate(
    EXTRACTION_SYSTEM_PROMPT,
    buildExtractionUserPrompt(sourceText, 'Common Octopus — Wikipedia'),
    2048
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Ingest: generated in ${elapsed}s (${raw.length} chars)`);

  let triples: ExtractedTriple[];
  try {
    triples = parseTriplesJSON(raw);
    console.log(`  Ingest: parsed ${triples.length} triples`);
  } catch (e) {
    console.error(`  Ingest: PARSE FAILED — ${(e as Error).message}`);
    console.error(`  Raw (first 300 chars): ${raw.slice(0, 300)}`);
    triples = [];
  }

  return triples;
}

async function benchChat(kbTriples: ExtractedTriple[]): Promise<string[]> {
  // Always use golden triples for chat context so chat scoring is independent
  // of ingest quality (we want to measure chat ability in isolation too).
  const system = buildChatSystem(goldenIngest);
  const responses: string[] = [];

  for (const tc of chatTestCases) {
    const start = Date.now();
    const response = await generate(system, tc.question, 256);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const wordCount = response.split(/\s+/).filter(Boolean).length;
    console.log(`  Chat (${elapsed}s, ${wordCount}w): "${tc.question}" → ${response.slice(0, 80).replace(/\n/g, ' ')}…`);
    responses.push(response);
  }

  return responses;
}

// ── Run one model ────────────────────────────────────────────────────────────

async function runModel(modelId: string): Promise<BenchReport | null> {
  const label = CATALOGUE[modelId]?.label ?? modelId.split('/').pop() ?? modelId;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  MODEL: ${label} (${modelId})`);
  console.log(`${'─'.repeat(60)}`);

  try {
    await loadModel(modelId);
  } catch (e) {
    console.error(`  SKIP: failed to load — ${(e as Error).message}`);
    return null;
  }

  try {
    const ingestOutput = await benchIngest(modelId);
    const chatResponses = await benchChat(ingestOutput);
    const report = buildReport(modelId, ingestOutput, goldenIngest, chatResponses, chatTestCases);
    console.log(formatReport(report));
    return report;
  } catch (e) {
    console.error(`  FAILED: ${(e as Error).message}`);
    return null;
  }
}

// ── Comparison table ─────────────────────────────────────────────────────────

function printComparison(reports: BenchReport[]): void {
  if (reports.length < 2) return;

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  COMPARISON TABLE');
  console.log(`${'═'.repeat(72)}`);

  const header = [
    'Model'.padEnd(16),
    'Size'.padStart(7),
    'Ingest F1'.padStart(9),
    'Chat'.padStart(7),
    'Combined'.padStart(9),
    'Score/100MB'.padStart(11),
  ].join(' │ ');

  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  // Sort by EFFICIENCY (combined score per 100 MB) — the "performance vs size" ranking Matt asked
  // for: the model that buys the most quality per megabyte a constrained device has to load.
  const eff = (r: BenchReport) => {
    const mb = modelSizeMB(r.model);
    return mb > 0 ? r.combined / (mb / 100) : 0;
  };
  const sorted = [...reports].sort((a, b) => eff(b) - eff(a));
  for (const r of sorted) {
    const label = (CATALOGUE[r.model]?.label ?? r.model.split('/').pop() ?? r.model).slice(0, 16);
    const mb = modelSizeMB(r.model);
    const row = [
      label.padEnd(16),
      (mb ? `${mb}MB` : '?').padStart(7),
      pct(r.ingest.f1).padStart(9),
      pct(r.chatOverall).padStart(7),
      pct(r.combined).padStart(9),
      (mb ? eff(r).toFixed(3) : '?').padStart(11),
    ].join(' │ ');
    console.log(`  ${row}`);
  }

  console.log(`${'═'.repeat(72)}`);
  console.log('  Sorted by efficiency (combined score per 100 MB). Ingest F1 = extraction quality;');
  console.log('  a tiny model with F1≈0 cannot extract — it is chat-only. See F36 iOS policy.');
  console.log(`${'═'.repeat(72)}\n`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔${'═'.repeat(58)}╗`);
  console.log(`║  WASM LLM BENCH — Reckons.AI                              ║`);
  console.log(`╚${'═'.repeat(58)}╝`);
  console.log(`Fixture: octopus.txt (${sourceText.length} chars)`);
  console.log(`Golden: ${goldenIngest.length} ingest triples, ${chatTestCases.length} chat questions`);
  // Query HF for additional models if requested
  const hfModels = await queryHFModels();
  const allModels = [...modelsToRun, ...hfModels];

  console.log(`Models: ${allModels.length} (${allModels.map(m => CATALOGUE[m]?.label ?? m.split('/').pop()).join(', ')})`);

  const reports: BenchReport[] = [];

  for (const modelId of allModels) {
    const report = await runModel(modelId);
    if (report) reports.push(report);
  }

  printComparison(reports);

  if (saveResults && reports.length > 0) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    // Save individual reports
    for (const r of reports) {
      const slug = r.model.replace(/\//g, '_');
      const filename = `${slug}_${ts}.json`;
      writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(r, null, 2));
    }

    // Save comparison summary
    const summary = {
      timestamp: new Date().toISOString(),
      fixture: 'octopus.txt',
      goldenTripleCount: goldenIngest.length,
      chatQuestionCount: chatTestCases.length,
      results: reports.map(r => ({
        model: r.model,
        label: CATALOGUE[r.model]?.label ?? r.model.split('/').pop(),
        ingestF1: r.ingest.f1,
        chatOverall: r.chatOverall,
        combined: r.combined,
      })),
    };
    writeFileSync(join(RESULTS_DIR, `comparison_${ts}.json`), JSON.stringify(summary, null, 2));
    console.log(`Results saved to tests/bench/results/`);
  }
}

main().catch(e => {
  console.error('Bench failed:', e);
  process.exit(1);
});
