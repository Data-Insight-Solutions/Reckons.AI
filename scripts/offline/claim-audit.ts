#!/usr/bin/env npx tsx
/**
 * Claim audit (SCRIPT tier) — the ASYNCHRONOUS half of alignment.
 *
 * `npm run align` gates the surfaces we GENERATE from the graph: if content/*.md or the
 * landing data drifts, the build fails. That is the easy half, because those surfaces have
 * no opinions — they are a function of the graph.
 *
 * This sweeps the surfaces we DO NOT generate and never will: README.md, SAFETY.md,
 * COUNSEL-BRIEF.md, the app shell's meta description, hand-written UI copy. Those are prose
 * written by a human, and prose is where overclaiming actually happens — the SAFETY.md
 * incident (a control described in the present tense while the feature was merely `planned`)
 * did not come from a generator.
 *
 * WHY THIS IS ASYNCHRONOUS AND NOT A GATE:
 * "Does this sentence claim something the graph contradicts?" is a JUDGMENT. A build gate
 * that is sometimes wrong gets switched off, and then it protects nothing. So every finding
 * here is a PROPOSAL in the review queue, gated by a human — the same contract as the local
 * agent tier. It never edits copy and never fails a build.
 *
 * It is still SCRIPT tier: the checks below are rules (does this label appear; is its status
 * in this set; does this number match a count), so they are deterministic, cost zero tokens,
 * and cannot hallucinate a violation that is not there.
 *
 * TWO CHECKS, both conservative on purpose — a sweep that emits 30 findings of which 25 are
 * noise has not removed cost, it has moved it to triage (F74.3):
 *
 *   1. UNBUILT CLAIMED AS BUILT — a feature's label appears in user-facing prose, its
 *      kpred:has-status is `planned` or `speculative`, and the sentence carries no hedge
 *      ("planned", "will", "not yet", "roadmap"…). This is kb:honest-status, mechanised.
 *
 *   2. COUNTABLE CLAIMS — "N MCP tools", "N tests" and friends are checked against what is
 *      actually there. The landing page once advertised 16 MCP tools while the graph had 20.
 *
 * Usage:
 *   npx tsx scripts/offline/claim-audit.ts             report
 *   npx tsx scripts/offline/claim-audit.ts --pending   queue findings for review
 *   npx tsx scripts/offline/claim-audit.ts --json      machine-readable
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Parser } from 'n3';

const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const JSON_OUT = argv.includes('--json');

const B = '\x1b[1m', D = '\x1b[2m', Y = '\x1b[33m', G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';

/** Surfaces a human writes by hand and a user actually reads. */
const SURFACES = [
  'README.md',
  'SAFETY.md',
  'COUNSEL-BRIEF.md',
  'src/app.html',
  'src/lib/components/LandingPage.svelte',
];

/** A sentence containing any of these is not asserting the feature exists today. */
const HEDGES = [
  'planned', 'will ', 'would ', 'not yet', 'roadmap', 'intend', 'future', 'upcoming',
  'speculative', 'in progress', 'in-progress', 'coming', 'proposed', 'design', 'aims to',
  'we plan', 'does not exist', 'not built', 'todo', 'tbd',
];

/** Statuses that mean THIS DOES NOT WORK TODAY. */
const UNBUILT = new Set(['planned', 'speculative']);

interface Finding {
  level: 'error' | 'warn';
  check: string;
  file: string;
  msg: string;
}
const findings: Finding[] = [];

// ── Load the graph: label -> status ─────────────────────────────────────────
const quads: any[] = [];
for (const f of readdirSync('static').filter((f) => f.endsWith('.ttl'))) {
  try {
    quads.push(...new Parser().parse(readFileSync(path.join('static', f), 'utf8')));
  } catch {
    /* graph-lint owns parse errors; not our job */
  }
}
const labelOf = new Map<string, string>();
const statusOf = new Map<string, string>();
for (const q of quads) {
  if (q.predicate.value === RDFS_LABEL) labelOf.set(q.subject.value, q.object.value);
  if (q.predicate.value === KPRED + 'has-status') statusOf.set(q.subject.value, q.object.value);
}

/** Features that DO NOT EXIST YET, keyed by a distinctive phrase from their label. */
const unbuilt: { iri: string; label: string; status: string; needle: string }[] = [];
for (const [iri, status] of statusOf) {
  if (!UNBUILT.has(status)) continue;
  const label = labelOf.get(iri);
  if (!label) continue;
  // Use the label's leading clause as the needle — everything before an em-dash/paren.
  // Short needles produce false positives ("Graph", "Export"), so require some specificity.
  const needle = label.split(/[—(:·]/)[0].trim();
  if (needle.length < 12) continue;
  unbuilt.push({ iri, label, status, needle: needle.toLowerCase() });
}

// ── Check 1: is an unbuilt feature described as if it works? ────────────────
for (const file of SURFACES) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  // Split into sentence-ish units so a hedge in a NEIGHBOURING sentence does not excuse this one.
  const sentences = text.split(/(?<=[.!?])\s+|\n{2,}/);
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (HEDGES.some((h) => lower.includes(h))) continue;
    for (const u of unbuilt) {
      if (!lower.includes(u.needle)) continue;
      findings.push({
        level: 'error',
        check: 'unbuilt-claimed-as-built',
        file,
        msg:
          `"${u.label}" has kpred:has-status "${u.status}" — it does not work today — but ${file} ` +
          `mentions it with no hedge: "${s.trim().slice(0, 160).replace(/\s+/g, ' ')}". ` +
          `Either hedge the sentence, or the graph's status is wrong. Both are findings.`,
      });
    }
  }
}

// ── Check 2: countable claims ──────────────────────────────────────────────
/** Ground truth, counted — not remembered. */
function countMcpTools(): number | null {
  const f = 'mcp-server/src/index.ts';
  if (!existsSync(f)) return null;
  const src = readFileSync(f, 'utf8');
  // Tools are registered by name; count distinct kb_* tool names.
  const names = new Set([...src.matchAll(/['"`](kb_[a-z_]+)['"`]/g)].map((m) => m[1]));
  return names.size || null;
}

function countTests(): number | null {
  try {
    const out = execSync('npx vitest run --reporter=json 2>/dev/null', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    const j = JSON.parse(out.slice(out.indexOf('{')));
    return j.numTotalTests ?? null;
  } catch {
    return null;
  }
}

/**
 * A SCOPED count is not a claim about the total, and treating it as one is how a sweep
 * earns its reputation for noise.
 *
 * First run of this audit flagged COUNSEL-BRIEF.md for "28 tests" against a true total of
 * 879 — but the line reads "Safety test suite green (28 tests)". That is a correct,
 * deliberately narrow claim, and the audit was the thing that was wrong. A false positive in
 * an honesty checker is worse than a miss: it trains the reader to dismiss it, and then the
 * one real finding goes unread with the rest (F74.3 — noise moves cost to triage rather than
 * removing it).
 *
 * So a countable claim is only checked when it is UNQUALIFIED.
 */
const SCOPE_WORDS = /\b(safety|unit|visual|e2e|smoke|integration|mcp|browser|extension|agent|snapshot|regression)\b/i;

const COUNTABLE: { label: string; re: RegExp; actual: () => number | null }[] = [
  { label: 'MCP tools', re: /(\d+)\s+MCP tools/gi, actual: countMcpTools },
  { label: 'tests', re: /(\d+)\s+(?:passing\s+)?tests\b/gi, actual: countTests },
];

for (const c of COUNTABLE) {
  let truth: number | null | undefined;
  for (const file of SURFACES) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(c.re)) {
        // "Safety test suite green (28 tests)" is scoped and true. Only an unqualified
        // count is asserting something about the whole codebase.
        if (SCOPE_WORDS.test(lines[i])) continue;
        const claimed = Number(m[1]);
        if (truth === undefined) truth = c.actual(); // lazily — counting tests is expensive
        if (truth == null) continue;
        if (claimed !== truth) {
          findings.push({
            level: 'error',
            check: 'countable-claim',
            file,
            msg:
              `${file}:${i + 1} claims ${claimed} ${c.label}; the codebase actually has ${truth}. ` +
              `A number is the easiest kind of claim to check, and therefore the least excusable to get wrong.`,
          });
        }
      }
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ surfaces: SURFACES, unbuiltTracked: unbuilt.length, findings }, null, 2));
} else {
  console.log(`${B}Claim audit${X} ${D}— ${SURFACES.length} hand-written surface(s) · ${unbuilt.length} unbuilt feature(s) tracked${X}\n`);
  if (findings.length === 0) {
    console.log(`${G}✓ clean — no hand-written surface claims something the graph says is unbuilt.${X}`);
  } else {
    for (const f of findings) {
      console.log(`  ${R}✗${X} ${B}${f.check}${X} ${D}${f.file}${X}\n    ${f.msg}\n`);
    }
    console.log(`${R}${findings.length} claim(s) the graph does not support.${X}`);
  }
}

// ── Queue as proposals. NEVER edits copy; NEVER fails a build. ──────────────
if (PENDING_OUT && findings.length) {
  const now = new Date().toISOString();
  const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
  let queued = 0;
  for (const f of findings) {
    const question = `[claim-audit/${f.check}] ${f.msg}`;
    if (existing.includes(JSON.stringify(question).slice(1, -1))) continue;
    appendFileSync(
      PENDING,
      JSON.stringify({
        subject: 'urn:kbase:concept/honest-status',
        predicate: `${KPRED}claim-audit`,
        question,
        type: 'drift-warning',
        agent: 'offline:claim-audit',
        priority: 'high',
        addedAt: now,
        addedByMcp: true,
      }) + '\n',
    );
    queued++;
  }
  console.log(`\n${queued} finding(s) queued → ${PENDING} (review in Reckons.AI).`);
}

// Asynchronous by design: this reports, it does not gate. A judgment call that fails a build
// gets switched off, and a check that is switched off protects nothing.
process.exit(0);
