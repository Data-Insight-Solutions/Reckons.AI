#!/usr/bin/env npx tsx
/**
 * Extraction Prompt Matrix Bench
 *
 * Cross product of models × prompt variants × decoding mode, scored against
 * the same golden fixture and scorer as the rest of tests/bench (octopus.txt
 * / octopus-ingest.json / scoreIngest). Gives visibility into which prompt
 * variant works best for which model, so prompting can be tuned per model
 * instead of one-size-fits-all.
 *
 * Axes:
 *   - models: Ollama (llama3.2:3b, qwen3:4b by default; more behind --models)
 *             + Claude (claude-haiku-4-5-20251001) when an API key is present
 *   - prompts: full, compact, few-shot-3, schema-first, checklist (see
 *              extraction-prompts.ts)
 *   - mode: Ollama runs both 'structured' (schema-constrained /api/chat) and
 *           'plain' (OpenAI-compatible /v1/chat/completions); Claude runs
 *           'plain' only — it follows JSON contracts without constrained
 *           decoding, so a second mode would just be duplicate cost.
 *
 * Usage:
 *   npx tsx tests/bench/run-extraction-matrix.ts
 *   npx tsx tests/bench/run-extraction-matrix.ts --models devstral-small-2,gemma3:27b,mistral-nemo,gpt-oss:20b
 *   npx tsx tests/bench/run-extraction-matrix.ts --url http://host:11434
 *   npx tsx tests/bench/run-extraction-matrix.ts --skip-claude
 *   npx tsx tests/bench/run-extraction-matrix.ts --timeout-ms 600000
 *
 * npm script: bench:matrix
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  buildExtractionUserPrompt,
  buildExtractedTripleSchema,
  parseTriplesJSON,
  type ExtractedTriple
} from '../../src/lib/integrations/llm/extractor';
import { PROMPT_VARIANT_IDS, getPromptVariant, type PromptVariantId } from './extraction-prompts';
import { scoreIngest, type IngestScore } from './scoring';
import {
  buildColumns,
  renderConsoleTable,
  renderMarkdownTable,
  type CellResult,
  type Mode,
  type ModelKind
} from './matrix-table';

// ── .env loading (same approach as run-bench.ts) ────────────────────────────

const envPath = resolve(import.meta.dirname || __dirname, '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const TIMEOUT_MS = parseInt(getArg('--timeout-ms', '300000'), 10);
const SKIP_CLAUDE = args.includes('--skip-claude');
const CLAUDE_MODEL = getArg('--claude-model', 'claude-haiku-4-5-20251001');

const DEFAULT_OLLAMA_MODELS = ['llama3.2:3b', 'qwen3:4b'];

function parseExtraModels(): string[] {
  const idx = args.indexOf('--models');
  if (idx < 0 || !args[idx + 1]) return [];
  return args[idx + 1].split(',').map((s) => s.trim()).filter(Boolean);
}

const OLLAMA_MODELS = [...DEFAULT_OLLAMA_MODELS, ...parseExtraModels()];

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || '';
const CLAUDE_ENABLED = !SKIP_CLAUDE && !!ANTHROPIC_API_KEY;

// ── Fixtures (same as the rest of tests/bench — comparability matters) ──────

const BENCH_DIR = import.meta.dirname || __dirname;
const FIXTURES_DIR = join(BENCH_DIR, 'fixtures');
const RESULTS_DIR = join(BENCH_DIR, 'results');

const sourceText = readFileSync(join(FIXTURES_DIR, 'octopus.txt'), 'utf-8');
const SOURCE_TITLE = 'Common Octopus — Wikipedia';
const goldenIngest: ExtractedTriple[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'golden', 'octopus-ingest.json'), 'utf-8')
);

// ── Modes ────────────────────────────────────────────────────────────────────

const OLLAMA_MODES: Mode[] = ['structured', 'plain'];
const CLAUDE_MODES: Mode[] = ['plain'];

// ── Network calls (local to this bench, mirroring the pattern in
//    run-ollama-bench.ts: direct fetch with matrix-specific decoding params
//    — temperature 0 for determinism — rather than reusing the app's
//    providers.ts helpers, which don't expose temperature control) ─────────

async function callOllamaPlain(system: string, user: string, model: string, maxTokens = 2048): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callOllamaStructured(system: string, user: string, model: string, maxTokens = 2048): Promise<string> {
  const schema = buildExtractedTripleSchema();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false, // hybrid-thinking models (qwen3, gpt-oss) burn the whole budget on <think> otherwise
      format: schema,
      options: { num_predict: maxTokens, temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}

async function callClaude(system: string, user: string, model: string, maxTokens = 2048): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${(ms / 1000).toFixed(0)}s timeout`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── Cell results (shape + rendering live in matrix-table.ts) ────────────────

const results: CellResult[] = [];

// ── Run one cell ─────────────────────────────────────────────────────────────

async function runCell(
  modelKind: ModelKind,
  model: string,
  promptId: PromptVariantId,
  mode: Mode
): Promise<void> {
  const variant = getPromptVariant(promptId);
  const userPrompt = buildExtractionUserPrompt(sourceText, SOURCE_TITLE);
  const label = `${model} | ${promptId} | ${mode}`;
  console.log(`\n▸ ${label}`);

  const start = Date.now();
  let raw = '';
  try {
    if (modelKind === 'claude') {
      raw = await withTimeout(callClaude(variant.systemPrompt, userPrompt, model), TIMEOUT_MS, label);
    } else if (mode === 'structured') {
      raw = await withTimeout(callOllamaStructured(variant.systemPrompt, userPrompt, model), TIMEOUT_MS, label);
    } else {
      raw = await withTimeout(callOllamaPlain(variant.systemPrompt, userPrompt, model), TIMEOUT_MS, label);
    }
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ERROR: ${msg}`);
    results.push({
      model, modelKind, promptId, promptLabel: variant.label, mode,
      status: 'error', latencyMs, outputTripleCount: 0,
      precision: 0, recall: 0, f1: 0, matchedCount: 0, goldenCount: goldenIngest.length,
      note: msg.slice(0, 300)
    });
    return;
  }
  const latencyMs = Date.now() - start;

  let triples: ExtractedTriple[];
  try {
    triples = parseTriplesJSON(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  PARSE FAILURE: ${msg}`);
    results.push({
      model, modelKind, promptId, promptLabel: variant.label, mode,
      status: 'parse-failure', latencyMs, outputTripleCount: 0,
      precision: 0, recall: 0, f1: 0, matchedCount: 0, goldenCount: goldenIngest.length,
      note: `${msg.slice(0, 200)} | raw(first 200): ${raw.slice(0, 200).replace(/\n/g, ' ')}`
    });
    return;
  }

  const score: IngestScore = scoreIngest(triples, goldenIngest);
  console.log(
    `  ${triples.length} triples · P ${(score.precision * 100).toFixed(1)}% · R ${(score.recall * 100).toFixed(1)}% · F1 ${(score.f1 * 100).toFixed(1)}% · ${(latencyMs / 1000).toFixed(1)}s`
  );
  results.push({
    model, modelKind, promptId, promptLabel: variant.label, mode,
    status: 'ok', latencyMs, outputTripleCount: triples.length,
    precision: score.precision, recall: score.recall, f1: score.f1,
    matchedCount: score.matchedCount, goldenCount: score.goldenCount
  });
}

function recordSkipped(modelKind: ModelKind, model: string, promptId: PromptVariantId, mode: Mode, note: string): void {
  const variant = getPromptVariant(promptId);
  results.push({
    model, modelKind, promptId, promptLabel: variant.label, mode,
    status: 'skipped', latencyMs: 0, outputTripleCount: 0,
    precision: 0, recall: 0, f1: 0, matchedCount: 0, goldenCount: goldenIngest.length,
    note
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const COLUMNS = buildColumns(PROMPT_VARIANT_IDS);

async function main() {
  console.log(`\n╔${'═'.repeat(70)}╗`);
  console.log('║  EXTRACTION PROMPT MATRIX BENCH — Reckons.AI                       ║');
  console.log(`╚${'═'.repeat(70)}╝`);
  console.log(`Ollama server: ${OLLAMA_URL}`);
  console.log(`Ollama models: ${OLLAMA_MODELS.join(', ')}`);
  console.log(`Prompt variants: ${PROMPT_VARIANT_IDS.join(', ')}`);
  console.log(`Fixture: octopus.txt (${sourceText.length} chars), golden: ${goldenIngest.length} triples`);
  console.log(`Claude: ${CLAUDE_ENABLED ? `enabled (${CLAUDE_MODEL})` : SKIP_CLAUDE ? 'skipped (--skip-claude)' : 'skipped (no ANTHROPIC_API_KEY / VITE_ANTHROPIC_API_KEY found in env or .env)'}`);
  console.log(`Per-cell timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s`);

  const rowModels: string[] = [];

  for (const model of OLLAMA_MODELS) {
    rowModels.push(model);
    for (const promptId of PROMPT_VARIANT_IDS) {
      for (const mode of OLLAMA_MODES) {
        await runCell('ollama', model, promptId, mode);
      }
    }
  }

  if (CLAUDE_ENABLED) {
    rowModels.push(CLAUDE_MODEL);
    for (const promptId of PROMPT_VARIANT_IDS) {
      await runCell('claude', CLAUDE_MODEL, promptId, 'plain');
      // structured mode is N/A for Claude — record as skipped so the table
      // renders a clear 'skip' rather than a misleading blank.
      recordSkipped('claude', CLAUDE_MODEL, promptId, 'structured', 'Claude has no schema-constrained decoding mode; runs plain only.');
    }
  } else {
    rowModels.push(CLAUDE_MODEL);
    for (const promptId of PROMPT_VARIANT_IDS) {
      for (const mode of CLAUDE_MODES) {
        recordSkipped('claude', CLAUDE_MODEL, promptId, mode, SKIP_CLAUDE ? 'Skipped via --skip-claude.' : 'No ANTHROPIC_API_KEY / VITE_ANTHROPIC_API_KEY found in env or .env — Claude cells skipped.');
      }
      recordSkipped('claude', CLAUDE_MODEL, promptId, 'structured', 'Claude has no schema-constrained decoding mode; runs plain only.');
    }
  }

  const consoleTable = renderConsoleTable(results, rowModels, COLUMNS);
  console.log(consoleTable);

  const markdown = renderMarkdownTable(results, rowModels, COLUMNS);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const jsonPath = join(RESULTS_DIR, `matrix_${ts}.json`);
  const mdPath = join(RESULTS_DIR, `matrix_${ts}.md`);

  const output = {
    timestamp: new Date().toISOString(),
    runner: 'extraction-matrix',
    ollamaServer: OLLAMA_URL,
    ollamaModels: OLLAMA_MODELS,
    claudeModel: CLAUDE_ENABLED ? CLAUDE_MODEL : null,
    claudeEnabled: CLAUDE_ENABLED,
    promptVariants: PROMPT_VARIANT_IDS,
    fixture: 'octopus.txt',
    goldenTripleCount: goldenIngest.length,
    cells: results,
    markdownTable: markdown
  };

  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  writeFileSync(mdPath, markdown);
  console.log(`\nResults saved:\n  ${jsonPath}\n  ${mdPath}`);
}

main().catch((e) => {
  console.error('Matrix bench failed:', e);
  process.exit(1);
});
