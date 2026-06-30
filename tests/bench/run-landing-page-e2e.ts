#!/usr/bin/env npx tsx
/**
 * Landing Page E2E Generation Benchmark
 *
 * Sends the compressed brand KB to an LLM and asks it to generate a complete
 * landing page HTML. Scores the output against golden criteria extracted from
 * the KB: brand accuracy, service coverage, structural validity, SEO, and
 * hallucination detection.
 *
 * This is the real workflow described in the case study — not a static analysis.
 * Run it with different models to compare quality over time.
 *
 * Usage:
 *   npx tsx tests/bench/run-landing-page-e2e.ts                      # run with all Ollama models
 *   npx tsx tests/bench/run-landing-page-e2e.ts --model llama3.2:3b  # specific model
 *   npx tsx tests/bench/run-landing-page-e2e.ts --save               # persist results
 *   npx tsx tests/bench/run-landing-page-e2e.ts --list               # show available models
 *   npx tsx tests/bench/run-landing-page-e2e.ts --url http://host:11434
 *   npx tsx tests/bench/run-landing-page-e2e.ts --out-dir ./output   # save generated HTML
 *   npx tsx tests/bench/run-landing-page-e2e.ts --visual             # add visual rendering score
 *   npx tsx tests/bench/run-landing-page-e2e.ts --visual --screenshots ./shots
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scoreVisual, closeBrowser, type VisualScore, type VisualScoreOptions } from './landing-visual-score';

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');
const listOnly = args.includes('--list');
const enableVisual = args.includes('--visual');

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function parseModels(): string[] {
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) models.push(args[++i]);
  }
  return models;
}

const OLLAMA_URL = getArg('--url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434');
const requestedModels = parseModels();
const OUTPUT_DIR = getArg('--out-dir', '');
const SCREENSHOT_DIR = getArg('--screenshots', '');

// ── Visual scoring config ───────────────────────────────────────────────────

const VISUAL_OPTS: Omit<VisualScoreOptions, 'screenshotPath'> = {
  brandColors: [
    { id: 'primary', hex: '#1a2332', weight: 1.0 },
    { id: 'accent', hex: '#1a9b8e', weight: 1.0 },
  ],
  expectedText: [
    { id: 'company-name', text: 'Data Insight Solutions', weight: 1.0 },
    { id: 'tagline', text: 'Transform data into actionable insights', weight: 1.0 },
    { id: 'service-collect', text: 'Collect', weight: 0.5 },
    { id: 'service-automate', text: 'Automate', weight: 0.5 },
    { id: 'service-integrate', text: 'Integrate', weight: 0.5 },
    { id: 'service-display', text: 'Display', weight: 0.5 },
    { id: 'cta', text: 'Schedule a consultation', weight: 0.75 },
  ],
};

// ── Paths ───────────────────────────────────────────────────────────────────

const BENCH_DIR = resolve(import.meta.dirname ?? '.', '.');
const FIXTURES_DIR = join(BENCH_DIR, 'fixtures');
const RESULTS_DIR = join(BENCH_DIR, 'results');

const compressedKb = readFileSync(join(FIXTURES_DIR, 'landing-page', 'compressed-kb.txt'), 'utf-8');
const goldenCriteria = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'golden', 'landing-page-e2e.json'), 'utf-8')
);

// ── Token estimation ────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.33);
}

// ── Ollama API ──────────────────────────────────────────────────────────────

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

function isChatModel(m: OllamaModel): boolean {
  const name = m.name.toLowerCase();
  const family = m.details?.family ?? '';
  if (name.includes('embed') || name.includes('nomic-embed')) return false;
  if (family === 'nomic-bert' || family === 'bert') return false;
  return true;
}

async function chatOllama(
  system: string,
  user: string,
  model: string,
  maxTokens = 4096
): Promise<{ text: string; elapsed: number }> {
  const start = Date.now();
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
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
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, elapsed: Date.now() - start };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior front-end developer. You generate complete, production-ready, single-file HTML landing pages.

Rules:
1. Output ONLY valid HTML. No markdown, no explanation, no commentary.
2. The HTML must be a complete document: <!DOCTYPE html>, <html>, <head>, <body>.
3. All CSS must be inline in a <style> tag — no external stylesheets.
4. Use the exact brand colours, typography, and content from the KB provided.
5. Every service, section, and CTA specified in the KB must appear in the page.
6. Include a <meta name="viewport"> tag for responsive design.
7. Include <meta name="description"> using the company tagline.
8. Include SEO keywords from the KB in appropriate meta tags or headings.
9. Do not use placeholder text (no "lorem ipsum", no "TODO").
10. Do not reference external images — use CSS shapes, gradients, or Unicode icons.
11. The page must be visually complete and ready to open in a browser.`;

function buildUserPrompt(kb: string): string {
  return `Generate a complete landing page HTML for the following brand. Use ONLY the facts provided in this knowledge base — do not invent additional information.

BRAND KNOWLEDGE BASE:
${kb}

Generate the complete HTML now.`;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

interface CheckResult {
  id: string;
  found: boolean;
  weight: number;
}

interface CategoryScore {
  category: string;
  score: number;
  maxScore: number;
  pct: number;
  checks: CheckResult[];
}

interface E2EScore {
  model: string;
  timestamp: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  outputBytes: number;
  categories: CategoryScore[];
  penalties: { id: string; found: boolean; penalty: number }[];
  penaltyTotal: number;
  rawScore: number;
  finalScore: number;
  htmlPreview: string;
  visual?: VisualScore;
}

function checkPattern(html: string, item: { pattern?: string; patterns?: string[]; matchAny?: boolean }): boolean {
  const lower = html.toLowerCase();
  if (item.patterns && item.matchAny) {
    return item.patterns.some(p => lower.includes(p.toLowerCase()));
  }
  if (item.patterns) {
    return item.patterns.every(p => lower.includes(p.toLowerCase()));
  }
  if (item.pattern) {
    return lower.includes(item.pattern.toLowerCase());
  }
  return false;
}

function scoreCategory(html: string, categoryName: string, criteria: { mustContain: any[] }): CategoryScore {
  const checks: CheckResult[] = [];
  let score = 0;
  let maxScore = 0;

  for (const item of criteria.mustContain) {
    const found = checkPattern(html, item);
    const weight = item.weight ?? 1.0;
    checks.push({ id: item.id, found, weight });
    maxScore += weight;
    if (found) score += weight;
  }

  return {
    category: categoryName,
    score,
    maxScore,
    pct: maxScore > 0 ? score / maxScore : 1,
    checks
  };
}

function scoreHtml(html: string, model: string, elapsedMs: number, visual?: VisualScore): E2EScore {
  const categories: CategoryScore[] = [];

  // Score each positive category
  for (const cat of ['brand', 'services', 'sections', 'seo', 'structure']) {
    if (goldenCriteria[cat]) {
      categories.push(scoreCategory(html, cat, goldenCriteria[cat]));
    }
  }

  // Score negative checks (hallucinations / placeholders)
  const penalties: { id: string; found: boolean; penalty: number }[] = [];
  let penaltyTotal = 0;
  const lower = html.toLowerCase();
  for (const item of goldenCriteria.mustNotContain ?? []) {
    const found = lower.includes(item.pattern.toLowerCase());
    penalties.push({ id: item.id, found, penalty: item.penalty });
    if (found) penaltyTotal += item.penalty;
  }

  // Add visual as a category if present
  if (visual) {
    categories.push({
      category: 'visual',
      score: visual.score,
      maxScore: visual.maxScore,
      pct: visual.pct,
      checks: visual.checks.map(c => ({ id: c.id, found: c.passed, weight: c.weight }))
    });
  }

  // Weighted score — when visual is enabled, redistribute weights
  const baseWeights = goldenCriteria.scoreWeights;
  const visualWeight = visual ? 0.20 : 0;
  const scaleFactor = visual ? 0.80 : 1.0; // scale non-visual weights to 80%
  let rawScore = 0;
  for (const cat of categories) {
    const w = cat.category === 'visual'
      ? visualWeight
      : (baseWeights[cat.category] ?? 0) * scaleFactor;
    rawScore += cat.pct * w;
  }
  // noHallucination component
  const maxPenalty = (goldenCriteria.mustNotContain ?? []).reduce((s: number, i: any) => s + i.penalty, 0);
  const noHallucinationPct = maxPenalty > 0 ? 1 - penaltyTotal / maxPenalty : 1;
  rawScore += noHallucinationPct * (baseWeights.noHallucination ?? 0) * scaleFactor;

  const finalScore = Math.max(0, Math.min(1, rawScore));

  const inputTokens = estimateTokens(SYSTEM_PROMPT + buildUserPrompt(compressedKb));
  const outputTokens = estimateTokens(html);

  // Extract a short preview of the HTML (first meaningful text)
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  const preview = titleMatch?.[1] || h1Match?.[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 80) || html.slice(0, 80);

  return {
    model,
    timestamp: new Date().toISOString(),
    elapsedMs,
    inputTokens,
    outputTokens,
    outputBytes: Buffer.byteLength(html, 'utf-8'),
    categories,
    penalties,
    penaltyTotal,
    rawScore,
    finalScore,
    htmlPreview: preview,
    visual
  };
}

// ── Extract HTML from response ──────────────────────────────────────────────

function extractHtml(raw: string): string {
  // Try to find HTML within markdown code fence
  const fenceMatch = raw.match(/```html?\s*\n([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a complete HTML document
  const docMatch = raw.match(/(<!DOCTYPE[\s\S]*<\/html>)/i);
  if (docMatch) return docMatch[1].trim();

  // Try from <html> if no doctype
  const htmlMatch = raw.match(/(<html[\s\S]*<\/html>)/i);
  if (htmlMatch) return htmlMatch[1].trim();

  // Fall back to raw response
  return raw.trim();
}

// ── Pretty print ────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatScore(s: E2EScore): string {
  const lines: string[] = [];
  lines.push(`\n${'═'.repeat(64)}`);
  lines.push(`  LANDING PAGE E2E — ${s.model}`);
  lines.push(`  ${s.timestamp}`);
  lines.push(`${'═'.repeat(64)}`);

  lines.push(`\n── Generation ──`);
  lines.push(`  Time:    ${(s.elapsedMs / 1000).toFixed(1)}s`);
  lines.push(`  Input:   ${s.inputTokens} tokens`);
  lines.push(`  Output:  ${s.outputTokens} tokens (${s.outputBytes.toLocaleString()} bytes)`);
  lines.push(`  Preview: ${s.htmlPreview}`);

  for (const cat of s.categories) {
    lines.push(`\n── ${cat.category.toUpperCase()} (${pct(cat.pct)}) ──`);
    for (const c of cat.checks) {
      const status = c.found ? '  ✓' : '  ✗';
      lines.push(`  ${status} ${c.id} (${c.weight})`);
    }
  }

  if (s.penalties.some(p => p.found)) {
    lines.push(`\n── PENALTIES ──`);
    for (const p of s.penalties) {
      if (p.found) lines.push(`  ✗ ${p.id} (-${p.penalty})`);
    }
  }

  if (s.visual) {
    lines.push(`\n── VISUAL (${pct(s.visual.pct)}) ── [${s.visual.durationMs}ms]`);
    for (const c of s.visual.checks) {
      const status = c.passed ? '  ✓' : '  ✗';
      lines.push(`  ${status} ${c.id} (${c.weight}) — ${c.detail}`);
    }
    if (s.visual.screenshotPath) {
      lines.push(`  Screenshot: ${s.visual.screenshotPath}`);
    }
  }

  lines.push(`\n── FINAL SCORE ──`);
  const hasVisual = s.visual != null;
  const sf = hasVisual ? 0.80 : 1.0;
  for (const cat of s.categories) {
    const w = cat.category === 'visual'
      ? 0.20
      : (goldenCriteria.scoreWeights[cat.category] ?? 0) * sf;
    lines.push(`  ${cat.category.padEnd(16)} ${pct(cat.pct).padStart(7)}  × ${w.toFixed(2)} = ${(cat.pct * w).toFixed(3)}`);
  }
  const noHallW = (goldenCriteria.scoreWeights.noHallucination ?? 0) * sf;
  const maxPen = (goldenCriteria.mustNotContain ?? []).reduce((s: number, i: any) => s + i.penalty, 0);
  const noHallPct = maxPen > 0 ? 1 - s.penaltyTotal / maxPen : 1;
  lines.push(`  ${'noHallucination'.padEnd(16)} ${pct(noHallPct).padStart(7)}  × ${noHallW.toFixed(2)} = ${(noHallPct * noHallW).toFixed(3)}`);
  lines.push(`  ${'─'.repeat(48)}`);
  lines.push(`  FINAL:           ${pct(s.finalScore)}`);
  lines.push(`${'═'.repeat(64)}\n`);

  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

// ── Run one model ───────────────────────────────────────────────────────────

async function runModel(model: string): Promise<E2EScore | null> {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  MODEL: ${model}`);
  console.log(`${'─'.repeat(64)}`);

  try {
    console.log('  Generating landing page HTML …');
    const { text: raw, elapsed } = await chatOllama(
      SYSTEM_PROMPT,
      buildUserPrompt(compressedKb),
      model,
      8192
    );
    console.log(`  Generated in ${(elapsed / 1000).toFixed(1)}s (${raw.length} chars raw)`);

    const html = extractHtml(raw);
    console.log(`  Extracted HTML: ${html.length} chars`);

    // Visual scoring (optional)
    let visual: VisualScore | undefined;
    if (enableVisual) {
      console.log('  Running visual analysis …');
      const slug = model.replace(/[/:]/g, '_');
      const ssPath = SCREENSHOT_DIR ? join(SCREENSHOT_DIR, `${slug}.png`) : undefined;
      visual = await scoreVisual(html, { ...VISUAL_OPTS, screenshotPath: ssPath });
      console.log(`  Visual: ${pct(visual.pct)} (${visual.durationMs}ms)`);
    }

    const score = scoreHtml(html, model, elapsed, visual);
    console.log(formatScore(score));

    // Save generated HTML if --out-dir is set
    if (OUTPUT_DIR) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const slug = model.replace(/[/:]/g, '_');
      const outPath = join(OUTPUT_DIR, `${slug}.html`);
      writeFileSync(outPath, html);
      console.log(`  Saved HTML to ${outPath}`);
    }

    return score;
  } catch (e) {
    console.error(`  FAILED: ${(e as Error).message}`);
    return null;
  }
}

// ── Comparison table ────────────────────────────────────────────────────────

function printComparison(scores: E2EScore[]): void {
  if (scores.length < 2) return;

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  LANDING PAGE E2E — COMPARISON TABLE');
  console.log(`${'═'.repeat(80)}`);

  const hasVisual = scores.some(s => s.visual);

  const cols = [
    'Model'.padEnd(28),
    'Brand'.padStart(7),
    'Svc'.padStart(7),
    'SEO'.padStart(7),
    'Struct'.padStart(7),
    ...(hasVisual ? ['Visual'.padStart(7)] : []),
    'Final'.padStart(7),
    'Time'.padStart(7),
    'Tokens'.padStart(7),
  ];
  const header = cols.join(' │ ');

  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  const sorted = [...scores].sort((a, b) => b.finalScore - a.finalScore);
  for (const s of sorted) {
    const catMap = Object.fromEntries(s.categories.map(c => [c.category, c.pct]));
    const row = [
      s.model.slice(0, 28).padEnd(28),
      pct(catMap['brand'] ?? 0).padStart(7),
      pct(catMap['services'] ?? 0).padStart(7),
      pct(catMap['seo'] ?? 0).padStart(7),
      pct(catMap['structure'] ?? 0).padStart(7),
      ...(hasVisual ? [pct(catMap['visual'] ?? 0).padStart(7)] : []),
      pct(s.finalScore).padStart(7),
      `${(s.elapsedMs / 1000).toFixed(0)}s`.padStart(7),
      `${s.outputTokens}`.padStart(7),
    ].join(' │ ');
    console.log(`  ${row}`);
  }

  console.log(`${'═'.repeat(80)}\n`);
}

// ── Main ────────────────────────────────────────────────────────────────────

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
    process.exit(0);
  }

  console.log(`\n╔${'═'.repeat(62)}╗`);
  console.log(`║  LANDING PAGE E2E BENCH — Reckons.AI                          ║`);
  console.log(`╚${'═'.repeat(62)}╝`);
  console.log(`Server:   ${OLLAMA_URL}`);
  console.log(`KB:       compressed-kb.txt (${estimateTokens(compressedKb)} tokens, ${compressedKb.split('\n').length} lines)`);
  console.log(`Criteria: ${goldenCriteria.brand.mustContain.length} brand, ${goldenCriteria.services.mustContain.length} services, ${goldenCriteria.seo.mustContain.length} SEO, ${goldenCriteria.structure.mustContain.length} structure checks`);
  console.log(`Visual:   ${enableVisual ? 'enabled (Chromium headless)' : 'disabled (use --visual to enable)'}`);

  const modelsToRun = requestedModels.length > 0
    ? requestedModels
    : chatModels.map(m => m.name);

  console.log(`Models:   ${modelsToRun.length} (${modelsToRun.join(', ')})`);

  const scores: E2EScore[] = [];

  for (const model of modelsToRun) {
    const score = await runModel(model);
    if (score) scores.push(score);
  }

  printComparison(scores);

  // Save results
  if (saveResults && scores.length > 0) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    for (const s of scores) {
      const slug = `landing-e2e_${s.model.replace(/[/:]/g, '_')}`;
      writeFileSync(join(RESULTS_DIR, `${slug}_${ts}.json`), JSON.stringify(s, null, 2));
    }

    if (scores.length > 1) {
      const comparison = {
        timestamp: new Date().toISOString(),
        kbTokens: estimateTokens(compressedKb),
        checkCounts: {
          brand: goldenCriteria.brand.mustContain.length,
          services: goldenCriteria.services.mustContain.length,
          seo: goldenCriteria.seo.mustContain.length,
          structure: goldenCriteria.structure.mustContain.length,
          penalties: goldenCriteria.mustNotContain.length
        },
        results: scores.map(s => ({
          model: s.model,
          finalScore: s.finalScore,
          elapsedMs: s.elapsedMs,
          outputTokens: s.outputTokens,
          categories: Object.fromEntries(s.categories.map(c => [c.category, c.pct]))
        }))
      };
      writeFileSync(
        join(RESULTS_DIR, `landing-e2e_comparison_${ts}.json`),
        JSON.stringify(comparison, null, 2)
      );
    }

    console.log(`  Results saved to ${RESULTS_DIR}/`);
  }

  // Clean up headless browser
  if (enableVisual) await closeBrowser();
}

main().catch(async e => {
  console.error(e);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
