#!/usr/bin/env npx tsx
/**
 * KB Alignment — runs tests, compares results against the Production KB,
 * and writes pending.jsonl entries for discrepancies.
 *
 * Usage:
 *   npx tsx scripts/kb-align.ts [options]
 *
 * Options:
 *   --skip-e2e     Skip Playwright E2E tests
 *   --skip-tests   Skip all tests, only compare KB state
 *   --dry-run      Don't write pending.jsonl, just print what would change
 *   --ref HEAD~N   Git ref for alignment scoring (default HEAD~5)
 *   --verbose      Show full test output
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MultiKBReader, type Triple } from '../mcp-server/src/kb-reader.js';
import { bm25Search, invalidateCache } from '../mcp-server/src/search.js';
import { gitChangedFiles, gitLog, gitStatus } from '../mcp-server/src/git-utils.js';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SKIP_E2E = args.includes('--skip-e2e');
const SKIP_TESTS = args.includes('--skip-tests');
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const refIdx = args.indexOf('--ref');
const GIT_REF = refIdx >= 0 ? args[refIdx + 1] ?? 'HEAD~5' : 'HEAD~5';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const WORKSPACE = join(ROOT, 'reckons-workspace');
const PENDING_PATH = join(WORKSPACE, 'kbs', 'production', 'pending.jsonl');

// ── Types ────────────────────────────────────────────────────────────────────

type TestResult = {
  name: string;
  passed: number;
  failed: number;
  total: number;
  success: boolean;
  detail?: string;
};

type Discrepancy = {
  entity: string;
  iri: string;
  field: string;
  kbValue: string;
  actualValue: string;
  kind: 'stale' | 'drift' | 'missing-entity';
  severity: 'normal' | 'high';
};

type PendingEntry = {
  subject: string;
  predicate: string;
  object: string;
  note?: string;
  type: string;
  agent: string;
  priority: string;
  addedByMcp: boolean;
  addedAt: string;
};

// ── Colours ──────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function ok(s: string) { return `${C.green}${s}${C.reset}`; }
function warn(s: string) { return `${C.yellow}${s}${C.reset}`; }
function fail(s: string) { return `${C.red}${s}${C.reset}`; }
function dim(s: string) { return `${C.dim}${s}${C.reset}`; }
function bold(s: string) { return `${C.bold}${s}${C.reset}`; }

// ── Test runners ─────────────────────────────────────────────────────────────

function runVitest(): TestResult {
  try {
    const out = execSync('npx vitest run --reporter=json 2>/dev/null', {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const json = JSON.parse(out);
    return {
      name: 'unit',
      passed: json.numPassedTests ?? 0,
      failed: json.numFailedTests ?? 0,
      total: json.numTotalTests ?? 0,
      success: json.success ?? false,
      detail: `${json.numPassedTestSuites ?? 0} suites`,
    };
  } catch (e: unknown) {
    // vitest exits non-zero on test failures but still produces JSON
    const err = e as { stdout?: string; stderr?: string };
    try {
      const json = JSON.parse(err.stdout ?? '');
      return {
        name: 'unit',
        passed: json.numPassedTests ?? 0,
        failed: json.numFailedTests ?? 0,
        total: json.numTotalTests ?? 0,
        success: json.success ?? false,
        detail: `${json.numPassedTestSuites ?? 0} suites`,
      };
    } catch {
      // Parse from stderr fallback
      const stderr = err.stderr ?? '';
      const m = stderr.match(/(\d+)\s+passed/);
      const f = stderr.match(/(\d+)\s+failed/);
      return {
        name: 'unit',
        passed: m ? parseInt(m[1]) : 0,
        failed: f ? parseInt(f[1]) : 0,
        total: (m ? parseInt(m[1]) : 0) + (f ? parseInt(f[1]) : 0),
        success: false,
        detail: 'parse error',
      };
    }
  }
}

function runSvelteCheck(): TestResult {
  try {
    const out = execSync('npx svelte-check --threshold error 2>&1', {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    const m = out.match(/COMPLETED\s+(\d+)\s+FILES\s+(\d+)\s+ERRORS\s+(\d+)\s+WARNINGS/);
    const errors = m ? parseInt(m[2]) : -1;
    const warnings = m ? parseInt(m[3]) : 0;
    return {
      name: 'typecheck',
      passed: errors === 0 ? 1 : 0,
      failed: errors,
      total: 1,
      success: errors === 0,
      detail: `${errors} errors, ${warnings} warnings`,
    };
  } catch {
    return { name: 'typecheck', passed: 0, failed: 1, total: 1, success: false, detail: 'failed to run' };
  }
}

function runPlaywrightE2E(): TestResult {
  try {
    const out = execSync('npx playwright test --project=desktop-chrome --reporter=json 2>/dev/null', {
      cwd: ROOT, encoding: 'utf8', timeout: 300_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const json = JSON.parse(out);
    const expected = json.stats?.expected ?? 0;
    const unexpected = json.stats?.unexpected ?? 0;
    const skipped = json.stats?.skipped ?? 0;
    return {
      name: 'e2e',
      passed: expected,
      failed: unexpected,
      total: expected + unexpected + skipped,
      success: unexpected === 0,
      detail: skipped > 0 ? `${skipped} skipped` : undefined,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    try {
      const json = JSON.parse(err.stdout ?? '');
      const expected = json.stats?.expected ?? 0;
      const unexpected = json.stats?.unexpected ?? 0;
      return {
        name: 'e2e',
        passed: expected,
        failed: unexpected,
        total: expected + unexpected,
        success: false,
      };
    } catch {
      return { name: 'e2e', passed: 0, failed: 1, total: 1, success: false, detail: 'failed to run' };
    }
  }
}

function runMcpBuild(): TestResult {
  try {
    execSync('npm run build', { cwd: join(ROOT, 'mcp-server'), encoding: 'utf8', timeout: 30_000 });
    return { name: 'mcp-build', passed: 1, failed: 0, total: 1, success: true };
  } catch {
    return { name: 'mcp-build', passed: 0, failed: 1, total: 1, success: false, detail: 'build failed' };
  }
}

// ── KB comparison ────────────────────────────────────────────────────────────

type KBTestEntity = {
  iri: string;
  slug: string;
  label: string;
  expectedResult: string;
  command: string;
};

function readTestEntities(kb: MultiKBReader): KBTestEntity[] {
  const slugs = ['test-unit', 'test-visual', 'test-visual-bench', 'test-mcp', 'test-e2e', 'test-typecheck'];
  const entities: KBTestEntity[] = [];

  for (const slug of slugs) {
    const iri = `urn:kbase:concept/${slug}`;
    const triples = kb.triplesAbout(iri, 'production');
    if (triples.length === 0) continue;

    const get = (pred: string) => triples.find(t => t.predicate.endsWith(`/${pred}`))?.object ?? '';
    entities.push({
      iri,
      slug,
      label: get('label') || triples.find(t => t.predicate.includes('label'))?.object || slug,
      expectedResult: get('expected-result'),
      command: get('command'),
    });
  }
  return entities;
}

function parseExpectedCount(expected: string): number | null {
  const m = expected.match(/(\d+)\+?\s*(tests?\s+pass|pass)/i);
  return m ? parseInt(m[1]) : null;
}

function compareResults(results: TestResult[], kbEntities: KBTestEntity[]): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const kbMap = new Map(kbEntities.map(e => [e.slug, e]));

  for (const r of results) {
    // Map test result name to KB entity slug
    const slugMap: Record<string, string> = {
      unit: 'test-unit',
      e2e: 'test-e2e',
      typecheck: 'test-typecheck',
      'mcp-build': 'test-mcp',
    };
    const slug = slugMap[r.name];
    if (!slug) continue;

    const kbEntity = kbMap.get(slug);

    if (!kbEntity) {
      // Entity doesn't exist in KB
      discrepancies.push({
        entity: slug,
        iri: `urn:kbase:concept/${slug}`,
        field: 'entity',
        kbValue: '(not in KB)',
        actualValue: `${r.passed}/${r.total} passed`,
        kind: 'missing-entity',
        severity: 'normal',
      });
      continue;
    }

    // Compare expected result
    const expectedCount = parseExpectedCount(kbEntity.expectedResult);
    if (expectedCount !== null) {
      if (r.passed > expectedCount) {
        discrepancies.push({
          entity: slug,
          iri: kbEntity.iri,
          field: 'expected-result',
          kbValue: kbEntity.expectedResult,
          actualValue: `${r.passed} tests pass (${r.detail ?? ''})`,
          kind: 'stale',
          severity: 'normal',
        });
      } else if (r.passed < expectedCount || r.failed > 0) {
        discrepancies.push({
          entity: slug,
          iri: kbEntity.iri,
          field: 'expected-result',
          kbValue: kbEntity.expectedResult,
          actualValue: `${r.passed} passed, ${r.failed} failed`,
          kind: 'drift',
          severity: 'high',
        });
      }
    } else if (kbEntity.expectedResult) {
      // Qualitative expected result (e.g., "all visual checks pass")
      if (!r.success) {
        discrepancies.push({
          entity: slug,
          iri: kbEntity.iri,
          field: 'expected-result',
          kbValue: kbEntity.expectedResult,
          actualValue: `${r.failed} failures`,
          kind: 'drift',
          severity: 'high',
        });
      }
    }
  }

  return discrepancies;
}

// ── Alignment scoring (inlined from MCP handler) ─────────────────────────────

function scoreStatusAlignment(status: string): { score: number; verdict: string; reason: string } {
  const ORDER: Record<string, number> = { speculative: 0, planned: 1, scaffolded: 2, functional: 3, production: 4 };
  const rank = ORDER[status];
  if (rank === undefined) return { score: 0.5, verdict: 'aligned', reason: `unknown status "${status}"` };
  if (rank <= 1) return { score: 1.0, verdict: 'advancing', reason: `${status} — actively advancing` };
  if (rank === 2) return { score: 0.9, verdict: 'advancing', reason: `${status} — building on scaffold` };
  if (rank === 3) return { score: 0.7, verdict: 'aligned', reason: `${status} — polishing` };
  return { score: 0.5, verdict: 'aligned', reason: `${status} — production touch` };
}

type AlignmentReport = {
  composite: number;
  grade: string;
  coverage: number;
  status: number;
  deps: number;
  scope: number;
  verdicts: Array<{ entity: string; status: string; verdict: string; reason: string }>;
  changedFiles: number;
};

function computeAlignment(kb: MultiKBReader, ref: string): AlignmentReport | null {
  let changed: { path: string; status: string }[];
  try {
    changed = gitChangedFiles(ref);
  } catch {
    return null;
  }
  if (changed.length === 0) return null;

  const allTriples = kb.allTriples();

  // Extract keywords from file paths
  const keywords = new Set<string>();
  for (const f of changed) {
    for (const part of f.path.split('/')) {
      const name = part.replace(/\.[^.]+$/, '');
      if (name.length > 2) {
        keywords.add(name.toLowerCase());
        for (const w of name.split(/[-_.]/).filter(w => w.length > 2)) keywords.add(w.toLowerCase());
      }
    }
  }

  const searchHits = bm25Search(allTriples, [...keywords].join(' '), 15);

  // Group by entity, find features with status
  const entityMap = new Map<string, Triple[]>();
  for (const hit of searchHits) {
    if (!entityMap.has(hit.triple.subject)) {
      entityMap.set(hit.triple.subject, kb.triplesAbout(hit.triple.subject));
    }
  }

  const features: Array<{ iri: string; slug: string; status: string }> = [];
  for (const [iri, triples] of entityMap) {
    const statusT = triples.find(t => t.predicate.endsWith('/has-status'));
    if (!statusT) continue;
    features.push({ iri, slug: iri.split('/').pop() ?? iri, status: statusT.object });
  }

  // Coverage: fraction of changed files linked to KB entities
  const matchedSlugs = new Set<string>();
  for (const fe of features) {
    matchedSlugs.add(fe.slug.toLowerCase());
    for (const w of fe.slug.toLowerCase().split(/[-_]/)) if (w.length > 2) matchedSlugs.add(w);
  }

  let covered = 0;
  for (const f of changed) {
    const name = f.path.split('/').pop()?.replace(/\.[^.]+$/, '')?.toLowerCase() ?? '';
    if ([...matchedSlugs].some(s => name.includes(s) || s.includes(name))) covered++;
  }
  const coverageScore = changed.length > 0 ? covered / changed.length : 0;

  // Status alignment
  const verdicts: AlignmentReport['verdicts'] = [];
  let statusSum = 0;
  for (const fe of features) {
    const sa = scoreStatusAlignment(fe.status);
    verdicts.push({ entity: fe.slug, status: fe.status, verdict: sa.verdict, reason: sa.reason });
    statusSum += sa.score;
  }
  const statusScore = features.length > 0 ? statusSum / features.length : 0;

  // Scope discipline
  const unmatched = changed.length - covered;
  const scopeScore = changed.length > 0 ? Math.max(0, 1 - (unmatched / changed.length) * 0.8) : 1;

  // Deps: simplified — check if feature deps are met
  let depScore = 1.0;
  for (const fe of features) {
    const triples = entityMap.get(fe.iri) ?? [];
    const deps = triples.filter(t => t.predicate.endsWith('/depends-on'));
    for (const d of deps) {
      const depTriples = kb.triplesAbout(d.object);
      const depStatus = depTriples.find(t => t.predicate.endsWith('/has-status'));
      if (depStatus && !['production', 'functional'].includes(depStatus.object)) {
        depScore *= 0.5;
      }
    }
  }

  const composite = coverageScore * 0.30 + statusScore * 0.30 + depScore * 0.20 + scopeScore * 0.20;
  const grade = composite >= 0.85 ? 'EXCELLENT' : composite >= 0.70 ? 'GOOD' : composite >= 0.50 ? 'FAIR' : 'POOR';

  return { composite, grade, coverage: coverageScore, status: statusScore, deps: depScore, scope: scopeScore, verdicts, changedFiles: changed.length };
}

// ── Git diff triples ─────────────────────────────────────────────────────────

function gitDiffTriples(kb: MultiKBReader, ref: string): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  let changed: { path: string; status: string }[];
  try {
    changed = gitChangedFiles(ref);
  } catch {
    return [];
  }

  const allTriples = kb.allTriples();
  const keywords = new Set<string>();
  for (const f of changed) {
    for (const part of f.path.split('/')) {
      const name = part.replace(/\.[^.]+$/, '');
      if (name.length > 2) keywords.add(name.toLowerCase());
    }
  }

  const hits = bm25Search(allTriples, [...keywords].join(' '), 10);
  const entities = new Set<string>();
  for (const h of hits) entities.add(h.triple.subject);

  // Check if any matched entities have stale status or descriptions
  for (const iri of entities) {
    const triples = kb.triplesAbout(iri);
    const statusT = triples.find(t => t.predicate.endsWith('/has-status'));
    const descT = triples.find(t => t.predicate.endsWith('/description'));
    const slug = iri.split('/').pop() ?? iri;

    // If a "next" or "planned" entity has code changes, it might be advancing
    if (statusT && ['next', 'planned'].includes(statusT.object)) {
      discrepancies.push({
        entity: slug,
        iri,
        field: 'has-status',
        kbValue: statusT.object,
        actualValue: 'code changes detected — may be advancing',
        kind: 'stale',
        severity: 'normal',
      });
    }
  }

  return discrepancies;
}

// ── Pending entry generation ─────────────────────────────────────────────────

function toPendingEntries(discrepancies: Discrepancy[]): PendingEntry[] {
  const now = new Date().toISOString();
  const entries: PendingEntry[] = [];

  for (const d of discrepancies) {
    if (d.kind === 'missing-entity') {
      // Propose creating the entity
      entries.push({
        subject: d.iri,
        predicate: 'urn:kbase:predicate/expected-result',
        object: d.actualValue,
        note: `kb-align: new test category detected. No KB entity for "${d.entity}".`,
        type: 'suggestion',
        agent: 'kb-align',
        priority: 'normal',
        addedByMcp: true,
        addedAt: now,
      });
    } else if (d.kind === 'stale') {
      entries.push({
        subject: d.iri,
        predicate: `urn:kbase:predicate/${d.field}`,
        object: d.actualValue,
        note: `kb-align: KB says "${d.kbValue}" but actual is "${d.actualValue}".`,
        type: 'status-update',
        agent: 'kb-align',
        priority: 'normal',
        addedByMcp: true,
        addedAt: now,
      });
    } else if (d.kind === 'drift') {
      entries.push({
        subject: d.iri,
        predicate: `urn:kbase:predicate/${d.field}`,
        object: d.actualValue,
        note: `kb-align: DRIFT — KB expects "${d.kbValue}" but actual is "${d.actualValue}".`,
        type: 'drift-warning',
        agent: 'kb-align',
        priority: 'high',
        addedByMcp: true,
        addedAt: now,
      });
    }
  }
  return entries;
}

function deduplicateEntries(entries: PendingEntry[]): PendingEntry[] {
  // Read existing pending entries
  const existing = new Set<string>();
  if (existsSync(PENDING_PATH)) {
    const lines = readFileSync(PENDING_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const e = JSON.parse(trimmed);
        existing.add(`${e.subject}\t${e.predicate}\t${e.type}`);
      } catch { /* skip malformed */ }
    }
  }

  return entries.filter(e => !existing.has(`${e.subject}\t${e.predicate}\t${e.type}`));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n${bold('KB Alignment Report')}`);
  console.log('═'.repeat(56));

  // Check workspace exists
  if (!existsSync(join(WORKSPACE, 'kbs', 'production', 'kb.ttl'))) {
    console.log(fail('MCP workspace not found. Run: bash scripts/setup-mcp-workspace.sh'));
    process.exit(1);
  }

  // 1. Run tests
  const results: TestResult[] = [];

  if (!SKIP_TESTS) {
    console.log(`\n${bold('Tests')}`);

    // Unit tests
    process.stdout.write('  Unit tests...      ');
    const unit = runVitest();
    results.push(unit);
    console.log(unit.success
      ? ok(`${unit.passed}/${unit.total} passed`) + dim(` (${unit.detail})`)
      : fail(`${unit.passed}/${unit.total} passed, ${unit.failed} failed`));

    // Type checking
    process.stdout.write('  Type check...      ');
    const tc = runSvelteCheck();
    results.push(tc);
    console.log(tc.success ? ok(tc.detail ?? 'OK') : fail(tc.detail ?? 'failed'));

    // MCP build
    process.stdout.write('  MCP build...       ');
    const mcp = runMcpBuild();
    results.push(mcp);
    console.log(mcp.success ? ok('OK') : fail('build failed'));

    // E2E tests
    if (!SKIP_E2E) {
      process.stdout.write('  E2E tests...       ');
      const e2e = runPlaywrightE2E();
      results.push(e2e);
      console.log(e2e.success
        ? ok(`${e2e.passed}/${e2e.total} passed`)
        : fail(`${e2e.passed}/${e2e.total} passed, ${e2e.failed} failed`));
    }
  }

  // 2. Read KB
  const kb = new MultiKBReader(WORKSPACE);
  const kbEntities = readTestEntities(kb);

  // 3. Compare
  const testDiscrepancies = results.length > 0 ? compareResults(results, kbEntities) : [];

  // 4. Alignment scoring
  console.log(`\n${bold('Alignment')} ${dim(`(ref: ${GIT_REF})`)}`);
  invalidateCache();
  const alignment = computeAlignment(kb, GIT_REF);

  if (alignment) {
    const scoreColor = alignment.composite >= 0.7 ? ok : alignment.composite >= 0.5 ? warn : fail;
    console.log(`  Score: ${scoreColor(`${alignment.composite.toFixed(2)} (${alignment.grade})`)}`);
    console.log(`  Coverage:  ${(alignment.coverage * 100).toFixed(0)}%  Status: ${(alignment.status * 100).toFixed(0)}%  Deps: ${(alignment.deps * 100).toFixed(0)}%  Scope: ${(alignment.scope * 100).toFixed(0)}%`);
    console.log(`  ${alignment.changedFiles} files changed`);

    if (VERBOSE && alignment.verdicts.length > 0) {
      for (const v of alignment.verdicts) {
        const icon = v.verdict === 'advancing' ? ok('+') : v.verdict === 'aligned' ? '=' : warn('?');
        console.log(`    ${icon} ${v.entity} [${v.status}] ${dim(v.reason)}`);
      }
    }
  } else {
    console.log(dim('  No files changed or git unavailable'));
  }

  // 5. Git diff → KB drift
  const gitDiscrepancies = gitDiffTriples(kb, GIT_REF);
  const allDiscrepancies = [...testDiscrepancies, ...gitDiscrepancies];

  // 6. Generate pending entries
  const rawEntries = toPendingEntries(allDiscrepancies);
  const entries = deduplicateEntries(rawEntries);

  // 7. Print discrepancies
  if (allDiscrepancies.length > 0) {
    console.log(`\n${bold('Discrepancies')} (${allDiscrepancies.length})`);
    for (const d of allDiscrepancies) {
      const icon = d.kind === 'drift' ? fail('!') : d.kind === 'stale' ? warn('~') : dim('+');
      const tag = d.kind === 'drift' ? fail(`[${d.kind}]`) : d.kind === 'stale' ? warn(`[${d.kind}]`) : dim(`[${d.kind}]`);
      console.log(`  ${icon} ${tag} ${d.entity}.${d.field}: ${dim(d.kbValue)} → ${d.actualValue}`);
    }
  } else {
    console.log(`\n${ok('No discrepancies — KB is aligned.')}`);
  }

  // 8. Write pending
  if (entries.length > 0) {
    if (DRY_RUN) {
      console.log(`\n${warn('Dry run')}: would write ${entries.length} pending entries`);
      for (const e of entries) {
        console.log(dim(`  ${e.type}: ${e.subject.split('/').pop()} .${e.predicate.split('/').pop()} ${e.object}`));
      }
    } else {
      for (const e of entries) {
        appendFileSync(PENDING_PATH, JSON.stringify(e) + '\n', 'utf8');
      }
      console.log(`\n${ok(`${entries.length} pending entries`)} written to ${dim(PENDING_PATH.replace(ROOT + '/', ''))}`);
    }
  } else if (rawEntries.length > 0) {
    console.log(dim(`\n${rawEntries.length} entries already queued (skipped duplicates)`));
  }

  console.log();

  // Exit code: 1 if any drift warnings
  const hasDrift = allDiscrepancies.some(d => d.kind === 'drift');
  process.exit(hasDrift ? 1 : 0);
}

main();
