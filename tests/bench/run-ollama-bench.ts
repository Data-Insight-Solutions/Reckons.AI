#!/usr/bin/env npx tsx
/**
 * Ollama LLM Bench Runner
 *
 * Runs local Ollama models against fixture documents and scores extraction + chat
 * quality against pre-computed golden (Claude Opus) outputs.
 *
 * Zero API credits required — everything runs on your local Ollama instance.
 *
 * Usage:
 *   npx tsx tests/bench/run-ollama-bench.ts                     # run all available models
 *   npx tsx tests/bench/run-ollama-bench.ts --model mistral-nemo # run a single model
 *   npx tsx tests/bench/run-ollama-bench.ts --save               # persist results as JSON
 *   npx tsx tests/bench/run-ollama-bench.ts --list               # show available Ollama models
 *   npx tsx tests/bench/run-ollama-bench.ts --url http://host:11434  # custom Ollama URL
 *   npx tsx tests/bench/run-ollama-bench.ts --tasks ingest       # only ingest (skip chat)
 *   npx tsx tests/bench/run-ollama-bench.ts --tasks chat         # only chat
 *   npx tsx tests/bench/run-ollama-bench.ts --tasks all          # both (default)
 *   npx tsx tests/bench/run-ollama-bench.ts --mode structured    # schema-constrained decoding + auto prompt-variant (see ollama-extract.ts)
 *   npx tsx tests/bench/run-ollama-bench.ts --mode baseline      # plain chat + full prompt (default, matches historical results)
 *   npx tsx tests/bench/run-ollama-bench.ts --timeout-ms 600000  # per-model ingest timeout (default 5 min); model is skipped and noted if exceeded
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, parseTriplesJSON } from '../../src/lib/integrations/llm/extractor';
import { extractWithOllama } from '../../src/lib/integrations/llm/ollama-extract';
import { selectVocabulary, buildVocabularySection } from '../../src/lib/rdf/vocabulary-context';
import { iri, lit } from '../../src/lib/rdf/types';
import type { Statement } from '../../src/lib/rdf/types';
import { ETHICS_PREAMBLE } from '../../src/lib/safety/content-policy';
import { buildReport, formatReport } from './scoring';
import type { ExtractedTriple } from '../../src/lib/integrations/llm/extractor';
import type { ChatTestCase, BenchReport } from './scoring';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');
const listOnly = args.includes('--list');

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const TASKS = getArg('--tasks', 'all') as 'ingest' | 'chat' | 'all';
// 'structured' = schema-constrained /api/chat decoding + auto small-model prompt (ollama-extract.ts).
// 'baseline' = original plain-chat path with the full extraction prompt, for A/B comparison.
const MODE = getArg('--mode', 'baseline') as 'baseline' | 'structured';
const INGEST_TIMEOUT_MS = parseInt(getArg('--timeout-ms', '300000'), 10);
// Reasoning models spend their budget thinking before they answer, so a budget sized for a
// non-reasoning model truncates them mid-thought and the harness sees silence. 256 was enough for
// a 4B model and nowhere near enough for qwen3.6. Overridable, because a bigger budget costs time.
const CHAT_MAX_TOKENS = parseInt(getArg('--chat-max-tokens', '2048'), 10);
// Extraction needs headroom for the reasoning AND the triples that follow it. qwen3.6 spent 7805
// chars thinking before emitting anything, which alone exceeds the old 2048 budget.
const INGEST_MAX_TOKENS = parseInt(getArg('--ingest-max-tokens', '8192'), 10);

// 'auto' | 'compact' (few-shot) | 'full' (the 11-rule prompt). See ollama-extract.ts.
const PROMPT_VARIANT = getArg('--prompt-variant', 'auto') as 'auto' | 'compact' | 'full';
// F136: put the existing graph's predicate vocabulary into the extraction prompt.
const GROUNDED = args.includes('--ground');

function parseModels(): string[] {
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      models.push(args[++i]);
    }
  }
  return models; // empty = discover from Ollama
}

const requestedModels = parseModels();

// ── Ollama API ───────────────────────────────────────────────────────────────

interface OllamaModel {
  name: string;
  details: { parameter_size: string; quantization_level: string; family: string };
  size: number;
}

async function listModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return data.models ?? [];
  } catch (e) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}: ${(e as Error).message}`);
    console.error('Start Ollama with: ollama serve');
    process.exit(1);
  }
}

/** Filter to chat-capable models (skip embedding models) */
function isChatModel(m: OllamaModel): boolean {
  const family = m.details?.family ?? '';
  const name = m.name.toLowerCase();
  // Skip known embedding-only models
  if (name.includes('embed') || name.includes('nomic-embed')) return false;
  if (family === 'nomic-bert' || family === 'bert') return false;
  return true;
}

async function chatOllama(
  system: string,
  user: string,
  model: string,
  maxTokens = 2048
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.1,
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
  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = (msg.content ?? '') as string;

  // REASONING MODELS PUT THEIR ANSWER SOMEWHERE ELSE, AND THIS BENCH USED TO SCORE THEM AS MUTE.
  //
  // Measured 2026-08-15: qwen3.6 (36B) scored 0.0% ingest F1 and returned 0 words to every chat
  // question — the same score as a 4B model. Asked directly through /api/generate it extracted
  // every golden triple correctly. The model was never the problem.
  //
  // Two faults compounded. A reasoning model streams its thinking into `message.reasoning` and
  // only then writes `message.content`; this function read content alone. And max_tokens was small
  // enough (256 for chat) that the thinking exhausted the budget first, so finish_reason came back
  // as "length" with content still empty. The harness recorded that as a confident zero.
  //
  // A benchmark that reports a broken measurement as a bad model is worse than no benchmark: it
  // sends you shopping for a replacement you already own. So an empty answer that was TRUNCATED is
  // now surfaced as a harness failure, never silently scored.
  if (!content.trim()) {
    const reasoning = (msg.reasoning ?? msg.reasoning_content ?? '') as string;
    if (choice.finish_reason === 'length') {
      throw new Error(
        `Ollama returned no content for ${model}: finish_reason=length with ${reasoning.length} chars of reasoning. ` +
          `The token budget (${maxTokens}) was consumed before the model produced an answer — raise it for reasoning models.`,
      );
    }
    // Not truncated, but content is empty and reasoning is not: some builds emit only reasoning.
    if (reasoning.trim()) return reasoning;
  }
  return content;
}

// ── Paths & fixtures ─────────────────────────────────────────────────────────

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

// ── Vocabulary grounding (F136) ──────────────────────────────────────────────
//
// `--ground` loads an existing graph and puts ITS predicate vocabulary into the extraction prompt,
// so the A/B measures the one thing that changed: whether the model reaches for a word the graph
// already uses instead of inventing a synonym.
//
// The fixture deliberately shares NO facts with the golden set — every statement is about a
// different species — because seeding the golden triples would hand over the answer key. See the
// $comment in existing-graph.json for what this does and does not prove.

function loadExistingGraph(): Statement[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'golden', 'existing-graph.json'), 'utf-8'));
  return (raw.statements as Array<{ s: string; p: string; o: string }>).map((t, i) => ({
    id: `existing-${i}`,
    s: iri(`urn:kbase:concept/${t.s}`),
    // A literal-looking object (a number, or a phrase with spaces) is stored as a literal, matching
    // how the app would hold it. Only IRI objects are offered as reusable entity names.
    o: /^\d|\s/.test(t.o) ? lit(t.o) : iri(`urn:kbase:concept/${t.o}`),
    p: iri(`urn:kbase:predicate/${t.p}`),
    g: iri('urn:kbase:source/existing-graph'),
    sourceId: 'existing-graph',
  }) as Statement);
}

function buildGroundingSection(): string {
  if (!GROUNDED) return '';
  const vocab = selectVocabulary(loadExistingGraph(), sourceText);
  const section = buildVocabularySection(vocab);
  console.log(
    `Grounding: offering ${vocab.predicates.length} predicates ` +
      `(${vocab.predicates.filter((p) => p.mentioned).length} matched to the source text), ` +
      `${vocab.entities.length} entities, +${section.length} prompt chars`,
  );
  return section;
}

// ── Chat system prompt ───────────────────────────────────────────────────────

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

// ── Bench steps ──────────────────────────────────────────────────────────────

/** Rejects if `promise` doesn't settle within `ms` — used to bound very slow models (e.g. 24B+ on CPU). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} exceeded ${(ms / 1000).toFixed(0)}s timeout`)), ms);
    promise.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

async function benchIngestBaseline(model: string, vocabularySection: string): Promise<ExtractedTriple[]> {
  const raw = await chatOllama(
    EXTRACTION_SYSTEM_PROMPT,
    buildExtractionUserPrompt(sourceText, 'Common Octopus — Wikipedia', vocabularySection),
    model,
    INGEST_MAX_TOKENS
  );

  console.log(`  Ingest: generated (${raw.length} chars)`);

  let triples: ExtractedTriple[];
  try {
    triples = parseTriplesJSON(raw);
    console.log(`  Ingest: parsed ${triples.length} triples`);
  } catch (e) {
    console.error(`  Ingest: PARSE FAILED — ${(e as Error).message}`);
    console.error(`  Raw (first 500 chars): ${raw.slice(0, 500)}`);
    triples = [];
  }

  return triples;
}

async function benchIngestStructured(model: string): Promise<ExtractedTriple[]> {
  try {
    const triples = await extractWithOllama(sourceText, 'Common Octopus — Wikipedia', {
      model,
      baseUrl: OLLAMA_URL,
      // Was hardcoded to 2048, which silently ignored --ingest-max-tokens on the very path the
      // app actually uses. A reasoning model spends its budget thinking before it answers, so a
      // fixed small budget scored it at zero for running out of room rather than for being wrong.
      maxTokens: INGEST_MAX_TOKENS,
      // 'auto' picks few-shot only for models <=4B (isSmallOllamaModel). Forcing the variant is
      // how you find out whether a large model was losing to a 3B one on the PROMPT rather than
      // on capability — which is a different fix from swapping the model.
      promptMode: PROMPT_VARIANT
    });
    console.log(`  Ingest: parsed ${triples.length} triples (structured)`);
    return triples;
  } catch (e) {
    console.error(`  Ingest: STRUCTURED EXTRACTION FAILED — ${(e as Error).message}`);
    return [];
  }
}

async function benchIngest(model: string): Promise<ExtractedTriple[]> {
  console.log(`  Ingest: extracting triples (mode=${MODE}${GROUNDED ? ', grounded' : ''}) …`);
  const start = Date.now();
  const vocabularySection = buildGroundingSection();

  // Structured mode composes its own prompt inside extractWithOllama, so grounding is not wired
  // through it yet. Say so rather than silently running an ungrounded A/B and reporting it as one.
  if (GROUNDED && MODE === 'structured') {
    throw new Error('--ground is only wired for --mode baseline; structured mode builds its prompt inside extractWithOllama.');
  }

  const triples = await withTimeout(
    MODE === 'structured' ? benchIngestStructured(model) : benchIngestBaseline(model, vocabularySection),
    INGEST_TIMEOUT_MS,
    `Ingest for ${model}`
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Ingest: done in ${elapsed}s`);

  return triples;
}

async function benchChat(model: string): Promise<string[]> {
  const system = buildChatSystem(goldenIngest);
  const responses: string[] = [];

  for (const tc of chatTestCases) {
    const start = Date.now();
    const response = await chatOllama(system, tc.question, model, CHAT_MAX_TOKENS);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const wordCount = response.split(/\s+/).filter(Boolean).length;
    console.log(`  Chat (${elapsed}s, ${wordCount}w): "${tc.question}" → ${response.slice(0, 80).replace(/\n/g, ' ')}…`);
    responses.push(response);
  }

  return responses;
}

// ── Run one model ────────────────────────────────────────────────────────────

async function runModel(model: string): Promise<BenchReport | null> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  MODEL: ${model}`);
  console.log(`${'─'.repeat(60)}`);

  try {
    let ingestOutput: ExtractedTriple[] = [];
    let chatResponses: string[] = [];

    if (TASKS === 'all' || TASKS === 'ingest') {
      ingestOutput = await benchIngest(model);
    }

    if (TASKS === 'all' || TASKS === 'chat') {
      chatResponses = await benchChat(model);
    }

    const report = buildReport(model, ingestOutput, goldenIngest, chatResponses, chatTestCases);
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
  console.log('  OLLAMA BENCH — COMPARISON TABLE');
  console.log(`${'═'.repeat(72)}`);

  const header = [
    'Model'.padEnd(28),
    'Ingest P'.padStart(9),
    'Ingest R'.padStart(9),
    'Ingest F1'.padStart(9),
    'Chat'.padStart(7),
    'Combined'.padStart(9),
  ].join(' │ ');

  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  const sorted = [...reports].sort((a, b) => b.combined - a.combined);
  for (const r of sorted) {
    const label = r.model.slice(0, 28);
    const row = [
      label.padEnd(28),
      pct(r.ingest.precision).padStart(9),
      pct(r.ingest.recall).padStart(9),
      pct(r.ingest.f1).padStart(9),
      pct(r.chatOverall).padStart(7),
      pct(r.combined).padStart(9),
    ].join(' │ ');
    console.log(`  ${row}`);
  }

  console.log(`${'═'.repeat(72)}\n`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allModels = await listModels();
  const chatModels = allModels.filter(isChatModel);

  if (listOnly) {
    console.log(`\nOllama models at ${OLLAMA_URL}:\n`);
    for (const m of allModels) {
      const chat = isChatModel(m) ? '' : ' (embedding)';
      console.log(`  ${m.name.padEnd(35)} ${m.details.parameter_size.padStart(10)}  ${m.details.quantization_level.padEnd(8)} ${formatSize(m.size)}${chat}`);
    }
    console.log(`\n  ${chatModels.length} chat models, ${allModels.length - chatModels.length} embedding models`);
    console.log('  Pass --model <name> to run a specific model.\n');
    process.exit(0);
  }

  console.log(`\n╔${'═'.repeat(58)}╗`);
  console.log(`║  OLLAMA LLM BENCH — Reckons.AI                            ║`);
  console.log(`╚${'═'.repeat(58)}╝`);
  console.log(`Server: ${OLLAMA_URL}`);
  console.log(`Fixture: octopus.txt (${sourceText.length} chars)`);
  console.log(`Golden: ${goldenIngest.length} ingest triples, ${chatTestCases.length} chat questions`);
  console.log(`Tasks: ${TASKS}`);
  console.log(`Grounded: ${GROUNDED ? 'yes (F136 vocabulary section)' : 'no'}`);
  console.log(`Mode: ${MODE}${MODE === 'structured' ? ' (schema-constrained decoding + auto small-model prompt)' : ' (plain chat + full prompt)'}`);
  console.log(`Ingest timeout: ${(INGEST_TIMEOUT_MS / 1000).toFixed(0)}s`);

  // Determine which models to run
  const modelsToRun = requestedModels.length > 0
    ? requestedModels
    : chatModels.map(m => m.name);

  console.log(`Models: ${modelsToRun.length} (${modelsToRun.join(', ')})`);

  const reports: BenchReport[] = [];

  for (const model of modelsToRun) {
    const report = await runModel(model);
    if (report) reports.push(report);
  }

  printComparison(reports);

  if (saveResults && reports.length > 0) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    for (const r of reports) {
      const slug = `ollama_${r.model.replace(/[/:]/g, '_')}_${MODE}${GROUNDED ? '_grounded' : ''}`;
      writeFileSync(join(RESULTS_DIR, `${slug}_${ts}.json`), JSON.stringify({ ...r, mode: MODE, grounded: GROUNDED }, null, 2));
    }

    const summary = {
      timestamp: new Date().toISOString(),
      runner: 'ollama',
      server: OLLAMA_URL,
      fixture: 'octopus.txt',
      tasks: TASKS,
      mode: MODE,
      goldenTripleCount: goldenIngest.length,
      chatQuestionCount: chatTestCases.length,
      results: reports.map(r => ({
        model: r.model,
        ingestPrecision: r.ingest.precision,
        ingestRecall: r.ingest.recall,
        ingestF1: r.ingest.f1,
        chatOverall: r.chatOverall,
        combined: r.combined,
      })),
    };
    writeFileSync(join(RESULTS_DIR, `ollama_comparison_${MODE}_${ts}.json`), JSON.stringify(summary, null, 2));
    console.log(`Results saved to tests/bench/results/`);
  }
}

main().catch(e => {
  console.error('Bench failed:', e);
  process.exit(1);
});
