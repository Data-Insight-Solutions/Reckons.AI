#!/usr/bin/env npx tsx
/**
 * History lessons (SCRIPT tier) — what this repo's own past says about how it fails.
 *
 * A semantic system fails QUIETLY. Nothing crashes; the graph simply says something that is
 * not true, and it keeps saying it until somebody happens to look. This project's history is
 * a catalogue of exactly that, and the catalogue is the most honest source of enhancement
 * ideas we have — it is evidence rather than opinion:
 *
 *   "the one thing a history exists to do, it could not do"
 *   "citations were never verified — a fabricated quote shipped as provenance"
 *   "KB leaps from the read-only docs hub were silently no-ops"
 *   "the deploy gate was guarding a build that could not fail"
 *   "the code review reported a clean run having read zero files"
 *
 * Every one of those was live for a while, and in every case the CODE was not the whole
 * problem — the DETECTION was missing. So this job mines the history for the two questions
 * that turn a past failure into a future control:
 *
 *   1. WHICH FIXES CAME WITHOUT A TEST? A fix with no test is a bug with a return ticket.
 *      This is a rule, not a judgment: did the fix commit touch a test file, yes or no.
 *
 *   2. WHERE DO FIXES CLUSTER? A file that keeps needing fixes is not unlucky, it is
 *      fragile — and fragility is a design signal, not a moral failing.
 *
 * Deterministic, zero tokens, no model. Findings are PROPOSALS in the review queue.
 *
 * Usage:
 *   npx tsx scripts/offline/history-lessons.ts            report
 *   npx tsx scripts/offline/history-lessons.ts --pending  queue proposals for review
 *   npx tsx scripts/offline/history-lessons.ts --since=200  look back N commits (default 300)
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync, appendFileSync } from 'fs';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const JSON_OUT = argv.includes('--json');
const SINCE = Number(argv.find((a) => a.startsWith('--since='))?.split('=')[1] ?? 300);

const B = '\x1b[1m', D = '\x1b[2m', Y = '\x1b[33m', G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
};

const isTest = (f: string) => /(^|\/)(__tests__|tests)\//.test(f) || /\.(test|spec)\.[tj]sx?$/.test(f);
/** Source that can actually carry a bug (excludes docs, TTL, config, generated content). */
const isSource = (f: string) =>
  /^(src|scripts|mcp-server\/src|cli)\//.test(f) && /\.(ts|svelte|js)$/.test(f) && !isTest(f);

interface Fix {
  sha: string;
  subject: string;
  sourceFiles: string[];
  testFiles: string[];
}

// ── Collect fix commits ─────────────────────────────────────────────────────
const log = sh(`git log -n ${SINCE} --format=%H%x00%s`).trim().split('\n').filter(Boolean);
const fixes: Fix[] = [];

for (const line of log) {
  const [sha, subject] = line.split('\0');
  if (!/^fix(\(|:)/i.test(subject ?? '')) continue;
  const files = sh(`git show --name-only --format= ${sha}`).trim().split('\n').filter(Boolean);
  fixes.push({
    sha: sha.slice(0, 8),
    subject,
    sourceFiles: files.filter(isSource),
    testFiles: files.filter(isTest),
  });
}

interface Finding {
  level: 'error' | 'warn';
  check: string;
  msg: string;
}
const findings: Finding[] = [];

// ── 1. Fixes that shipped with no test ─────────────────────────────────────
//
// This is the whole point. A fix without a test asserts "it is better now" and leaves no way
// to notice when it stops being better. In a semantic system that is not a small gap: the
// regression will not crash, it will just quietly go back to being wrong.
const untested = fixes.filter((f) => f.sourceFiles.length > 0 && f.testFiles.length === 0);

for (const f of untested) {
  findings.push({
    level: 'error',
    check: 'fix-without-test',
    msg:
      `${f.sha} "${f.subject.slice(0, 90)}" changed ${f.sourceFiles.length} source file(s) and NO test. ` +
      `A fix with no test is a bug with a return ticket — and in a semantic system the regression will not ` +
      `crash, it will quietly go back to being wrong. Files: ${f.sourceFiles.slice(0, 3).join(', ')}`,
  });
}

// ── 2. Fragility hotspots ──────────────────────────────────────────────────
const fixCount = new Map<string, number>();
for (const f of fixes) for (const s of f.sourceFiles) fixCount.set(s, (fixCount.get(s) ?? 0) + 1);

const hotspots = [...fixCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
for (const [file, n] of hotspots.slice(0, 8)) {
  findings.push({
    level: 'warn',
    check: 'fragility-hotspot',
    msg:
      `${file} has been fixed ${n} times in the last ${SINCE} commits. A file that keeps needing fixes is not ` +
      `unlucky, it is fragile — that is a design signal, not a moral failing. Worth asking what invariant it ` +
      `keeps failing to hold.`,
  });
}

// ── Report ─────────────────────────────────────────────────────────────────
const testedRate = fixes.length ? Math.round(((fixes.length - untested.length) / fixes.length) * 100) : 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ fixes: fixes.length, untested: untested.length, testedRate, findings }, null, 2));
} else {
  console.log(`${B}History lessons${X} ${D}— ${fixes.length} fix commit(s) in the last ${SINCE}${X}\n`);
  console.log(
    `  ${untested.length} fix(es) shipped with NO test  ${D}(${testedRate}% of fixes carried one)${X}\n`,
  );
  const byCheck = new Map<string, Finding[]>();
  for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  for (const [check, hits] of byCheck) {
    const c = hits[0].level === 'error' ? R : Y;
    console.log(`${c}${hits[0].level === 'error' ? '✗' : '!'}${X} ${B}${check}${X} ${D}(${hits.length})${X}`);
    for (const f of hits.slice(0, 6)) console.log(`    ${f.msg}`);
    if (hits.length > 6) console.log(`    ${D}… and ${hits.length - 6} more${X}`);
    console.log('');
  }
  if (!findings.length) console.log(`${G}✓ every fix carried a test, and nothing is a hotspot.${X}`);
}

// ── Queue proposals ────────────────────────────────────────────────────────
if (PENDING_OUT && findings.length) {
  const now = new Date().toISOString();
  const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
  let queued = 0;
  for (const f of findings) {
    const question = `[history-lessons/${f.check}] ${f.msg}`;
    if (existing.includes(JSON.stringify(question).slice(1, -1))) continue;
    appendFileSync(
      PENDING,
      JSON.stringify({
        subject: 'urn:kbase:concept/deep-testing',
        predicate: 'urn:kbase:predicate/history-lesson',
        question,
        type: f.level === 'error' ? 'drift-warning' : 'observation',
        agent: 'offline:history-lessons',
        priority: f.level === 'error' ? 'high' : 'medium',
        addedAt: now,
        addedByMcp: true,
      }) + '\n',
    );
    queued++;
  }
  console.log(`${queued} finding(s) queued → ${PENDING} (review in Reckons.AI).`);
}

// A report, not a gate: "this old fix had no test" must not block today's build.
process.exit(0);
