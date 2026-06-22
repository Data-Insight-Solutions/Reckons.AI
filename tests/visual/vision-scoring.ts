/**
 * Visual Analysis Bench — Scoring utilities
 *
 * Compares visual analysis results from different methods (local, CLIP, API)
 * against golden truth to measure accuracy, latency, and cost. Determines
 * when local analysis suffices vs when API escalation is warranted.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface VisualGolden {
  /** No solid-fill artifact */
  noSolidFill: boolean;
  /** No blank/black screen */
  notBlank: boolean;
  /** Elements that must be visible (CSS selectors) */
  mustBeVisible: string[];
  /** Selector pairs that must NOT overlap */
  mustNotOverlap: [string, string][];
  /** Text that must be present */
  mustContainText: string[];
  /** Semantic features Claude should identify */
  semanticFeatures: string[];
  /** High-level description */
  description: string;
}

export interface VisualTestCase {
  id: string;
  pageUrl: string;
  description: string;
  viewport: { width: number; height: number };
  /** Optional device profile name from Playwright */
  device?: string;
  golden: VisualGolden;
}

export interface MethodResult {
  method: string;
  passed: boolean;
  checks: CheckResult[];
  durationMs: number;
  cost: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface VisualBenchReport {
  testCase: string;
  timestamp: string;
  viewport: { width: number; height: number };
  methods: MethodResult[];
}

export interface ComparisonSummary {
  method: string;
  totalChecks: number;
  passed: number;
  accuracy: number;
  avgDurationMs: number;
  totalCost: number;
  recommendation: string;
}

// ── Scoring functions ────────────────────────────────────────────────────────

import type { PixelAnalysis, DOMAnalysis, TextAnalysis } from './vision-local';

export function scorePixelAnalysis(
  pixel: PixelAnalysis,
  golden: VisualGolden,
): CheckResult[] {
  const checks: CheckResult[] = [];

  checks.push({
    name: 'no-solid-fill',
    passed: golden.noSolidFill ? !pixel.isSolidFill : true,
    expected: golden.noSolidFill ? 'no solid fill' : 'any',
    actual: pixel.isSolidFill
      ? `solid fill: ${pixel.dominantColor} (${(pixel.dominantColorRatio * 100).toFixed(0)}%)`
      : 'varied content',
  });

  checks.push({
    name: 'not-blank',
    passed: golden.notBlank ? !pixel.isBlank : true,
    expected: golden.notBlank ? 'has content' : 'any',
    actual: pixel.isBlank ? 'blank screen' : 'has content',
  });

  checks.push({
    name: 'no-color-anomaly',
    passed: !pixel.hasColorAnomaly,
    expected: 'no artifact colors',
    actual: pixel.hasColorAnomaly
      ? pixel.anomalyDetails.join('; ')
      : 'clean',
  });

  return checks;
}

export function scoreDOMAnalysis(
  dom: DOMAnalysis,
  golden: VisualGolden,
): CheckResult[] {
  const checks: CheckResult[] = [];

  // Visibility checks
  for (const sel of golden.mustBeVisible) {
    const el = dom.visibleElements.find((e) => e.selector === sel);
    checks.push({
      name: `visible:${sel}`,
      passed: el?.visible ?? false,
      expected: 'visible',
      actual: el ? (el.visible ? 'visible' : 'hidden') : 'not found',
    });
  }

  // Overlap checks
  for (const [a, b] of golden.mustNotOverlap) {
    const overlap = dom.overlaps.find(
      (o) =>
        (o.element1 === a && o.element2 === b) ||
        (o.element1 === b && o.element2 === a),
    );
    checks.push({
      name: `no-overlap:${a}+${b}`,
      passed: !overlap || overlap.overlapPercent < 0.05,
      expected: 'no significant overlap',
      actual: overlap
        ? `${(overlap.overlapPercent * 100).toFixed(0)}% overlap (${overlap.overlapArea}px²)`
        : 'no overlap',
    });
  }

  // Off-screen check
  checks.push({
    name: 'no-offscreen',
    passed: dom.offscreenElements.length === 0,
    expected: 'all on screen',
    actual:
      dom.offscreenElements.length > 0
        ? `${dom.offscreenElements.length} offscreen: ${dom.offscreenElements.map((e) => e.selector).join(', ')}`
        : 'all on screen',
  });

  // Z-index check
  checks.push({
    name: 'no-zindex-collision',
    passed: dom.zIndexIssues.length === 0,
    expected: 'no collisions',
    actual:
      dom.zIndexIssues.length > 0
        ? dom.zIndexIssues.join('; ')
        : 'clean',
  });

  return checks;
}

export function scoreTextAnalysis(
  text: TextAnalysis,
  golden: VisualGolden,
): CheckResult[] {
  return golden.mustContainText.map((label) => ({
    name: `text:${label}`,
    passed: text.expectedFound.includes(label),
    expected: 'present',
    actual: text.expectedFound.includes(label) ? 'found' : 'missing',
  }));
}

export function scoreVisionAPI(
  apiResult: Record<string, unknown>,
  golden: VisualGolden,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const features = (apiResult.features as string[]) ?? [];

  for (const feat of golden.semanticFeatures) {
    const found = features.some(
      (f) =>
        f.toLowerCase().includes(feat.toLowerCase()) ||
        feat.toLowerCase().includes(f.toLowerCase()),
    );
    checks.push({
      name: `semantic:${feat}`,
      passed: found,
      expected: 'identified',
      actual: found ? 'found' : 'not identified',
    });
  }

  if (apiResult.layoutIssues) {
    const issues = apiResult.layoutIssues as string[];
    checks.push({
      name: 'api-layout-ok',
      passed: issues.length === 0,
      expected: 'no layout issues',
      actual: issues.length > 0 ? issues.join('; ') : 'clean',
    });
  }

  return checks;
}

// ── Report building ──────────────────────────────────────────────────────────

export function buildMethodResult(
  method: string,
  checks: CheckResult[],
  durationMs: number,
  cost = 0,
): MethodResult {
  return {
    method,
    passed: checks.every((c) => c.passed),
    checks,
    durationMs,
    cost,
  };
}

export function buildComparisonTable(
  reports: VisualBenchReport[],
): ComparisonSummary[] {
  const methodMap = new Map<
    string,
    { checks: number; passed: number; durations: number[]; cost: number }
  >();

  for (const report of reports) {
    for (const m of report.methods) {
      const entry = methodMap.get(m.method) ?? {
        checks: 0,
        passed: 0,
        durations: [],
        cost: 0,
      };
      entry.checks += m.checks.length;
      entry.passed += m.checks.filter((c) => c.passed).length;
      entry.durations.push(m.durationMs);
      entry.cost += m.cost;
      methodMap.set(m.method, entry);
    }
  }

  const summaries: ComparisonSummary[] = [];
  for (const [method, data] of methodMap) {
    const accuracy = data.checks > 0 ? data.passed / data.checks : 0;
    const avgDuration =
      data.durations.length > 0
        ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
        : 0;
    summaries.push({
      method,
      totalChecks: data.checks,
      passed: data.passed,
      accuracy,
      avgDurationMs: avgDuration,
      totalCost: data.cost,
      recommendation: getRecommendation(method, accuracy),
    });
  }

  return summaries.sort((a, b) => a.totalCost - b.totalCost);
}

function getRecommendation(method: string, accuracy: number): string {
  if (accuracy >= 0.95) return 'sufficient for CI';
  if (accuracy >= 0.85) return 'good for nightly';
  if (accuracy >= 0.7) return 'supplement with API';
  return 'not recommended alone';
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatBenchReport(report: VisualBenchReport): string {
  const lines: string[] = [];
  lines.push(`\n${'─'.repeat(60)}`);
  lines.push(`  PAGE: ${report.testCase}`);
  lines.push(`  Viewport: ${report.viewport.width}×${report.viewport.height}`);
  lines.push(`${'─'.repeat(60)}`);

  for (const m of report.methods) {
    const passCount = m.checks.filter((c) => c.passed).length;
    const status = m.passed ? '\u2713' : '\u2717';
    const costStr = m.cost > 0 ? `, $${m.cost.toFixed(4)}` : '';
    lines.push(
      `  ${m.method.padEnd(16)} (${m.durationMs}ms${costStr}): ${passCount}/${m.checks.length} ${status}`,
    );

    const failures = m.checks.filter((c) => !c.passed);
    for (const f of failures) {
      lines.push(`    FAIL ${f.name}: expected ${f.expected}, got ${f.actual}`);
    }
  }

  return lines.join('\n');
}

export function formatComparisonTable(summaries: ComparisonSummary[]): string {
  const lines: string[] = [];
  lines.push(`\n${'═'.repeat(72)}`);
  lines.push('  COMPARISON TABLE');
  lines.push(`${'═'.repeat(72)}`);

  const header = [
    'Method'.padEnd(18),
    'Accuracy'.padStart(9),
    'Avg Time'.padStart(9),
    'Cost'.padStart(8),
    'Recommendation'.padStart(22),
  ].join(' \u2502 ');

  lines.push(`  ${header}`);
  lines.push(`  ${'─'.repeat(header.length)}`);

  for (const s of summaries) {
    const row = [
      s.method.padEnd(18),
      `${(s.accuracy * 100).toFixed(1)}%`.padStart(9),
      `${s.avgDurationMs.toFixed(0)}ms`.padStart(9),
      s.totalCost > 0 ? `$${s.totalCost.toFixed(3)}`.padStart(8) : '$0'.padStart(8),
      s.recommendation.padStart(22),
    ].join(' \u2502 ');
    lines.push(`  ${row}`);
  }

  lines.push(`${'═'.repeat(72)}\n`);
  return lines.join('\n');
}
