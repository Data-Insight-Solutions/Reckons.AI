#!/usr/bin/env npx tsx
/**
 * Visual Analysis Bench Runner
 *
 * Captures screenshots of app pages across viewports, then runs every
 * available analysis method against them. Compares accuracy, latency,
 * and cost to determine when local analysis suffices vs when API
 * escalation is warranted.
 *
 * Usage:
 *   npx tsx tests/visual/run-visual-bench.ts                   # all pages, local only
 *   npx tsx tests/visual/run-visual-bench.ts --api             # include API tiers
 *   npx tsx tests/visual/run-visual-bench.ts --page review     # single page
 *   npx tsx tests/visual/run-visual-bench.ts --save            # persist results
 *   npx tsx tests/visual/run-visual-bench.ts --list            # show test cases
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — enables Claude Vision tiers (haiku/sonnet/opus)
 *   MISTRAL_API_KEY     — enables Mistral OCR tier
 *   VISION_TIER         — default Claude tier (haiku|sonnet|opus)
 *
 * Requires: vite dev server running on localhost:5174
 *   npm run dev:test &
 */

import { chromium, type Browser, type Page, devices } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// Load .env file so VITE_MISTRAL_API_KEY etc. are available
const envPath = resolve(import.meta.dirname || __dirname, '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

import { analyzePixels, analyzeDOMOverlaps, analyzeText, auditTouchTargets } from './vision-local';
import {
  scorePixelAnalysis, scoreDOMAnalysis, scoreTextAnalysis, scoreVisionAPI,
  buildMethodResult, buildComparisonTable,
  formatBenchReport, formatComparisonTable,
  type VisualBenchReport, type CheckResult,
} from './vision-scoring';
import {
  analyzeScreenshot, analyzeOCR,
  hasAnthropicKey, hasMistralKey, availableTiers,
  PROMPTS, TIER_COST,
  type VisionTier, type PageAnalysis,
} from './vision-analyze';
import { VISUAL_TEST_CASES } from './fixtures/golden-visual';
import type { VisualTestCase } from './vision-scoring';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveResults = args.includes('--save');
const includeApi = args.includes('--api');

if (args.includes('--list')) {
  console.log('\nAvailable test cases:');
  for (const tc of VISUAL_TEST_CASES) {
    console.log(`  ${tc.id.padEnd(24)} ${tc.pageUrl.padEnd(16)} ${tc.viewport.width}×${tc.viewport.height}  ${tc.description}`);
  }
  console.log(`\nAvailable analysis tiers: ${availableTiers().join(', ')}`);
  process.exit(0);
}

function parsePages(): string[] {
  const pages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--page' && args[i + 1]) pages.push(args[++i]);
  }
  return pages;
}

const filterPages = parsePages();
const testCases = filterPages.length > 0
  ? VISUAL_TEST_CASES.filter(tc => filterPages.some(p => tc.id.includes(p)))
  : VISUAL_TEST_CASES;

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5174';
const BENCH_DIR = import.meta.dirname || __dirname;
const RESULTS_DIR = join(BENCH_DIR, 'results');
const SCREENSHOTS_DIR = join(BENCH_DIR, 'screenshots');

// ── Browser lifecycle ────────────────────────────────────────────────────────

async function createPage(browser: Browser, tc: VisualTestCase): Promise<Page> {
  const contextOpts: Record<string, unknown> = {
    viewport: tc.viewport,
    ignoreHTTPSErrors: true,
  };

  // Apply device emulation if specified
  if (tc.device && tc.device in devices) {
    Object.assign(contextOpts, devices[tc.device as keyof typeof devices]);
  }

  const context = await browser.newContext(contextOpts);
  return context.newPage();
}

// ── Run one test case ────────────────────────────────────────────────────────

async function benchTestCase(
  browser: Browser,
  tc: VisualTestCase,
): Promise<VisualBenchReport> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  PAGE: ${tc.id} (${tc.pageUrl})`);
  console.log(`  ${tc.description}`);
  console.log(`  Viewport: ${tc.viewport.width}×${tc.viewport.height}${tc.device ? ` (${tc.device})` : ''}`);
  console.log(`${'─'.repeat(60)}`);

  const page = await createPage(browser, tc);
  const report: VisualBenchReport = {
    testCase: tc.id,
    timestamp: new Date().toISOString(),
    viewport: tc.viewport,
    methods: [],
  };

  try {
    // Navigate and wait for app shell
    await page.goto(`${BASE_URL}${tc.pageUrl}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1500); // let animations/force-simulation settle

    // Capture screenshot for pixel and API analysis
    const screenshot = await page.screenshot();

    // Save screenshot for manual inspection
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    writeFileSync(join(SCREENSHOTS_DIR, `${tc.id}.png`), screenshot);

    // ── Tier 1: Pixel analysis (local, free, ~5ms) ──

    const pixelStart = Date.now();
    const pixel = await analyzePixels(screenshot);
    const pixelChecks = scorePixelAnalysis(pixel, tc.golden);
    report.methods.push(buildMethodResult('pixel', pixelChecks, Date.now() - pixelStart));

    const pixelStatus = pixelChecks.every(c => c.passed) ? '\u2713' : '\u2717';
    console.log(`  Pixel (${Date.now() - pixelStart}ms): ${pixelChecks.filter(c => c.passed).length}/${pixelChecks.length} ${pixelStatus}`);
    if (pixel.anomalyDetails.length > 0) {
      for (const d of pixel.anomalyDetails) console.log(`    ! ${d}`);
    }

    // ── Tier 2: DOM analysis (local, free, ~15ms) ──

    const domStart = Date.now();
    const allSelectors = [
      ...tc.golden.mustBeVisible,
      ...tc.golden.mustNotOverlap.flat(),
      'nav', 'canvas', 'main', 'aside', '.snap-panel',
    ];
    const uniqueSelectors = [...new Set(allSelectors)];
    const dom = await analyzeDOMOverlaps(page, uniqueSelectors);
    const domChecks = scoreDOMAnalysis(dom, tc.golden);
    report.methods.push(buildMethodResult('dom', domChecks, Date.now() - domStart));

    const domStatus = domChecks.every(c => c.passed) ? '\u2713' : '\u2717';
    console.log(`  DOM (${Date.now() - domStart}ms): ${domChecks.filter(c => c.passed).length}/${domChecks.length} ${domStatus}`);

    // ── Tier 3: Text analysis (local, free, ~8ms) ──

    const textStart = Date.now();
    const text = await analyzeText(page, tc.golden.mustContainText);
    const textChecks = scoreTextAnalysis(text, tc.golden);
    report.methods.push(buildMethodResult('text', textChecks, Date.now() - textStart));

    const textStatus = textChecks.every(c => c.passed) ? '\u2713' : '\u2717';
    console.log(`  Text (${Date.now() - textStart}ms): ${textChecks.filter(c => c.passed).length}/${textChecks.length} ${textStatus}`);

    // ── Tier 3b: Touch targets (local, free, ~5ms) ──

    const touchStart = Date.now();
    const touchIssues = await auditTouchTargets(page);
    const touchChecks: CheckResult[] = [{
      name: 'touch-targets',
      passed: touchIssues.length === 0,
      expected: 'all >= 44px',
      actual: touchIssues.length > 0
        ? `${touchIssues.length} undersized: ${touchIssues.slice(0, 3).map(t => `${t.text}(${t.width}×${t.height})`).join(', ')}`
        : 'all ok',
    }];
    report.methods.push(buildMethodResult('touch', touchChecks, Date.now() - touchStart));
    console.log(`  Touch (${Date.now() - touchStart}ms): ${touchIssues.length === 0 ? '\u2713' : `${touchIssues.length} issues`}`);

    // ── Combined local score ──

    const localChecks = [...pixelChecks, ...domChecks, ...textChecks, ...touchChecks];
    report.methods.push(buildMethodResult(
      'local-combined',
      localChecks,
      report.methods.reduce((s, m) => s + m.durationMs, 0),
    ));

    // ── API tiers (only if --api flag and keys available) ──

    if (includeApi) {
      // Mistral OCR
      if (hasMistralKey()) {
        console.log('  Mistral OCR ...');
        try {
          const ocrResult = await analyzeOCR(screenshot);
          if (ocrResult && ocrResult.result) {
            const ocrText = (ocrResult.result.extractedText ?? '').toLowerCase();
            console.log(`  Mistral OCR raw: "${ocrText.slice(0, 120)}..."`);
            const ocrChecks: CheckResult[] = tc.golden.mustContainText.map(label => ({
              name: `ocr:${label}`,
              passed: ocrText.includes(label.toLowerCase()),
              expected: 'found in OCR',
              actual: ocrText.includes(label.toLowerCase()) ? 'found' : 'not found',
            }));
            report.methods.push(buildMethodResult('mistral-ocr', ocrChecks, ocrResult.durationMs, ocrResult.cost));
            console.log(`  Mistral OCR (${ocrResult.durationMs}ms, $${ocrResult.cost.toFixed(4)}): ${ocrChecks.filter(c => c.passed).length}/${ocrChecks.length}`);
          } else {
            console.warn('  Mistral OCR: no result returned');
          }
        } catch (e) {
          console.warn(`  Mistral OCR: ${(e as Error).message}`);
        }
      }

      // Claude Vision tiers
      if (hasAnthropicKey()) {
        for (const tier of ['haiku', 'sonnet', 'opus'] as VisionTier[]) {
          console.log(`  Claude ${tier} ...`);
          try {
            const { result, durationMs, cost, model } = await analyzeScreenshot<PageAnalysis>(
              screenshot, PROMPTS.fullPage, tier,
            );
            const apiChecks = scoreVisionAPI(result as unknown as Record<string, unknown>, tc.golden);
            report.methods.push(buildMethodResult(`claude-${tier}`, apiChecks, durationMs, cost));
            console.log(`  Claude ${tier} (${durationMs}ms, $${cost.toFixed(4)}): ${apiChecks.filter(c => c.passed).length}/${apiChecks.length}`);
          } catch (e) {
            console.warn(`  Claude ${tier}: FAILED — ${(e as Error).message}`);
          }
        }
      }
    }
  } catch (e) {
    console.error(`  ERROR: ${(e as Error).message}`);
  } finally {
    await page.context().close();
  }

  return report;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n\u2554${'═'.repeat(58)}\u2557`);
  console.log(`\u2551  VISUAL ANALYSIS BENCH \u2014 Reckons.AI${' '.repeat(22)}\u2551`);
  console.log(`\u255a${'═'.repeat(58)}\u255d`);
  console.log(`Test cases: ${testCases.length}`);
  console.log(`Available tiers: ${availableTiers().join(', ')}`);
  console.log(`API mode: ${includeApi ? 'ON' : 'OFF (pass --api to enable)'}`);
  console.log(`Base URL: ${BASE_URL}`);

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const reports: VisualBenchReport[] = [];

  try {
    for (const tc of testCases) {
      const report = await benchTestCase(browser, tc);
      reports.push(report);
      console.log(formatBenchReport(report));
    }
  } finally {
    await browser.close();
  }

  // Print comparison table
  const comparison = buildComparisonTable(reports);
  console.log(formatComparisonTable(comparison));

  // Print recommendation summary
  console.log('\n  RECOMMENDATIONS:');
  for (const s of comparison) {
    const icon = s.accuracy >= 0.95 ? '\u2713' : s.accuracy >= 0.85 ? '~' : '\u2717';
    console.log(`    ${icon} ${s.method.padEnd(18)} ${(s.accuracy * 100).toFixed(1)}% accuracy, ${s.avgDurationMs.toFixed(0)}ms avg, $${s.totalCost.toFixed(3)} total → ${s.recommendation}`);
  }
  console.log('');

  // Save results
  if (saveResults && reports.length > 0) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    const summary = {
      timestamp: new Date().toISOString(),
      testCases: testCases.length,
      apiMode: includeApi,
      availableTiers: availableTiers(),
      reports,
      comparison,
    };

    const filename = `visual-bench_${ts}.json`;
    writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(summary, null, 2));
    console.log(`Results saved to tests/visual/results/${filename}`);
  }
}

main().catch(e => {
  console.error('Visual bench failed:', e);
  process.exit(1);
});
