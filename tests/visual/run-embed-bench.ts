#!/usr/bin/env npx tsx
/**
 * Embedding Model Benchmark
 *
 * Compares embedding models on real KB data extracted from TTL files.
 * Tests: similarity accuracy, clustering quality, latency, and model size.
 *
 * Usage:
 *   npx tsx tests/visual/run-embed-bench.ts                    # curated models
 *   npx tsx tests/visual/run-embed-bench.ts --hf               # query HF for top models
 *   npx tsx tests/visual/run-embed-bench.ts --model nomic-ai/nomic-embed-text-v1.5
 *   npx tsx tests/visual/run-embed-bench.ts --save              # persist results
 *   npx tsx tests/visual/run-embed-bench.ts --list              # show test pairs
 *
 * Requires: Node.js 20+, @huggingface/transformers
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { queryEmbeddingModels, getCuratedModels } from './hf-model-query';
import {
  scoreSimilarityClassification, scoreRetrieval, scoreClustering, scoreAlignment,
  computeComposite, formatCompositeScore,
  type RetrievalQuery, type AlignmentGolden, type ClusterGolden,
} from './embed-scoring';

// Load .env
const envPath = resolve(import.meta.dirname || __dirname, '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// ── Test data: golden similarity pairs from KB entities ──────────────────────

interface SimilarityPair {
  textA: string;
  textB: string;
  /** Expected relationship: 'similar' (cos >= 0.7), 'related' (0.4-0.7), 'unrelated' (< 0.4) */
  expected: 'similar' | 'related' | 'unrelated';
  category: string;
}

/**
 * Golden test pairs derived from the Production, Roadmap, and Docs KBs.
 * Each pair tests whether the model correctly captures semantic relationships.
 */
const SIMILARITY_PAIRS: SimilarityPair[] = [
  // ── Same entity, different surface forms ──
  { textA: 'Reckons.AI', textB: 'reckons ai knowledge graph', expected: 'similar', category: 'entity-match' },
  { textA: 'SvelteKit', textB: 'Svelte Kit framework', expected: 'similar', category: 'entity-match' },
  { textA: 'TypeScript', textB: 'TS programming language', expected: 'similar', category: 'entity-match' },
  { textA: 'IndexedDB', textB: 'indexed database browser storage', expected: 'similar', category: 'entity-match' },
  { textA: 'triple extraction', textB: 'extracting RDF triples from text', expected: 'similar', category: 'entity-match' },

  // ── Related concepts from KB predicates ──
  { textA: 'knowledge graph', textB: 'semantic web ontology', expected: 'related', category: 'kb-related' },
  { textA: 'ingest workflow', textB: 'importing documents for extraction', expected: 'related', category: 'kb-related' },
  { textA: 'review panel', textB: 'confirming pending triples', expected: 'related', category: 'kb-related' },
  { textA: 'MCP server', textB: 'model context protocol tools', expected: 'related', category: 'kb-related' },
  { textA: 'visual testing', textB: 'screenshot comparison benchmarks', expected: 'related', category: 'kb-related' },
  { textA: 'multi-KB management', textB: 'multiple knowledge bases switching', expected: 'similar', category: 'kb-related' },

  // ── Cross-KB alignment pairs (should find these when aligning KBs) ──
  { textA: 'production test suite passing', textB: 'all tests green in CI', expected: 'similar', category: 'cross-kb' },
  { textA: 'planned feature: enrichment pipeline', textB: 'roadmap item for progressive analysis', expected: 'related', category: 'cross-kb' },
  { textA: 'Dexie.js local persistence', textB: 'browser database storage layer', expected: 'related', category: 'cross-kb' },

  // ── Unrelated pairs (should score low) ──
  { textA: 'SvelteKit framework', textB: 'morning coffee recipe', expected: 'unrelated', category: 'negative' },
  { textA: 'RDF triple extraction', textB: 'weather forecast tomorrow', expected: 'unrelated', category: 'negative' },
  { textA: 'knowledge graph visualization', textB: 'stock market trading', expected: 'unrelated', category: 'negative' },
  { textA: 'IndexedDB persistence', textB: 'Italian pasta carbonara', expected: 'unrelated', category: 'negative' },
  { textA: 'Playwright visual testing', textB: 'medieval castle architecture', expected: 'unrelated', category: 'negative' },

  // ── Tricky near-duplicates (merge detection) ──
  { textA: 'Claude API', textB: 'Anthropic Claude', expected: 'similar', category: 'merge-detect' },
  { textA: 'ollama local model', textB: 'Ollama LLM backend', expected: 'similar', category: 'merge-detect' },
  { textA: 'transformers.js', textB: 'HuggingFace Transformers JavaScript', expected: 'similar', category: 'merge-detect' },
  { textA: 'Shelly turtle companion', textB: 'turtle AI assistant', expected: 'related', category: 'merge-detect' },

  // ── Predicate similarity (should cluster related predicates) ──
  { textA: 'has-feature', textB: 'includes capability', expected: 'related', category: 'predicate' },
  { textA: 'built-with', textB: 'uses technology', expected: 'related', category: 'predicate' },
  { textA: 'has-status production', textB: 'deployed and working', expected: 'related', category: 'predicate' },
];

/** Cluster test: entities that should group together */
const CLUSTER_GROUPS = [
  {
    name: 'tech-stack',
    items: ['SvelteKit', 'TypeScript', 'Dexie.js', 'Vite', 'Playwright'],
  },
  {
    name: 'workflows',
    items: ['Ingest Workflow', 'Review Workflow', 'Explore Workflow', 'Compare Workflow'],
  },
  {
    name: 'llm-backends',
    items: ['Claude API', 'OpenAI GPT', 'Ollama local', 'Gemini API', 'transformers.js WASM'],
  },
];

/** Retrieval queries: simulate semantic search over KB statements */
const RETRIEVAL_QUERIES: RetrievalQuery[] = [
  {
    query: 'how does triple extraction work',
    relevant: ['triple-extraction', 'llm-extractor', 'ingest-workflow'],
    corpus: [
      { id: 'triple-extraction', text: 'LLM-powered triple extraction from text into RDF statements' },
      { id: 'llm-extractor', text: 'Claude and GPT extract subject-predicate-object triples from documents' },
      { id: 'ingest-workflow', text: 'Ingest workflow processes notes, URLs, and files for knowledge extraction' },
      { id: 'sveltekit', text: 'SvelteKit is a web application framework for building modern apps' },
      { id: 'dexie-db', text: 'Dexie.js provides IndexedDB persistence layer for browser storage' },
      { id: 'visual-testing', text: 'Playwright captures screenshots for visual regression testing' },
      { id: 'kb-registry', text: 'Knowledge base registry tracks multiple KBs in localStorage' },
      { id: 'turtle-chat', text: 'Shelly the turtle companion provides conversational AI assistance' },
    ],
  },
  {
    query: 'knowledge base management and switching',
    relevant: ['multi-kb', 'kb-registry', 'kb-leap'],
    corpus: [
      { id: 'multi-kb', text: 'Multiple knowledge bases can be created, switched, and compared' },
      { id: 'kb-registry', text: 'KB registry in localStorage tracks known knowledge bases by name and ID' },
      { id: 'kb-leap', text: 'KB Leap predicate links entities to other knowledge bases for cross-reference' },
      { id: 'triple-extraction', text: 'LLM extracts semantic triples from unstructured text' },
      { id: 'review-panel', text: 'Review panel shows pending triples for human confirmation' },
      { id: 'graph-viz', text: '2D force-directed graph renders nodes and edges on canvas' },
      { id: 'mcp-server', text: 'MCP server exposes KB tools for external AI agents' },
      { id: 'settings', text: 'Settings page configures API keys, models, and preferences' },
    ],
  },
  {
    query: 'AI model backends and providers',
    relevant: ['claude-api', 'ollama', 'wasm-backend', 'openai'],
    corpus: [
      { id: 'claude-api', text: 'Anthropic Claude API for cloud-based inference and extraction' },
      { id: 'ollama', text: 'Ollama runs local LLM models for offline extraction and chat' },
      { id: 'wasm-backend', text: 'WASM backend uses transformers.js to run quantized models in-browser' },
      { id: 'openai', text: 'OpenAI GPT-4o-mini for cloud extraction when Claude unavailable' },
      { id: 'graph-viz', text: '2D force-directed graph renders entities as colored nodes' },
      { id: 'review-panel', text: 'Review panel with tabs for incoming, deletions, and merges' },
      { id: 'kb-page', text: 'KB management page for creating and organizing knowledge bases' },
      { id: 'export-ttl', text: 'Export knowledge base to Turtle RDF format for sharing' },
    ],
  },
];

/** Cross-KB alignment golden pairs: entities from Production KB <-> Roadmap KB */
const ALIGNMENT_PAIRS: AlignmentGolden[] = [
  // Should match (same entity in both KBs)
  { entityA: 'Reckons.AI application', entityB: 'Reckons.AI product' },
  { entityA: 'SvelteKit framework', entityB: 'SvelteKit web framework' },
  { entityA: 'Ingest Workflow', entityB: 'Ingest Workflow pipeline' },
  { entityA: 'Multi-KB management', entityB: 'Multiple knowledge bases' },
  { entityA: 'MCP server tools', entityB: 'Model Context Protocol server' },
  { entityA: 'Review panel', entityB: 'Review workflow' },
  // Should NOT match (different entities)
  { entityA: 'Playwright visual testing', entityB: null },
  { entityA: 'Dexie.js IndexedDB', entityB: null },
  { entityA: 'Kokoro TTS voice synthesis', entityB: null },
];

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');
const queryHF = args.includes('--hf');

if (args.includes('--list')) {
  console.log('\nSimilarity test pairs:');
  for (const p of SIMILARITY_PAIRS) {
    console.log(`  [${p.expected.padEnd(9)}] ${p.category.padEnd(14)} "${p.textA}" <-> "${p.textB}"`);
  }
  console.log(`\nCluster groups:`);
  for (const g of CLUSTER_GROUPS) {
    console.log(`  ${g.name}: ${g.items.join(', ')}`);
  }
  console.log(`\nTotal: ${SIMILARITY_PAIRS.length} pairs, ${CLUSTER_GROUPS.length} clusters`);
  process.exit(0);
}

// Parse --model flags
function parseModels(): string[] {
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) models.push(args[++i]);
  }
  return models;
}

// ── Embedding helpers (Node.js, not browser) ─────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null;

async function loadPipeline() {
  if (!_pipeline) {
    const mod = await import('@huggingface/transformers');
    _pipeline = mod.pipeline;
    mod.env.allowLocalModels = false;
  }
  return _pipeline;
}

async function benchModel(modelId: string, dtype: string = 'q8'): Promise<{
  modelId: string;
  dtype: string;
  loadTimeMs: number;
  dims: number;
  pairResults: Array<{
    pair: SimilarityPair;
    cosine: number;
    passed: boolean;
  }>;
  clusterResults: Array<{
    group: string;
    intraAvg: number;
    interAvg: number;
    separation: number;
  }>;
  avgEmbedMs: number;
  accuracy: number;
  composite: ReturnType<typeof computeComposite> | null;
}> {
  const pipeline = await loadPipeline();

  // Load model
  const loadStart = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractor: any;
  try {
    extractor = await pipeline('feature-extraction', modelId, { dtype });
  } catch (e) {
    // Try without dtype for models that don't support quantization
    try {
      extractor = await pipeline('feature-extraction', modelId);
    } catch {
      throw new Error(`Failed to load ${modelId}: ${(e as Error).message}`);
    }
  }
  const loadTimeMs = Date.now() - loadStart;

  // Helper: embed + normalize
  async function embed(text: string): Promise<Float32Array> {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data as Float32Array);
  }

  function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  // Test similarity pairs
  const embedTimes: number[] = [];
  const pairResults: Array<{ pair: SimilarityPair; cosine: number; passed: boolean }> = [];
  let dims = 0;

  for (const pair of SIMILARITY_PAIRS) {
    const t0 = Date.now();
    const vecA = await embed(pair.textA);
    const vecB = await embed(pair.textB);
    embedTimes.push(Date.now() - t0);

    dims = vecA.length;
    const cos = cosine(vecA, vecB);

    let passed: boolean;
    if (pair.expected === 'similar') passed = cos >= 0.65;
    else if (pair.expected === 'related') passed = cos >= 0.3 && cos < 0.85;
    else passed = cos < 0.45; // unrelated

    pairResults.push({ pair, cosine: cos, passed });
  }

  // Test clustering
  const clusterResults: Array<{
    group: string;
    intraAvg: number;
    interAvg: number;
    separation: number;
  }> = [];

  const allClusterVecs: Map<string, Float32Array[]> = new Map();
  for (const group of CLUSTER_GROUPS) {
    const vecs: Float32Array[] = [];
    for (const item of group.items) {
      vecs.push(await embed(item));
    }
    allClusterVecs.set(group.name, vecs);
  }

  for (const group of CLUSTER_GROUPS) {
    const vecs = allClusterVecs.get(group.name)!;

    // Intra-cluster similarity
    let intraSum = 0, intraCount = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        intraSum += cosine(vecs[i], vecs[j]);
        intraCount++;
      }
    }
    const intraAvg = intraCount > 0 ? intraSum / intraCount : 0;

    // Inter-cluster similarity (against other groups)
    let interSum = 0, interCount = 0;
    for (const [otherName, otherVecs] of allClusterVecs) {
      if (otherName === group.name) continue;
      for (const v1 of vecs) {
        for (const v2 of otherVecs) {
          interSum += cosine(v1, v2);
          interCount++;
        }
      }
    }
    const interAvg = interCount > 0 ? interSum / interCount : 0;

    clusterResults.push({
      group: group.name,
      intraAvg,
      interAvg,
      separation: intraAvg - interAvg,
    });
  }

  const passedCount = pairResults.filter(r => r.passed).length;
  const avgEmbedMs = embedTimes.length > 0
    ? embedTimes.reduce((a, b) => a + b, 0) / embedTimes.length
    : 0;

  // ── Composite scoring using MTEB-inspired metrics ──

  // Cache for embeddings (avoid re-embedding)
  const embedCache = new Map<string, Float32Array>();
  const cachedEmbed = (text: string): Float32Array => {
    if (!embedCache.has(text)) {
      // We already have vecs from above — but for new texts we need sync access
      // For composite scoring we pre-embed everything
      throw new Error(`Text not pre-embedded: ${text}`);
    }
    return embedCache.get(text)!;
  };

  let composite: ReturnType<typeof computeComposite> | null = null;

  try {
    // Pre-embed all texts needed for composite scoring
    const allTexts = new Set<string>();
    for (const q of RETRIEVAL_QUERIES) {
      allTexts.add(q.query);
      for (const doc of q.corpus) allTexts.add(doc.text);
    }
    for (const p of ALIGNMENT_PAIRS) {
      allTexts.add(p.entityA);
      if (p.entityB) allTexts.add(p.entityB);
    }
    for (const g of CLUSTER_GROUPS) {
      for (const item of g.items) allTexts.add(item);
    }

    for (const text of allTexts) {
      embedCache.set(text, await embed(text));
    }

    // 1. Similarity scoring
    const simScore = scoreSimilarityClassification(
      pairResults.map(r => ({ pair: r.pair, cosine: r.cosine }))
    );

    // 2. Retrieval scoring
    const retrievalResults = RETRIEVAL_QUERIES.map(q => {
      const queryVec = cachedEmbed(q.query);
      const ranked = q.corpus
        .map(doc => ({ id: doc.id, cosine: cosine(queryVec, cachedEmbed(doc.text)) }))
        .sort((a, b) => b.cosine - a.cosine)
        .map(r => r.id);
      return { query: q, rankedResults: ranked };
    });
    const retScore = scoreRetrieval(retrievalResults);

    // 3. Clustering scoring
    const clustScore = scoreClustering(
      CLUSTER_GROUPS as ClusterGolden[],
      (text) => cachedEmbed(text),
      cosine,
      0.85,
    );

    // 4. Alignment scoring
    const alignScore = scoreAlignment(
      ALIGNMENT_PAIRS,
      (text) => cachedEmbed(text),
      cosine,
      0.85,
    );

    composite = computeComposite(simScore, retScore, clustScore, alignScore);
  } catch (e) {
    console.warn(`  Composite scoring failed: ${(e as Error).message}`);
  }

  // Release model to free memory
  try {
    await extractor.dispose?.();
  } catch { /* some models don't support dispose */ }

  return {
    modelId,
    dtype,
    loadTimeMs,
    dims,
    pairResults,
    clusterResults,
    avgEmbedMs,
    accuracy: passedCount / SIMILARITY_PAIRS.length,
    composite,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log('  EMBEDDING MODEL BENCHMARK');
  console.log(`${'='.repeat(70)}`);
  console.log(`Test pairs: ${SIMILARITY_PAIRS.length}`);
  console.log(`Cluster groups: ${CLUSTER_GROUPS.length}`);

  // Determine which models to test
  const explicitModels = parseModels();
  let modelsToTest: Array<{ modelId: string; dtype: string }>;

  if (explicitModels.length > 0) {
    modelsToTest = explicitModels.map(m => ({ modelId: m, dtype: 'q8' }));
  } else {
    const curated = getCuratedModels();
    modelsToTest = curated.map(c => ({ modelId: c.modelId, dtype: c.dtype }));
  }

  // Optionally query HF for additional top models
  if (queryHF) {
    console.log('\nQuerying HuggingFace for top models...');
    try {
      const hfModels = await queryEmbeddingModels({ top: 5, sort: 'downloads' });
      const hfOnnx = hfModels.filter(m => m.hasOnnx);
      console.log(`  Found ${hfOnnx.length} ONNX-ready models from HF top rankings`);

      for (const m of hfOnnx) {
        if (!modelsToTest.find(t => t.modelId === m.modelId)) {
          modelsToTest.push({ modelId: m.modelId, dtype: 'q8' });
        }
      }
    } catch (e) {
      console.warn(`  HF query failed: ${(e as Error).message}`);
    }
  }

  console.log(`\nModels to benchmark: ${modelsToTest.length}`);
  for (const m of modelsToTest) {
    console.log(`    ${m.modelId} (${m.dtype})`);
  }

  // Run benchmarks
  const results: Array<Awaited<ReturnType<typeof benchModel>>> = [];

  for (const { modelId, dtype } of modelsToTest) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  MODEL: ${modelId} (${dtype})`);
    console.log(`${'─'.repeat(70)}`);

    try {
      const result = await benchModel(modelId, dtype);
      results.push(result);

      // Print pair results by category
      const categories = [...new Set(result.pairResults.map(r => r.pair.category))];
      for (const cat of categories) {
        const catPairs = result.pairResults.filter(r => r.pair.category === cat);
        const catPassed = catPairs.filter(r => r.passed).length;
        console.log(`  ${cat}: ${catPassed}/${catPairs.length}`);
        for (const r of catPairs) {
          const icon = r.passed ? '\u2713' : '\u2717';
          console.log(`    ${icon} cos=${r.cosine.toFixed(3)} [${r.pair.expected}] "${r.pair.textA}" <-> "${r.pair.textB}"`);
        }
      }

      // Print cluster results
      console.log(`\n  Clustering:`);
      for (const c of result.clusterResults) {
        console.log(`    ${c.group}: intra=${c.intraAvg.toFixed(3)} inter=${c.interAvg.toFixed(3)} sep=${c.separation.toFixed(3)}`);
      }

      // Print composite score
      if (result.composite) {
        console.log(`\n  MTEB-style Composite:`);
        console.log(formatCompositeScore(result.composite));
      }

      console.log(`\n  Summary: ${(result.accuracy * 100).toFixed(1)}% pair accuracy, composite=${result.composite ? (result.composite.overall * 100).toFixed(1) + '%' : 'N/A'}, ${result.dims}d, load=${result.loadTimeMs}ms, embed=${result.avgEmbedMs.toFixed(0)}ms/pair`);
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }

  // Print comparison table
  if (results.length > 1) {
    console.log(`\n${'='.repeat(100)}`);
    console.log('  COMPARISON TABLE');
    console.log(`${'='.repeat(100)}`);
    console.log('  Model                                        Dims  PairAcc  Composite  nDCG   Silhouette  Load(ms)');
    console.log('  ' + '-'.repeat(96));

    const sorted = [...results].sort((a, b) => {
      const aComp = a.composite?.overall ?? a.accuracy;
      const bComp = b.composite?.overall ?? b.accuracy;
      return bComp - aComp;
    });

    for (const r of sorted) {
      const comp = r.composite;
      console.log(
        `  ${r.modelId.padEnd(45)} ${String(r.dims).padStart(4)}  ` +
        `${(r.accuracy * 100).toFixed(1).padStart(5)}%  ` +
        `${comp ? (comp.overall * 100).toFixed(1).padStart(7) + '%' : '    N/A '}  ` +
        `${comp?.retrieval ? (comp.retrieval.ndcg * 100).toFixed(1).padStart(4) + '%' : '  N/A'}  ` +
        `${comp?.clustering ? comp.clustering.silhouette.toFixed(3).padStart(10) : '       N/A'}  ` +
        `${String(r.loadTimeMs).padStart(7)}`
      );
    }

    // Winner by composite (or accuracy fallback)
    const best = sorted[0];
    const compStr = best.composite ? `${(best.composite.overall * 100).toFixed(1)}% composite` : `${(best.accuracy * 100).toFixed(1)}% pair accuracy`;
    console.log(`\n  RECOMMENDED: ${best.modelId} (${compStr}, ${best.dims}d)`);
  }

  // Save results
  if (saveResults && results.length > 0) {
    const dir = join(import.meta.dirname || __dirname, 'results');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `embed-bench_${ts}.json`;
    writeFileSync(join(dir, filename), JSON.stringify({
      timestamp: new Date().toISOString(),
      testPairs: SIMILARITY_PAIRS.length,
      clusterGroups: CLUSTER_GROUPS.length,
      retrievalQueries: RETRIEVAL_QUERIES.length,
      alignmentPairs: ALIGNMENT_PAIRS.length,
      results: results.map(r => ({
        modelId: r.modelId,
        dtype: r.dtype,
        dims: r.dims,
        accuracy: r.accuracy,
        composite: r.composite ? {
          overall: r.composite.overall,
          similarity: r.composite.similarity,
          retrieval: r.composite.retrieval,
          clustering: r.composite.clustering,
          alignment: r.composite.alignment,
        } : null,
        loadTimeMs: r.loadTimeMs,
        avgEmbedMs: r.avgEmbedMs,
        clusterResults: r.clusterResults,
        pairResults: r.pairResults.map(p => ({
          textA: p.pair.textA,
          textB: p.pair.textB,
          expected: p.pair.expected,
          cosine: p.cosine,
          passed: p.passed,
        })),
      })),
    }, null, 2));
    console.log(`\nResults saved to tests/visual/results/${filename}`);
  }
}

main().catch(e => {
  console.error('Embed bench failed:', e);
  process.exit(1);
});
