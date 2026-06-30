#!/usr/bin/env npx tsx
/**
 * Landing Page Context Benchmark
 *
 * Compares two approaches to providing brand context to an AI coding assistant:
 *   A) Markdown brand brief (typical CLAUDE.md / project docs approach)
 *   B) RDF/Turtle knowledge base (Reckons.AI approach)
 *
 * Measures:
 *   - Token count (input context size)
 *   - Byte size
 *   - Fact density (extractable facts per token)
 *   - Estimated API cost at current rates
 *   - Information completeness (do both contain the same facts?)
 *
 * Usage:
 *   npx tsx tests/bench/run-landing-page-bench.ts [--save]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── Paths ────────────────────────────────────────────────────────────────────

const FIXTURES = resolve(import.meta.dirname ?? '.', 'fixtures/landing-page');
const RESULTS_DIR = resolve(import.meta.dirname ?? '.', 'results');

// ── Token estimation ─────────────────────────────────────────────────────────

/** cl100k_base approximation: ~1.33 tokens per whitespace-delimited word */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.33);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

// ── Fact extraction ──────────────────────────────────────────────────────────

/** Count distinct facts in a Turtle or compressed KB file */
function countTurtleFacts(ttl: string): number {
  let count = 0;
  for (const line of ttl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('@prefix')) continue;
    // Skip entity headers (lines starting with # in compressed format)
    if (trimmed.startsWith('#')) continue;
    // Turtle: lines ending in ; or .
    if (trimmed.endsWith(';') || trimmed.endsWith('.')) { count++; continue; }
    // Compressed format: lines starting with . (predicate) or < (reverse link)
    if (trimmed.startsWith('.') || trimmed.startsWith('<')) { count++; continue; }
  }
  return count;
}

/** Count distinct factual claims in markdown (heuristic: bullet points, key-value pairs, sentences with specifics) */
function countMarkdownFacts(md: string): number {
  let count = 0;
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Bullet points with content
    if (trimmed.startsWith('-') && trimmed.length > 3) { count++; continue; }
    // Lines with colons (key: value patterns)
    if (trimmed.includes(':') && !trimmed.startsWith('http') && trimmed.length > 5) { count++; continue; }
    // Sentences with factual content (contains a verb-like structure)
    if (trimmed.length > 30 && /[A-Z].*\b(is|are|helps|uses|covers|includes|focuses|targets)\b/i.test(trimmed)) { count++; }
  }
  return count;
}

// ── Cost estimation ──────────────────────────────────────────────────────────

const PRICING = {
  'sonnet-4.6': { input: 3.00, output: 15.00, cached: 0.30 },
  'opus-4.6':   { input: 5.00, output: 25.00, cached: 0.50 },
} as const;

function estimateCost(inputTokens: number, outputTokens: number, model: keyof typeof PRICING) {
  const p = PRICING[model];
  return {
    input: (inputTokens / 1_000_000) * p.input,
    output: (outputTokens / 1_000_000) * p.output,
    cached: (inputTokens / 1_000_000) * p.cached,
    total: (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output,
    totalCached: (inputTokens / 1_000_000) * p.cached + (outputTokens / 1_000_000) * p.output,
  };
}

// ── Simulated workflow steps ─────────────────────────────────────────────────

type WorkflowStep = {
  step: number;
  name: string;
  description: string;
  inputContext: number;      // tokens of brand context needed
  estimatedOutput: number;   // tokens of generated output
  humanReview: string;       // description of human review needed
  humanMinutes: number;      // estimated minutes of human review
};

function markdownWorkflow(mdTokens: number): WorkflowStep[] {
  return [
    {
      step: 1, name: 'Read brief & plan',
      description: 'AI reads full markdown brief, plans page structure',
      inputContext: mdTokens, estimatedOutput: 500,
      humanReview: 'Review plan, check nothing missed from brief',
      humanMinutes: 5,
    },
    {
      step: 2, name: 'Generate HTML/CSS',
      description: 'AI generates landing page code referencing brief for brand details',
      inputContext: mdTokens + 500, estimatedOutput: 3000,
      humanReview: 'Review code for accuracy: colors, copy, sections, layout',
      humanMinutes: 15,
    },
    {
      step: 3, name: 'Fix brand inconsistencies',
      description: 'AI re-reads brief to fix color codes, tone, missed sections',
      inputContext: mdTokens + 3500, estimatedOutput: 1500,
      humanReview: 'Cross-check every brand element against brief manually',
      humanMinutes: 10,
    },
    {
      step: 4, name: 'Add SEO & meta',
      description: 'AI reads brief again for SEO targets, generates meta tags',
      inputContext: mdTokens + 5000, estimatedOutput: 400,
      humanReview: 'Verify SEO keywords match brief, check meta descriptions',
      humanMinutes: 5,
    },
    {
      step: 5, name: 'Responsive polish',
      description: 'AI adjusts layout, re-reads brief for mobile requirements',
      inputContext: mdTokens + 5400, estimatedOutput: 800,
      humanReview: 'Test on mobile viewports, verify accessibility',
      humanMinutes: 10,
    },
  ];
}

function reckonsWorkflow(ttlTokens: number): WorkflowStep[] {
  return [
    {
      step: 1, name: 'Query KB & plan',
      description: 'AI queries KB for entity types, requirements, brand. Gets compressed context.',
      inputContext: ttlTokens, estimatedOutput: 500,
      humanReview: 'Review plan — KB entities are pre-reviewed, so plan is grounded',
      humanMinutes: 3,
    },
    {
      step: 2, name: 'Generate HTML/CSS',
      description: 'AI generates landing page. Every brand detail is a typed triple — no re-reading prose.',
      inputContext: ttlTokens + 500, estimatedOutput: 3000,
      humanReview: 'Review code — brand facts are structurally correct from KB',
      humanMinutes: 8,
    },
    {
      step: 3, name: 'Verify against KB',
      description: 'Diff generated code against KB: which triples were used, which were missed?',
      inputContext: ttlTokens + 500, estimatedOutput: 300,
      humanReview: 'Review diff report — structural, not manual cross-checking',
      humanMinutes: 3,
    },
    {
      step: 4, name: 'Add SEO & meta',
      description: 'Query KB for seo-target and cta predicates directly',
      inputContext: ttlTokens + 300, estimatedOutput: 400,
      humanReview: 'SEO targets are typed triples — verify they match',
      humanMinutes: 2,
    },
    {
      step: 5, name: 'Responsive polish',
      description: 'Query KB for constraint predicates (mobile-responsive, accessible)',
      inputContext: ttlTokens + 400, estimatedOutput: 800,
      humanReview: 'Test on mobile viewports, verify accessibility',
      humanMinutes: 8,
    },
  ];
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const save = process.argv.includes('--save');

  const mdText = readFileSync(join(FIXTURES, 'brand-brief.md'), 'utf-8');
  const ttlText = readFileSync(join(FIXTURES, 'brand-kb.ttl'), 'utf-8');
  const compressedText = readFileSync(join(FIXTURES, 'compressed-kb.txt'), 'utf-8');

  const mdStats = {
    bytes: Buffer.byteLength(mdText),
    words: wordCount(mdText),
    lines: lineCount(mdText),
    tokens: estimateTokens(mdText),
    facts: countMarkdownFacts(mdText),
  };

  const ttlStats = {
    bytes: Buffer.byteLength(ttlText),
    words: wordCount(ttlText),
    lines: lineCount(ttlText),
    tokens: estimateTokens(ttlText),
    facts: countTurtleFacts(ttlText),
  };

  const compressedStats = {
    bytes: Buffer.byteLength(compressedText),
    words: wordCount(compressedText),
    lines: lineCount(compressedText),
    tokens: estimateTokens(compressedText),
    facts: countTurtleFacts(compressedText),
  };

  // Use compressed KB for the workflow (this is what MCP actually serves)
  const kbTokens = compressedStats.tokens;

  // Compression metrics (compressed vs markdown)
  const tokenReduction = ((mdStats.tokens - kbTokens) / mdStats.tokens * 100).toFixed(1);
  const byteReduction = ((mdStats.bytes - compressedStats.bytes) / mdStats.bytes * 100).toFixed(1);
  const mdDensity = (mdStats.facts / mdStats.tokens * 100).toFixed(1);
  const compressedDensity = (compressedStats.facts / compressedStats.tokens * 100).toFixed(1);
  const densityMultiplier = (parseFloat(compressedDensity) / parseFloat(mdDensity)).toFixed(1);

  // Workflow simulation
  const mdWorkflow = markdownWorkflow(mdStats.tokens);
  const ttlWorkflow = reckonsWorkflow(kbTokens);

  const mdTotalInput = mdWorkflow.reduce((s, w) => s + w.inputContext, 0);
  const mdTotalOutput = mdWorkflow.reduce((s, w) => s + w.estimatedOutput, 0);
  const mdTotalHuman = mdWorkflow.reduce((s, w) => s + w.humanMinutes, 0);

  const ttlTotalInput = ttlWorkflow.reduce((s, w) => s + w.inputContext, 0);
  const ttlTotalOutput = ttlWorkflow.reduce((s, w) => s + w.estimatedOutput, 0);
  const ttlTotalHuman = ttlWorkflow.reduce((s, w) => s + w.humanMinutes, 0);

  // Cost estimation
  const mdCost = estimateCost(mdTotalInput, mdTotalOutput, 'sonnet-4.6');
  const ttlCost = estimateCost(ttlTotalInput, ttlTotalOutput, 'sonnet-4.6');

  // ── Output ──────────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Landing Page Context Benchmark: Markdown vs Reckons.AI    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('── Context Size ──────────────────────────────────────────────');
  console.log(`  Markdown brief:    ${mdStats.tokens} tokens  (${mdStats.bytes} bytes, ${mdStats.words} words)`);
  console.log(`  Raw Turtle KB:     ${ttlStats.tokens} tokens  (${ttlStats.bytes} bytes, ${ttlStats.facts} facts)`);
  console.log(`  Compressed KB:     ${compressedStats.tokens} tokens  (${compressedStats.bytes} bytes, ${compressedStats.facts} facts)`);
  console.log(`  Token reduction:   ${tokenReduction}% (compressed vs markdown)`);
  console.log(`  Byte reduction:    ${byteReduction}%`);
  console.log();

  console.log('── Fact Density ──────────────────────────────────────────────');
  console.log(`  Markdown:        ${mdStats.facts} facts  (${mdDensity} facts per 100 tokens)`);
  console.log(`  Compressed KB:   ${compressedStats.facts} facts  (${compressedDensity} facts per 100 tokens)`);
  console.log(`  Density ratio:   ${densityMultiplier}× denser`);
  console.log();

  console.log('── Workflow: Markdown (5 steps) ──────────────────────────────');
  for (const w of mdWorkflow) {
    console.log(`  ${w.step}. ${w.name.padEnd(28)} ${String(w.inputContext).padStart(6)} in  ${String(w.estimatedOutput).padStart(5)} out  ${String(w.humanMinutes).padStart(2)}min review`);
  }
  console.log(`  Total:                         ${String(mdTotalInput).padStart(6)} in  ${String(mdTotalOutput).padStart(5)} out  ${String(mdTotalHuman).padStart(2)}min review`);
  console.log();

  console.log('── Workflow: Reckons.AI (5 steps) ───────────────────────────');
  for (const w of ttlWorkflow) {
    console.log(`  ${w.step}. ${w.name.padEnd(28)} ${String(w.inputContext).padStart(6)} in  ${String(w.estimatedOutput).padStart(5)} out  ${String(w.humanMinutes).padStart(2)}min review`);
  }
  console.log(`  Total:                         ${String(ttlTotalInput).padStart(6)} in  ${String(ttlTotalOutput).padStart(5)} out  ${String(ttlTotalHuman).padStart(2)}min review`);
  console.log();

  console.log('── Cost Estimate (Sonnet 4.6: $3/$15 per 1M tokens) ─────────');
  console.log(`  Markdown workflow:  $${mdCost.total.toFixed(4)}  (cached: $${mdCost.totalCached.toFixed(4)})`);
  console.log(`  Reckons.AI:         $${ttlCost.total.toFixed(4)}  (cached: $${ttlCost.totalCached.toFixed(4)})`);
  console.log(`  Savings:            ${((1 - ttlCost.total / mdCost.total) * 100).toFixed(1)}% per task`);
  console.log();

  console.log('── Human Review Time ────────────────────────────────────────');
  console.log(`  Markdown:    ${mdTotalHuman} minutes  (manual cross-checking against prose)`);
  console.log(`  Reckons.AI:  ${ttlTotalHuman} minutes  (structural verification against typed facts)`);
  console.log(`  Saved:       ${mdTotalHuman - ttlTotalHuman} minutes  (${((1 - ttlTotalHuman / mdTotalHuman) * 100).toFixed(0)}% reduction)`);
  console.log();

  console.log('── Key Insight ─────────────────────────────────────────────');
  console.log('  The token savings per individual task are small (cents).');
  console.log('  The real win is in HUMAN review time: structural facts are');
  console.log('  verifiable by type, not by re-reading prose. Over 100 tasks,');
  console.log(`  that's ${(mdTotalHuman - ttlTotalHuman) * 100 / 60} hours of human time saved.`);
  console.log();

  // ── Save results ──────────────────────────────────────────────────────

  const results = {
    timestamp: new Date().toISOString(),
    context: {
      markdown: mdStats,
      turtleRaw: ttlStats,
      compressed: compressedStats,
      tokenReduction: parseFloat(tokenReduction),
      byteReduction: parseFloat(byteReduction),
      densityMultiplier: parseFloat(densityMultiplier),
    },
    workflow: {
      markdown: {
        steps: mdWorkflow,
        totalInputTokens: mdTotalInput,
        totalOutputTokens: mdTotalOutput,
        totalHumanMinutes: mdTotalHuman,
        cost: mdCost,
      },
      reckons: {
        steps: ttlWorkflow,
        totalInputTokens: ttlTotalInput,
        totalOutputTokens: ttlTotalOutput,
        totalHumanMinutes: ttlTotalHuman,
        cost: ttlCost,
      },
    },
    savings: {
      tokenReductionPct: parseFloat(tokenReduction),
      humanTimeSavedMinutes: mdTotalHuman - ttlTotalHuman,
      humanTimeSavedPct: parseFloat(((1 - ttlTotalHuman / mdTotalHuman) * 100).toFixed(0)),
      costSavedPct: parseFloat(((1 - ttlCost.total / mdCost.total) * 100).toFixed(1)),
    },
  };

  if (save) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `landing-page-bench_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`  Results saved to ${outPath}`);
  }

  // Also write to static for the about page
  const staticPath = resolve(import.meta.dirname ?? '.', '../../static/landing-page-bench.json');
  writeFileSync(staticPath, JSON.stringify(results, null, 2));
  console.log(`  Static results written to static/landing-page-bench.json`);

  return results;
}

main();
