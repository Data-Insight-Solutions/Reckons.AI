#!/usr/bin/env npx tsx
/**
 * Compression Benchmark — measures context compression ratios for the /why page.
 *
 * For each fixture document:
 *   1. Reads source text → measures bytes, words, tokens (whitespace approx)
 *   2. Reads golden triples → serialises to compact Turtle
 *   3. Computes: byte reduction %, token reduction %, fact density (facts per 100 source tokens)
 *
 * Output: JSON results + console summary table.
 *
 * Usage:
 *   npx tsx tests/bench/run-compression-bench.ts [--save]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── Paths ────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = resolve(import.meta.dirname ?? '.', 'fixtures/why');
const RESULTS_DIR = resolve(import.meta.dirname ?? '.', 'results');

const CATEGORIES = ['literature', 'encyclopedia', 'news', 'biography', 'recipe', 'code', 'research'] as const;

// ── Token estimation ─────────────────────────────────────────────────────────

/** Rough token count — whitespace split with sub-word heuristic (GPT-like ~1.3 tokens/word) */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.33);
}

/** Word count */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Turtle serialiser (standalone, no browser deps) ──────────────────────────

type Triple = { subject: string; predicate: string; object: string };

function triplesToTurtle(triples: Triple[], prefix: string): string {
  const lines: string[] = [`@prefix : <reckons:${prefix}#> .`];

  // Group by subject
  const groups = new Map<string, Triple[]>();
  for (const t of triples) {
    const list = groups.get(t.subject) ?? [];
    list.push(t);
    groups.set(t.subject, list);
  }

  for (const [subject, ts] of groups) {
    const preds = ts.map((t, i) => {
      const end = i === ts.length - 1 ? ' .' : ' ;';
      const obj = /^[\d.]+$/.test(t.object) ? t.object : `"${t.object}"`;
      return `  :${t.predicate} ${obj}${end}`;
    });
    lines.push(`\n:${subject}`);
    lines.push(...preds);
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface CategoryResult {
  category: string;
  label: string;
  source: {
    bytes: number;
    words: number;
    tokens: number;
  };
  triples: {
    count: number;
    turtleBytes: number;
    turtleTokens: number;
  };
  compression: {
    byteReduction: number;    // e.g. -0.53 = 53% smaller
    tokenReduction: number;
    factDensity: number;       // facts per 100 source tokens
    densityMultiplier: number; // e.g. 1.8×
  };
}

function run(): CategoryResult[] {
  const golden = JSON.parse(readFileSync(join(FIXTURES_DIR, 'golden.json'), 'utf8'));
  const results: CategoryResult[] = [];

  for (const cat of CATEGORIES) {
    const sourceText = readFileSync(join(FIXTURES_DIR, `${cat}.txt`), 'utf8');
    const entry = golden[cat];
    if (!entry) {
      console.warn(`No golden entry for ${cat}`);
      continue;
    }

    const triples: Triple[] = entry.triples;
    const turtle = triplesToTurtle(triples, cat);

    const sourceBytes = Buffer.byteLength(sourceText, 'utf8');
    const sourceWords = wordCount(sourceText);
    const sourceTokens = estimateTokens(sourceText);

    const turtleBytes = Buffer.byteLength(turtle, 'utf8');
    const turtleTokens = estimateTokens(turtle);

    const byteReduction = -(1 - turtleBytes / sourceBytes);
    const tokenReduction = -(1 - turtleTokens / sourceTokens);

    // Fact density: (facts / source tokens) vs (facts / turtle tokens)
    const sourceDensity = triples.length / sourceTokens * 100;
    const turtleDensity = triples.length / turtleTokens * 100;
    const densityMultiplier = turtleDensity / sourceDensity;

    results.push({
      category: entry.category,
      label: entry.label,
      source: { bytes: sourceBytes, words: sourceWords, tokens: sourceTokens },
      triples: { count: triples.length, turtleBytes, turtleTokens },
      compression: {
        byteReduction: Math.round(byteReduction * 100),
        tokenReduction: Math.round(tokenReduction * 100),
        factDensity: Math.round(sourceDensity * 10) / 10,
        densityMultiplier: Math.round(densityMultiplier * 10) / 10,
      },
    });
  }

  return results;
}

// ── Output ───────────────────────────────────────────────────────────────────

const results = run();

// Console table
console.log('\n  Category          Label                      Bytes   Tokens  Triples  Turtle   Byte%   Token%  Density');
console.log('  ─'.repeat(6));
for (const r of results) {
  const cat = r.category.padEnd(18);
  const label = r.label.padEnd(27);
  const src = String(r.source.bytes).padStart(5);
  const tok = String(r.source.tokens).padStart(6);
  const tri = String(r.triples.count).padStart(5);
  const ttl = String(r.triples.turtleBytes).padStart(6);
  const byteP = `${r.compression.byteReduction}%`.padStart(6);
  const tokP = `${r.compression.tokenReduction}%`.padStart(7);
  const dens = `${r.compression.densityMultiplier}×`.padStart(5);
  console.log(`  ${cat}${label}${src}${tok}${tri}${ttl}${byteP}${tokP}  ${dens}`);
}

// Averages
const avg = {
  byteReduction: Math.round(results.reduce((s, r) => s + r.compression.byteReduction, 0) / results.length),
  tokenReduction: Math.round(results.reduce((s, r) => s + r.compression.tokenReduction, 0) / results.length),
  densityMultiplier: Math.round(results.reduce((s, r) => s + r.compression.densityMultiplier, 0) / results.length * 10) / 10,
};
console.log(`\n  Average: ${avg.byteReduction}% bytes, ${avg.tokenReduction}% tokens, ${avg.densityMultiplier}× denser\n`);

// Save results
const shouldSave = process.argv.includes('--save');
const report = {
  timestamp: new Date().toISOString(),
  categories: results,
  averages: avg,
};

if (shouldSave) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `compression_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const outPath = join(RESULTS_DIR, filename);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  Saved: ${outPath}\n`);
}

// Always write latest to a stable path for the /why page
const latestPath = join(RESULTS_DIR, 'compression-latest.json');
writeFileSync(latestPath, JSON.stringify(report, null, 2));
console.log(`  Latest: ${latestPath}\n`);
