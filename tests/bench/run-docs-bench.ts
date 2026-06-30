#!/usr/bin/env npx tsx
/**
 * Documentation approach benchmark — TTL KB vs Markdown files.
 *
 * Measures token usage and query time for real development tasks when
 * retrieving context from TTL KBs (via MCP-style queries) vs reading
 * markdown files directly.
 *
 * Usage:
 *   npx tsx tests/bench/run-docs-bench.ts
 *   npx tsx tests/bench/run-docs-bench.ts --save
 *   npx tsx tests/bench/run-docs-bench.ts --verbose
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const SAVE = args.includes('--save');
const VERBOSE = args.includes('--verbose');

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const RESULTS_DIR = join(PROJECT_ROOT, 'tests/bench/results');

// Approximate token count (GPT/Claude tokenizers average ~4 chars/token for English)
function countTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

// ── Simulated tasks that a developer would ask Claude Code ───────────────────

interface BenchTask {
  id: string;
  description: string;
  // Which markdown files would Claude read to answer this?
  markdownFiles: string[];
  // What MCP queries would retrieve the same info?
  ttlQueries: { kb: string; query: string }[];
  // What TTL files to search directly (simulating kb_search results)
  ttlFiles: string[];
}

const TASKS: BenchTask[] = [
  {
    id: 'n8n-integration',
    description: 'How does the n8n cloud sync work? What are the webhook endpoints and data tables?',
    markdownFiles: ['docs/N8N_INTEGRATION.md'],
    ttlQueries: [
      { kb: 'features', query: 'n8n cloud sync webhook' },
      { kb: 'integrations', query: 'n8n source monitor data table' },
    ],
    ttlFiles: ['static/docs-integrations-tech.ttl', 'static/docs-features.ttl'],
  },
  {
    id: 'enterprise-design',
    description: 'What is the enterprise roadmap? What are the RBAC phases?',
    markdownFiles: ['docs/ENTERPRISE.md'],
    ttlQueries: [
      { kb: 'roadmap', query: 'enterprise RBAC auth policy' },
      { kb: 'features', query: 'enterprise people policy procedure' },
    ],
    ttlFiles: ['static/reckons-roadmap.ttl', 'static/docs-features.ttl'],
  },
  {
    id: 'confluence-migration',
    description: 'How does the Confluence migration work? Chunking strategy and local model recommendations?',
    markdownFiles: ['docs/CONFLUENCE_MIGRATION.md'],
    ttlQueries: [
      { kb: 'roadmap', query: 'confluence migration chunking' },
      { kb: 'features', query: 'confluence text chunking sliding window' },
    ],
    ttlFiles: ['static/reckons-roadmap.ttl', 'static/docs-features.ttl'],
  },
  {
    id: 'style-guide',
    description: 'What CSS variables and z-index values should I use? What are the brand colors?',
    markdownFiles: ['docs/STYLE_GUIDE.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'style conventions CSS variables z-index' },
    ],
    ttlFiles: ['static/docs-architecture.ttl'],
  },
  {
    id: 'security-model',
    description: 'How does the security model work? CSP, API key safety, content safety?',
    markdownFiles: ['docs/SECURITY.md'],
    ttlQueries: [
      { kb: 'tips-security', query: 'security CSP API key content safety' },
      { kb: 'features', query: 'content safety ethics preamble' },
    ],
    ttlFiles: ['static/docs-tips-security.ttl', 'static/docs-features.ttl'],
  },
  {
    id: 'vscode-extension',
    description: 'What is the VS Code extension design? MCP bridge, phases?',
    markdownFiles: ['docs/VSCODE_EXTENSION.md'],
    ttlQueries: [
      { kb: 'roadmap', query: 'vscode extension MCP bridge' },
      { kb: 'integrations', query: 'VS Code extension phases' },
    ],
    ttlFiles: ['static/reckons-roadmap.ttl', 'static/docs-integrations-tech.ttl'],
  },
  {
    id: 'mobile-setup',
    description: 'How do I run Reckons.AI on a local server and access from mobile?',
    markdownFiles: ['docs/MOBILE_LOCAL_SERVER.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'mobile access local server QR code' },
      { kb: 'integrations', query: 'mobile deployment Ollama' },
    ],
    ttlFiles: ['static/docs-architecture.ttl', 'static/docs-integrations-tech.ttl'],
  },
  {
    id: 'model-training',
    description: 'What is the model training plan? Fine-tuning phases?',
    markdownFiles: ['docs/MODEL_TRAINING.md'],
    ttlQueries: [
      { kb: 'roadmap', query: 'model training fine-tuning LoRA' },
    ],
    ttlFiles: ['static/reckons-roadmap.ttl'],
  },
  {
    id: 'dependency-health',
    description: 'What is the dependency health status? Any abandoned packages?',
    markdownFiles: ['docs/DEPENDENCIES.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'dependency health packages' },
      { kb: 'production', query: 'tech stack dependencies versions' },
    ],
    ttlFiles: ['static/docs-architecture.ttl', 'static/reckons-production.ttl'],
  },
  {
    id: 'prov-o-alignment',
    description: 'How does the project align with PROV-O? Custom namespace decisions?',
    markdownFiles: ['docs/PROV_O_ALIGNMENT.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'PROV-O alignment namespace vocabulary' },
    ],
    ttlFiles: ['static/docs-architecture.ttl'],
  },
  {
    id: 'user-stories',
    description: 'What are the collaborative use cases? Shared knowledge scenarios?',
    markdownFiles: ['docs/USER_STORIES.md'],
    ttlQueries: [
      { kb: 'use-cases', query: 'collaborative shared knowledge reckoning' },
    ],
    ttlFiles: ['static/docs-use-cases.ttl'],
  },
  {
    id: 'local-home-folder',
    description: 'How does the workspace folder sync work? File structure?',
    markdownFiles: ['docs/LOCAL_HOME_FOLDER.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'workspace folder sync file structure' },
      { kb: 'integrations', query: 'workspace sync pending JSONL' },
    ],
    ttlFiles: ['static/docs-architecture.ttl', 'static/docs-integrations-tech.ttl'],
  },
  {
    id: 'mobile-capture',
    description: 'How does async voice capture work for mobile?',
    markdownFiles: ['docs/MOBILE_CAPTURE.md'],
    ttlQueries: [
      { kb: 'architecture', query: 'mobile voice capture webhook' },
    ],
    ttlFiles: ['static/docs-architecture.ttl'],
  },
  {
    id: 'full-guide',
    description: 'Give me a complete overview of all features and how to use the app',
    markdownFiles: ['docs/GUIDE.md'],
    ttlQueries: [
      { kb: 'features', query: 'ingest review graph compare multi-KB' },
      { kb: 'integrations', query: 'MCP browser extension calendar' },
    ],
    ttlFiles: ['static/docs-features.ttl', 'static/docs-integrations-tech.ttl'],
  },
  {
    id: 'multi-task-broad',
    description: 'I need to add a new integration. What are the conventions, existing integrations, roadmap status, and test patterns?',
    markdownFiles: ['docs/GUIDE.md', 'docs/STYLE_GUIDE.md', 'docs/DEPENDENCIES.md'],
    ttlQueries: [
      { kb: 'integrations', query: 'integration conventions patterns' },
      { kb: 'roadmap', query: 'integration planned status' },
      { kb: 'production', query: 'test suite patterns' },
      { kb: 'architecture', query: 'style conventions dependencies' },
    ],
    ttlFiles: ['static/docs-integrations-tech.ttl', 'static/reckons-roadmap.ttl', 'static/reckons-production.ttl', 'static/docs-architecture.ttl'],
  },
];

// ── BM25 search simulation ──────────────────────────────────────────────────

interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

function parseTtlSimple(text: string): Triple[] {
  const triples: Triple[] = [];
  const prefixes: Record<string, string> = {};

  const resolveIRI = (term: string): string => {
    term = term.trim();
    if (term.startsWith('<') && term.endsWith('>')) return term.slice(1, -1);
    const colon = term.indexOf(':');
    if (colon > 0) {
      const prefix = term.slice(0, colon);
      const local = term.slice(colon + 1);
      if (prefixes[prefix]) return prefixes[prefix] + local;
    }
    return term;
  };

  let currentSubject = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const pfxMatch = line.match(/^@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\.$/);
    if (pfxMatch) { prefixes[pfxMatch[1]] = pfxMatch[2]; continue; }

    if (line.startsWith('<urn:reckons:kb>')) continue;

    // Extract subject
    const subjMatch = line.match(/^([a-zA-Z][\w-]*:[a-zA-Z][\w-]*)\s/);
    if (subjMatch) currentSubject = resolveIRI(subjMatch[1]);

    // Extract predicate-object pairs
    const poPattern = /([a-zA-Z][\w-]*:[a-zA-Z][\w/.-]*)\s+("(?:[^"\\]|\\.)*"|[a-zA-Z][\w-]*:[a-zA-Z][\w/.-]*|<[^>]+>)/g;
    let match;
    while ((match = poPattern.exec(line)) !== null) {
      const pred = resolveIRI(match[1]);
      let obj = match[2].trim();
      if (obj.startsWith('"')) {
        const litMatch = obj.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (litMatch) obj = litMatch[1];
      } else {
        obj = resolveIRI(obj);
      }
      if (currentSubject) triples.push({ subject: currentSubject, predicate: pred, object: obj });
    }
  }
  return triples;
}

// BM25 search over triples — returns matching triple text
function bm25Search(triples: Triple[], query: string, topK: number = 10): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];

  const N = triples.length;
  const avgDl = triples.reduce((sum, t) => sum + (t.subject + t.predicate + t.object).length, 0) / Math.max(N, 1);

  // Document frequency
  const df: Record<string, number> = {};
  for (const t of triples) {
    const doc = (t.subject + ' ' + t.predicate + ' ' + t.object).toLowerCase();
    const seen = new Set<string>();
    for (const term of terms) {
      if (doc.includes(term) && !seen.has(term)) {
        df[term] = (df[term] ?? 0) + 1;
        seen.add(term);
      }
    }
  }

  // Score each triple
  const scored = triples.map(t => {
    const doc = (t.subject + ' ' + t.predicate + ' ' + t.object).toLowerCase();
    const dl = doc.length;
    let score = 0;
    for (const term of terms) {
      const tf = (doc.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) ?? []).length;
      const idf = Math.log((N - (df[term] ?? 0) + 0.5) / ((df[term] ?? 0) + 0.5) + 1);
      score += idf * (tf * 2.0) / (tf + 1.2 * (1 - 0.75 + 0.75 * dl / avgDl));
    }
    return { triple: t, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter(s => s.score > 0)
    .slice(0, topK)
    .map(s => {
      const label = s.triple.predicate.split('/').pop() ?? s.triple.predicate;
      return `${s.triple.subject.split('/').pop()} → ${label} → ${s.triple.object.slice(0, 200)}`;
    });
}

// ── Benchmark runner ─────────────────────────────────────────────────────────

interface TaskResult {
  id: string;
  description: string;
  markdown: {
    tokens: number;
    bytes: number;
    filesRead: number;
    timeMs: number;
  };
  ttl: {
    tokens: number;
    bytes: number;
    queriesRun: number;
    resultsReturned: number;
    timeMs: number;
  };
  savings: {
    tokenReduction: number; // percentage
    bytesReduction: number;
    ratio: string; // e.g., "3.2x"
  };
}

function runBenchmark(): TaskResult[] {
  const results: TaskResult[] = [];

  for (const task of TASKS) {
    // ── Markdown approach: read entire file(s) ──
    const mdStart = performance.now();
    let mdContent = '';
    let mdFilesRead = 0;
    for (const file of task.markdownFiles) {
      const fullPath = join(PROJECT_ROOT, file);
      if (existsSync(fullPath)) {
        mdContent += readFileSync(fullPath, 'utf8') + '\n';
        mdFilesRead++;
      }
    }
    const mdTime = performance.now() - mdStart;
    const mdTokens = countTokens(mdContent);
    const mdBytes = Buffer.byteLength(mdContent, 'utf8');

    // ── TTL approach: search relevant KBs and return results ──
    const ttlStart = performance.now();
    let ttlContent = '';
    let totalResults = 0;

    for (const q of task.ttlQueries) {
      // Find the TTL file for this KB
      const kbMap: Record<string, string> = {
        'roadmap': 'static/reckons-roadmap.ttl',
        'production': 'static/reckons-production.ttl',
        'features': 'static/docs-features.ttl',
        'architecture': 'static/docs-architecture.ttl',
        'integrations': 'static/docs-integrations-tech.ttl',
        'use-cases': 'static/docs-use-cases.ttl',
        'tips-security': 'static/docs-tips-security.ttl',
        'testing': 'static/docs-testing.ttl',
      };

      const ttlFile = kbMap[q.kb];
      if (!ttlFile) continue;

      const fullPath = join(PROJECT_ROOT, ttlFile);
      if (!existsSync(fullPath)) continue;

      const ttlText = readFileSync(fullPath, 'utf8');
      const triples = parseTtlSimple(ttlText);
      const hits = bm25Search(triples, q.query, 8);
      totalResults += hits.length;
      ttlContent += hits.join('\n') + '\n';
    }
    const ttlTime = performance.now() - ttlStart;
    const ttlTokens = countTokens(ttlContent);
    const ttlBytes = Buffer.byteLength(ttlContent, 'utf8');

    const tokenReduction = mdTokens > 0 ? ((mdTokens - ttlTokens) / mdTokens) * 100 : 0;
    const ratio = ttlTokens > 0 ? (mdTokens / ttlTokens).toFixed(1) : '∞';

    results.push({
      id: task.id,
      description: task.description,
      markdown: { tokens: mdTokens, bytes: mdBytes, filesRead: mdFilesRead, timeMs: Math.round(mdTime * 100) / 100 },
      ttl: { tokens: ttlTokens, bytes: ttlBytes, queriesRun: task.ttlQueries.length, resultsReturned: totalResults, timeMs: Math.round(ttlTime * 100) / 100 },
      savings: { tokenReduction: Math.round(tokenReduction * 10) / 10, bytesReduction: mdBytes - ttlBytes, ratio: `${ratio}x` },
    });
  }

  return results;
}

// ── kb_compress simulation ───────────────────────────────────────────────────
// Simulates what kb_compress does: BM25 → entity subgraph → compact format

function runCompressBenchmark(): { id: string; mdTokens: number; compressedTokens: number; reduction: number }[] {
  const results: { id: string; mdTokens: number; compressedTokens: number; reduction: number }[] = [];

  for (const task of TASKS) {
    // Markdown tokens
    let mdContent = '';
    for (const file of task.markdownFiles) {
      const fullPath = join(PROJECT_ROOT, file);
      if (existsSync(fullPath)) mdContent += readFileSync(fullPath, 'utf8') + '\n';
    }
    const mdTokens = countTokens(mdContent);

    // Compressed: simulate entity-grouped format with budget
    let compressed = '';
    for (const q of task.ttlQueries) {
      const kbMap: Record<string, string> = {
        'roadmap': 'static/reckons-roadmap.ttl',
        'production': 'static/reckons-production.ttl',
        'features': 'static/docs-features.ttl',
        'architecture': 'static/docs-architecture.ttl',
        'integrations': 'static/docs-integrations-tech.ttl',
        'use-cases': 'static/docs-use-cases.ttl',
        'tips-security': 'static/docs-tips-security.ttl',
        'testing': 'static/docs-testing.ttl',
      };

      const ttlFile = kbMap[q.kb];
      if (!ttlFile) continue;

      const fullPath = join(PROJECT_ROOT, ttlFile);
      if (!existsSync(fullPath)) continue;

      const ttlText = readFileSync(fullPath, 'utf8');
      const triples = parseTtlSimple(ttlText);
      const hits = bm25Search(triples, q.query, 6);

      // Entity-grouped compact format (similar to kb_compress output)
      const entities = new Map<string, string[]>();
      for (const hit of hits) {
        const parts = hit.split(' → ');
        const entity = parts[0] ?? 'unknown';
        const rest = parts.slice(1).join(' → ');
        if (!entities.has(entity)) entities.set(entity, []);
        entities.get(entity)!.push(rest);
      }

      for (const [entity, facts] of entities) {
        compressed += `[${entity}]\n`;
        for (const fact of facts) compressed += `  ${fact}\n`;
      }
    }

    const compressedTokens = countTokens(compressed);
    const reduction = mdTokens > 0 ? ((mdTokens - compressedTokens) / mdTokens) * 100 : 0;
    results.push({ id: task.id, mdTokens, compressedTokens, reduction: Math.round(reduction * 10) / 10 });
  }

  return results;
}

// ── Report ───────────────────────────────────────────────────────────────────

function printReport(results: TaskResult[], compressResults: ReturnType<typeof runCompressBenchmark>) {
  console.log('\n  ═══════════════════════════════════════════════════════════════');
  console.log('  Documentation Benchmark: TTL KB vs Markdown');
  console.log('  ═══════════════════════════════════════════════════════════════\n');

  // Summary table
  console.log('  Task                        │ MD tokens │ TTL tokens │ Reduction │ Ratio');
  console.log('  ────────────────────────────┼───────────┼────────────┼───────────┼──────');

  let totalMdTokens = 0;
  let totalTtlTokens = 0;
  let totalCompressedTokens = 0;

  for (const r of results) {
    const name = r.id.padEnd(28);
    const md = String(r.markdown.tokens).padStart(9);
    const ttl = String(r.ttl.tokens).padStart(10);
    const red = `${r.savings.tokenReduction}%`.padStart(9);
    const ratio = r.savings.ratio.padStart(5);
    console.log(`  ${name}│ ${md} │ ${ttl} │ ${red} │ ${ratio}`);

    totalMdTokens += r.markdown.tokens;
    totalTtlTokens += r.ttl.tokens;
  }

  for (const c of compressResults) {
    totalCompressedTokens += c.compressedTokens;
  }

  const totalReduction = ((totalMdTokens - totalTtlTokens) / totalMdTokens * 100).toFixed(1);
  const totalRatio = (totalMdTokens / Math.max(totalTtlTokens, 1)).toFixed(1);

  console.log('  ────────────────────────────┼───────────┼────────────┼───────────┼──────');
  console.log(`  ${'TOTAL'.padEnd(28)}│ ${String(totalMdTokens).padStart(9)} │ ${String(totalTtlTokens).padStart(10)} │ ${(totalReduction + '%').padStart(9)} │ ${(totalRatio + 'x').padStart(5)}`);

  // Compressed comparison
  console.log('\n\n  ─── With kb_compress (entity-grouped format) ───────────────────\n');
  console.log('  Task                        │ MD tokens │ Compressed │ Reduction');
  console.log('  ────────────────────────────┼───────────┼────────────┼──────────');

  for (const c of compressResults) {
    const name = c.id.padEnd(28);
    console.log(`  ${name}│ ${String(c.mdTokens).padStart(9)} │ ${String(c.compressedTokens).padStart(10)} │ ${(c.reduction + '%').padStart(8)}`);
  }

  const compressReduction = ((totalMdTokens - totalCompressedTokens) / totalMdTokens * 100).toFixed(1);
  const compressRatio = (totalMdTokens / Math.max(totalCompressedTokens, 1)).toFixed(1);

  console.log('  ────────────────────────────┼───────────┼────────────┼──────────');
  console.log(`  ${'TOTAL'.padEnd(28)}│ ${String(totalMdTokens).padStart(9)} │ ${String(totalCompressedTokens).padStart(10)} │ ${(compressReduction + '%').padStart(8)}`);

  // Timing
  console.log('\n\n  ─── Query Timing ──────────────────────────────────────────────\n');
  console.log('  Task                        │ MD read ms │ TTL search ms │ Speedup');
  console.log('  ────────────────────────────┼────────────┼───────────────┼────────');

  let totalMdTime = 0;
  let totalTtlTime = 0;

  for (const r of results) {
    const name = r.id.padEnd(28);
    const mdMs = r.markdown.timeMs.toFixed(2).padStart(10);
    const ttlMs = r.ttl.timeMs.toFixed(2).padStart(13);
    // TTL search includes parsing, so compare fairly
    const speedup = r.ttl.timeMs > 0 ? (r.markdown.timeMs / r.ttl.timeMs).toFixed(1) : 'n/a';
    console.log(`  ${name}│ ${mdMs} │ ${ttlMs} │ ${speedup.padStart(6)}x`);
    totalMdTime += r.markdown.timeMs;
    totalTtlTime += r.ttl.timeMs;
  }

  // File size comparison
  console.log('\n\n  ─── File Size Comparison ──────────────────────────────────────\n');

  const mdDir = join(PROJECT_ROOT, 'docs');
  const mdFiles = existsSync(mdDir) ? readdirSync(mdDir).filter(f => f.endsWith('.md')) : [];
  let totalMdBytes = 0;
  for (const f of mdFiles) {
    totalMdBytes += readFileSync(join(mdDir, f)).byteLength;
  }

  const ttlFiles = [
    'static/docs-features.ttl', 'static/docs-integrations-tech.ttl', 'static/docs-architecture.ttl',
    'static/docs-use-cases.ttl', 'static/docs-tips-security.ttl', 'static/docs-llm.ttl',
    'static/docs-triples-rdf.ttl', 'static/docs-timeline-ecosystem.ttl',
    'static/reckons-roadmap.ttl', 'static/reckons-production.ttl',
    'static/starter-guide.ttl',
  ];
  let totalTtlBytes = 0;
  for (const f of ttlFiles) {
    const fp = join(PROJECT_ROOT, f);
    if (existsSync(fp)) totalTtlBytes += readFileSync(fp).byteLength;
  }

  console.log(`  Markdown docs (docs/*.md):      ${mdFiles.length} files, ${(totalMdBytes / 1024).toFixed(1)} KB`);
  console.log(`  TTL KBs (static/*.ttl):          ${ttlFiles.length} files, ${(totalTtlBytes / 1024).toFixed(1)} KB`);
  console.log(`  TTL carries more info (features, roadmap, production) while using structured format`);

  // Summary
  console.log('\n\n  ═══ Summary ═══════════════════════════════════════════════════\n');
  console.log(`  BM25 search approach:     ${totalReduction}% token reduction (${totalRatio}x less context)`);
  console.log(`  kb_compress approach:      ${compressReduction}% token reduction (${compressRatio}x less context)`);
  console.log(`  Tasks benchmarked:         ${results.length}`);
  console.log(`  Total MD tokens (all tasks): ${totalMdTokens.toLocaleString()}`);
  console.log(`  Total TTL tokens (search):   ${totalTtlTokens.toLocaleString()}`);
  console.log(`  Total TTL tokens (compress): ${totalCompressedTokens.toLocaleString()}`);
  console.log('');

  return {
    totalMdTokens,
    totalTtlTokens,
    totalCompressedTokens,
    tokenReductionSearch: parseFloat(totalReduction),
    tokenReductionCompress: parseFloat(compressReduction),
    ratioSearch: parseFloat(totalRatio),
    ratioCompress: parseFloat(compressRatio),
    taskCount: results.length,
    results,
    compressResults,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const results = runBenchmark();
const compressResults = runCompressBenchmark();
const summary = printReport(results, compressResults);

if (VERBOSE) {
  console.log('\n  ─── Detailed per-task results ─────────────────────────────────\n');
  for (const r of results) {
    console.log(`  ${r.id}: ${r.description}`);
    console.log(`    MD: ${r.markdown.tokens} tokens from ${r.markdown.filesRead} file(s) in ${r.markdown.timeMs}ms`);
    console.log(`    TTL: ${r.ttl.tokens} tokens from ${r.ttl.queriesRun} queries (${r.ttl.resultsReturned} results) in ${r.ttl.timeMs}ms`);
    console.log(`    Savings: ${r.savings.tokenReduction}% (${r.savings.ratio})`);
    console.log('');
  }
}

if (SAVE) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const outPath = join(RESULTS_DIR, `docs-bench_${ts}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`  Saved: ${outPath}\n`);
}
