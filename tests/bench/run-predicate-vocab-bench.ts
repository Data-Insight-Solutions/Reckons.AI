#!/usr/bin/env npx tsx
/**
 * Predicate Vocabulary Benchmark
 *
 * Measures the decision `src/lib/rdf/normalize-entities.ts` makes at write time: rewrite an
 * incoming predicate IRI to an existing one when cosine >= PREDICATE_MATCH_THRESHOLD (0.88).
 *
 * That constant gates a WRITE into the user's graph. Until 2026-08-15 it was tested only against a
 * hand-written mock vector table in `normalize-entities.test.ts` — the test asserted the branching
 * logic given assumed cosines and never measured what a real embedding model returns. This is the
 * missing half: real models, real labels, the real threshold.
 *
 * The benchmark embeds the labels exactly as production does (labelFromIRI: strip the IRI path,
 * hyphens to spaces) so the numbers transfer directly to the shipped code.
 *
 * Usage:
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts                      # curated HF models
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --model Xenova/bge-small-en-v1.5
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --ollama             # local Ollama embedders too
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --hf                 # discover top HF models
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --threshold 0.88     # threshold under test
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --save               # persist JSON results
 *   npx tsx tests/bench/run-predicate-vocab-bench.ts --pairs              # print the fixture and exit
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  scorePredicateVocab,
  formatPredicateVocabReport,
  type PredicatePairFixture,
  type ScoredPair,
  type PredicateVocabScore,
} from './predicate-vocab-scoring';

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const save = args.includes('--save');
const useOllama = args.includes('--ollama');
const useHF = args.includes('--hf');
const pairsOnly = args.includes('--pairs');

function getArg(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

/** Mirrors PREDICATE_MATCH_THRESHOLD in src/lib/rdf/normalize-entities.ts. */
const PRODUCTION_THRESHOLD = parseFloat(getArg('--threshold', '0.88'));
const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');

function explicitModels(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const BENCH_DIR = import.meta.dirname || __dirname;
const RESULTS_DIR = join(BENCH_DIR, 'results');

const fixture: PredicatePairFixture = JSON.parse(
  readFileSync(join(BENCH_DIR, 'fixtures', 'golden', 'predicate-pairs.json'), 'utf-8'),
);

/**
 * The same transform `normalize-entities.ts` applies before embedding (via labelFromIRI in
 * semantic-diff.ts). Duplicated rather than imported because this runner must work without the
 * SvelteKit `$lib` alias, and the transform is three characters of logic — but if labelFromIRI
 * ever changes, this must change with it or the benchmark stops measuring production.
 */
function labelFromIRI(iri: string): string {
  const last = iri.split('/').pop() ?? iri;
  return last.replace(/-/g, ' ').replace(/_/g, ' ').trim();
}

function allLabels(): string[] {
  const set = new Set<string>();
  for (const p of [...fixture.shouldMerge, ...fixture.mustNotMerge]) {
    set.add(labelFromIRI(p.a));
    set.add(labelFromIRI(p.b));
  }
  return [...set];
}

// ── Vector maths ─────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

type Embedder = (texts: string[]) => Promise<number[][]>;

// ── Backends ─────────────────────────────────────────────────────────────────

let _pipeline: any = null;
async function loadPipeline() {
  if (!_pipeline) {
    const mod = await import('@huggingface/transformers');
    _pipeline = mod.pipeline;
    mod.env.allowLocalModels = false;
  }
  return _pipeline;
}

/**
 * transformers.js — the path the browser app actually uses, so these numbers are the ones that
 * describe shipped behavior. dtype q8 matches `src/lib/embed.ts`.
 */
async function hfEmbedder(modelId: string, dtype = 'q8'): Promise<Embedder> {
  const pipeline = await loadPipeline();
  let extractor: any;
  try {
    extractor = await pipeline('feature-extraction', modelId, { dtype });
  } catch {
    extractor = await pipeline('feature-extraction', modelId);
  }
  return async (texts: string[]) => {
    const out: number[][] = [];
    for (const t of texts) {
      const res = await extractor(t, { pooling: 'mean', normalize: true });
      out.push(Array.from(res.data as Float32Array));
    }
    return out;
  };
}

/** Ollama embedders — not what the browser ships, but what the offline agent tier can reach. */
async function ollamaEmbedder(model: string): Promise<Embedder> {
  return async (texts: string[]) => {
    const out: number[][] = [];
    for (const t of texts) {
      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: t }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      if (!Array.isArray(data.embedding)) throw new Error(`No embedding returned for "${t}"`);
      out.push(data.embedding);
    }
    return out;
  };
}

async function listOllamaEmbedders(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? [])
      .filter((m: any) => (m.capabilities ?? []).includes('embedding') || m.name.includes('embed'))
      .map((m: any) => m.name);
  } catch {
    return [];
  }
}

// ── Run one model ────────────────────────────────────────────────────────────

async function benchModel(label: string, embed: Embedder): Promise<PredicateVocabScore> {
  const labels = allLabels();
  const vectors = await embed(labels);
  const byLabel = new Map<string, number[]>();
  labels.forEach((l, i) => byLabel.set(l, vectors[i]));

  const score = (pairs: typeof fixture.shouldMerge): ScoredPair[] =>
    pairs.map((p) => ({
      ...p,
      cosine: cosine(byLabel.get(labelFromIRI(p.a))!, byLabel.get(labelFromIRI(p.b))!),
    }));

  return scorePredicateVocab(
    label,
    score(fixture.shouldMerge),
    score(fixture.mustNotMerge),
    PRODUCTION_THRESHOLD,
  );
}

// ── Comparison ───────────────────────────────────────────────────────────────

function printComparison(scores: PredicateVocabScore[]): void {
  if (scores.length < 2) return;

  console.log(`\n${'═'.repeat(96)}`);
  console.log(`  PREDICATE VOCABULARY — COMPARISON (production threshold ${PRODUCTION_THRESHOLD})`);
  console.log(`${'═'.repeat(96)}`);

  const header = [
    'Model'.padEnd(38),
    'Recall@prod'.padStart(11),
    'FalseMerge'.padStart(11),
    'Separation'.padStart(11),
    'SafeThr'.padStart(8),
    'Recall@safe'.padStart(11),
  ].join(' │ ');
  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  // Ranked by what actually matters: a model that never corrupts, then by recall it can reach
  // while staying clean. A model with no safe threshold sorts last regardless of its recall.
  const sorted = [...scores].sort((a, b) => {
    const aSafe = a.safeThreshold !== null, bSafe = b.safeThreshold !== null;
    if (aSafe !== bSafe) return aSafe ? -1 : 1;
    return b.recallAtSafeThreshold - a.recallAtSafeThreshold;
  });

  for (const s of sorted) {
    console.log(`  ${[
      s.model.slice(0, 38).padEnd(38),
      `${(s.atProduction.mergeRecall * 100).toFixed(1)}%`.padStart(11),
      `${(s.atProduction.falseMergeRate * 100).toFixed(1)}%`.padStart(11),
      `${s.separation >= 0 ? '+' : ''}${s.separation.toFixed(3)}`.padStart(11),
      (s.safeThreshold === null ? 'none' : s.safeThreshold.toFixed(2)).padStart(8),
      `${(s.recallAtSafeThreshold * 100).toFixed(1)}%`.padStart(11),
    ].join(' │ ')}`);
  }
  console.log(`${'═'.repeat(96)}\n`);

  const anyFalse = scores.filter((s) => s.atProduction.falseMergeRate > 0);
  if (anyFalse.length > 0) {
    console.log(`  ⚠ ${anyFalse.length}/${scores.length} models FALSE-MERGE at the shipped ${PRODUCTION_THRESHOLD}.`);
    console.log(`    normalize-entities.ts rewrites the predicate with no antonym guard — the guard`);
    console.log(`    (isAntonymPredicate) is module-private to semantic-diff.ts and protects only the`);
    console.log(`    advisory diff path, not the write path.\n`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (pairsOnly) {
    console.log(`\nPredicate pair fixture (labels shown as production embeds them):\n`);
    console.log(`  SHOULD MERGE (${fixture.shouldMerge.length}) — same relation, different words:`);
    for (const p of fixture.shouldMerge) {
      console.log(`    ${labelFromIRI(p.a).padEnd(28)} ≈ ${labelFromIRI(p.b).padEnd(28)} ${p.source === 'observed' ? '[OBSERVED]' : ''}`);
    }
    console.log(`\n  MUST NOT MERGE (${fixture.mustNotMerge.length}) — different relations that look alike:`);
    for (const p of fixture.mustNotMerge) {
      console.log(`    ${labelFromIRI(p.a).padEnd(28)} ≠ ${labelFromIRI(p.b).padEnd(28)} [${p.severity}]`);
    }
    console.log();
    process.exit(0);
  }

  console.log(`\n╔${'═'.repeat(62)}╗`);
  console.log(`║  PREDICATE VOCABULARY BENCH — Reckons.AI                     ║`);
  console.log(`╚${'═'.repeat(62)}╝`);
  console.log(`Fixture: ${fixture.shouldMerge.length} synonym pairs, ${fixture.mustNotMerge.length} distinct-relation pairs`);
  console.log(`Threshold under test: ${PRODUCTION_THRESHOLD} (PREDICATE_MATCH_THRESHOLD in normalize-entities.ts)`);

  const targets: Array<{ label: string; make: () => Promise<Embedder> }> = [];

  const explicit = explicitModels();
  if (explicit.length > 0) {
    for (const m of explicit) targets.push({ label: m, make: () => hfEmbedder(m) });
  } else {
    // The app's default first (bge-small-en-v1.5 per src/lib/embed.ts), then the alternatives the
    // embedding bench already tracks.
    for (const m of [
      'Xenova/bge-small-en-v1.5',
      'Xenova/all-MiniLM-L6-v2',
      'Xenova/gte-small',
      'Xenova/e5-small-v2',
    ]) {
      targets.push({ label: m, make: () => hfEmbedder(m) });
    }
  }

  if (useHF) {
    const { queryEmbeddingModels } = await import('../visual/hf-model-query');
    try {
      const top = await queryEmbeddingModels({ top: 5 });
      for (const m of top) {
        if (!targets.some((t) => t.label === m.modelId)) {
          targets.push({ label: m.modelId, make: () => hfEmbedder(m.modelId) });
        }
      }
    } catch (e) {
      console.error(`  HF discovery failed (${(e as Error).message}) — continuing with curated list.`);
    }
  }

  if (useOllama) {
    const embedders = await listOllamaEmbedders();
    if (embedders.length === 0) {
      console.error(`  No Ollama embedding models at ${OLLAMA_URL} — skipping (is ollama serve running?).`);
    }
    for (const m of embedders) {
      targets.push({ label: `ollama:${m}`, make: () => ollamaEmbedder(m) });
    }
  }

  console.log(`Models: ${targets.length}\n`);

  const scores: PredicateVocabScore[] = [];
  for (const t of targets) {
    console.log(`\n${'─'.repeat(60)}\n  MODEL: ${t.label}\n${'─'.repeat(60)}`);
    try {
      const started = Date.now();
      const embed = await t.make();
      const score = await benchModel(t.label, embed);
      console.log(`  embedded ${allLabels().length} labels in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(formatPredicateVocabReport(score, PRODUCTION_THRESHOLD));
      scores.push(score);
    } catch (e) {
      // Loud, never silent: a model that failed to load is not a model that scored zero.
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }

  printComparison(scores);

  if (save && scores.length > 0) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    writeFileSync(
      join(RESULTS_DIR, `predicate_vocab_${ts}.json`),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          productionThreshold: PRODUCTION_THRESHOLD,
          fixtureCounts: {
            shouldMerge: fixture.shouldMerge.length,
            mustNotMerge: fixture.mustNotMerge.length,
          },
          // The full sweep is large and only useful for plotting; the summary is what gets read.
          results: scores.map((s) => ({ ...s, sweep: undefined })),
        },
        null,
        2,
      ),
    );
    console.log(`Results saved to tests/bench/results/predicate_vocab_${ts}.json`);
  }
}

main().catch((e) => {
  console.error('Predicate vocab bench failed:', e);
  process.exit(1);
});
