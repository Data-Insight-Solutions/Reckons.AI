#!/usr/bin/env npx tsx
/**
 * Competitor scan (F86 / kb:competitor-scan, SCRIPT tier).
 *
 * Refreshes every competitor's metadata and LICENSE from the GitHub API, and looks for
 * candidate new competitors by topic search. Deterministic, zero tokens, no model.
 *
 * The split is the whole point (F74.3):
 *
 *   FETCH is script tier      — "what license does this repo carry", "how many stars",
 *                               "is it archived" are checkable by a rule. A model asked
 *                               these would sometimes be confidently wrong, and a wrong
 *                               LICENSE is not a typo, it is a legal exposure.
 *
 *   JUDGMENT stays human      — "is this a competitor", "do we want this feature", "why
 *                               do we decline it". Automating that fills the graph with
 *                               plausible nonsense, and a competitive graph that flatters
 *                               its owner is marketing, not research.
 *
 * So this script NEVER edits static/reckons-competitive.ttl. It emits proposals to
 * knowledge.pending.jsonl and a human accepts them in the Review tab.
 *
 * LICENSE IS A GATE. kpred:copy-permitted in the TTL is only trustworthy because it is
 * checked here against the GitHub license field. A repo with no license is
 * all-rights-reserved by default — however public, however popular. Ideas may always be
 * learned from; expression may not always be copied.
 *
 * Usage:
 *   npx tsx scripts/offline/competitor-scan.ts            report drift; exit 1 on license change
 *   npx tsx scripts/offline/competitor-scan.ts --pending  also queue findings for review
 *   npx tsx scripts/offline/competitor-scan.ts --discover also search for NEW competitors
 *   npx tsx scripts/offline/competitor-scan.ts --json     machine-readable
 *
 * Requires the `gh` CLI, authenticated. Without it the script SKIPS (exit 0) rather than
 * failing the build — an unauthenticated CI runner is not a competitive-research problem.
 */
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { Parser } from 'n3';

const TTL = 'static/reckons-competitive.ttl';
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const KPRED = 'urn:kbase:predicate/';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const DISCOVER = argv.includes('--discover');
const JSON_OUT = argv.includes('--json');

const B = '\x1b[1m', D = '\x1b[2m', Y = '\x1b[33m', G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';

/** Topics that describe our neighbourhood. A repo tagged with these is a CANDIDATE — never
 *  auto-added, because "is this actually a competitor" is a judgment, not a rule. */
const DISCOVER_TOPICS = [
  'knowledge-graph',
  'codebase-visualization',
  'local-first',
  'rdf',
  'personal-knowledge-management',
];

interface Finding {
  level: 'error' | 'warn' | 'info';
  check: string;
  subject: string;
  msg: string;
}
const findings: Finding[] = [];

// ── The license gate ─────────────────────────────────────────────────────────
// Reckons.AI is MIT. That is not trivia — it decides what we are allowed to take.
//
// "Open source" is NOT one permission. A permissive license (MIT/BSD/ISC/Apache) lets us
// copy with attribution. A COPYLEFT license (GPL/AGPL/LGPL) does not: copying that code
// into an MIT project either violates the license or forces the whole of Reckons.AI to
// become GPL/AGPL. AGPL goes further and reaches across the network boundary. The three
// biggest projects in our own category — Logseq, SiYuan, Trilium — are all AGPL-3.0, so
// this distinction is load-bearing on exactly the repos we most want to learn from.
//
// The rule for copyleft is the same as for no licence at all: READ IT, LEARN THE IDEA,
// COPY NOTHING. Ideas are not copyrightable; expression is.
const OUR_LICENSE = 'MIT';

const PERMISSIVE = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'Zlib',
]);
/** Weak copyleft (MPL/EPL) is file-level rather than viral, but it still is not MIT — a human decides. */
const COPYLEFT = new Set([
  'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'EUPL-1.2', 'OSL-3.0',
]);

type Verdict = 'permissive' | 'copyleft' | 'none' | 'unknown';

function classify(spdx: string): Verdict {
  if (!spdx || spdx === 'NONE' || spdx === 'NOASSERTION') return 'none';
  if (PERMISSIVE.has(spdx)) return 'permissive';
  if (COPYLEFT.has(spdx)) return 'copyleft';
  return 'unknown';
}

/** The sentence that belongs in kpred:copy-permitted. One place, so it cannot drift. */
function copyPermitted(spdx: string): string {
  switch (classify(spdx)) {
    case 'permissive':
      return `yes — ${spdx}, attribution required${spdx === 'Apache-2.0' ? ' (+ NOTICE, patent grant)' : ''}`;
    case 'copyleft':
      return `NO — ${spdx} is copyleft and Reckons.AI is ${OUR_LICENSE}. Copying would force ${spdx} on the whole project. Ideas only.`;
    case 'none':
      return 'NO — unlicensed, all rights reserved. Ideas only; copy no code, assets, or text.';
    default:
      return `UNKNOWN — ${spdx} is not classified. A human must rule before any copy.`;
  }
}

// ── What the graph currently claims ──────────────────────────────────────────
interface Known {
  iri: string;
  label: string;
  repo: string; // owner/name
  license: string;
  stars: number;
}

function gh(args: string[]): any {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function ghAvailable(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function loadKnown(): Known[] {
  if (!existsSync(TTL)) return [];
  const quads = new Parser({ format: 'Turtle' }).parse(readFileSync(TTL, 'utf8'));
  const by = new Map<string, Record<string, string>>();
  for (const q of quads) {
    const p = q.predicate.value;
    if (!p.startsWith(KPRED) && !p.endsWith('#label')) continue;
    const key = p.startsWith(KPRED) ? p.slice(KPRED.length) : 'label';
    const rec = by.get(q.subject.value) ?? {};
    rec[key] = q.object.value;
    by.set(q.subject.value, rec);
  }
  const known: Known[] = [];
  for (const [iri, rec] of by) {
    if (!rec['repo-url']) continue;
    const m = rec['repo-url'].match(/github\.com\/([^/]+\/[^/#?]+)/);
    if (!m) continue;
    known.push({
      iri,
      label: rec['label'] ?? iri,
      repo: m[1],
      license: rec['license'] ?? 'UNKNOWN',
      stars: Number(rec['stars'] ?? 0),
    });
  }
  return known;
}

// ── Scan ─────────────────────────────────────────────────────────────────────
if (!ghAvailable()) {
  console.log(`${Y}gh CLI not available or not authenticated — skipping competitor scan.${X}`);
  console.log(`${D}This is a research job, not a build gate. Install/auth gh to enable it.${X}`);
  process.exit(0);
}

const known = loadKnown();
if (!JSON_OUT) console.log(`${B}Competitor scan${X} ${D}— ${known.length} tracked in ${TTL}${X}\n`);

interface Live {
  repo: string;
  license: string;
  stars: number;
  archived: boolean;
  pushed: string;
}
const live: Live[] = [];

for (const k of known) {
  let r: any;
  try {
    r = gh(['api', `repos/${k.repo}`]);
  } catch {
    findings.push({
      level: 'warn',
      check: 'unreachable',
      subject: k.iri,
      msg: `${k.repo} could not be fetched — deleted, renamed, or made private since the last scan.`,
    });
    continue;
  }

  const license: string = r.license?.spdx_id ?? 'NONE';
  const stars: number = r.stargazers_count ?? 0;
  live.push({ repo: k.repo, license, stars, archived: !!r.archived, pushed: (r.pushed_at ?? '').slice(0, 10) });

  // A LICENSE CHANGE IS THE ONE FINDING THAT CAN BITE. If a repo we copied from relicensed,
  // or one we skipped became permissive, that changes what we are ALLOWED to do — and the
  // graph's kpred:copy-permitted is now lying about it.
  if (license !== k.license) {
    findings.push({
      level: 'error',
      check: 'license-changed',
      subject: k.iri,
      msg: `${k.repo}: license is now ${license}, but the graph says ${k.license}. kpred:copy-permitted is out of date — fix it before copying anything.`,
    });
  }
  const verdict = classify(license);
  if (verdict === 'none') {
    findings.push({
      level: 'info',
      check: 'unlicensed',
      subject: k.iri,
      msg: `${k.repo}: ${copyPermitted(license)}`,
    });
  } else if (verdict === 'copyleft') {
    // Not a nag. Copying AGPL/GPL into an MIT codebase relicenses the codebase.
    findings.push({
      level: 'warn',
      check: 'copyleft',
      subject: k.iri,
      msg: `${k.repo}: ${copyPermitted(license)}`,
    });
  } else if (verdict === 'unknown') {
    findings.push({
      level: 'warn',
      check: 'license-unclassified',
      subject: k.iri,
      msg: `${k.repo}: ${copyPermitted(license)}`,
    });
  }
  if (r.archived) {
    findings.push({
      level: 'warn',
      check: 'archived',
      subject: k.iri,
      msg: `${k.repo} is archived. A dead competitor is still a source of ideas, but stop tracking it as live.`,
    });
  }
  // Drift in the recorded numbers: worth refreshing the TTL, not worth alarming anyone.
  if (k.stars > 0 && Math.abs(stars - k.stars) / Math.max(k.stars, 1) > 0.25) {
    findings.push({
      level: 'info',
      check: 'stars-drift',
      subject: k.iri,
      msg: `${k.repo}: ${k.stars} -> ${stars} stars (>25% change). Refresh kpred:stars.`,
    });
  }
}

// ── Discovery (opt-in) ───────────────────────────────────────────────────────
// Candidates ONLY. "Is this a competitor" is a judgment call, so the script proposes and
// a human disposes — exactly the boundary that keeps the agent tier honest.
if (DISCOVER) {
  const trackedRepos = new Set(known.map((k) => k.repo.toLowerCase()));
  const seen = new Set<string>();
  for (const topic of DISCOVER_TOPICS) {
    let results: any[];
    try {
      results = gh([
        'api',
        `search/repositories?q=topic:${topic}+stars:>200+pushed:>2026-01-01&sort=stars&per_page=5`,
        '--jq', '.items',
      ]);
    } catch {
      continue;
    }
    for (const r of results ?? []) {
      const full = (r.full_name ?? '').toLowerCase();
      if (!full || trackedRepos.has(full) || seen.has(full)) continue;
      seen.add(full);
      const spdx = r.license?.spdx_id ?? 'NONE';
      findings.push({
        level: 'info',
        check: 'candidate',
        subject: 'urn:kbase:concept/competitive-landscape',
        msg:
          `Candidate (topic:${topic}, ${r.stargazers_count}★, ${spdx} → ${classify(spdx)}): ` +
          `${r.full_name} — ${(r.description ?? '').slice(0, 100)}. Competitor, or noise? ` +
          `Copy rule if adopted: ${copyPermitted(spdx)}`,
      });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ known: known.length, live, findings }, null, 2));
} else {
  const byCheck = new Map<string, Finding[]>();
  for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  for (const [check, hits] of byCheck) {
    const c = hits[0].level === 'error' ? R : hits[0].level === 'warn' ? Y : D;
    console.log(`${c}${hits[0].level === 'error' ? '✗' : hits[0].level === 'warn' ? '!' : '·'}${X} ${B}${check}${X}`);
    for (const f of hits) console.log(`    ${f.msg}`);
    console.log('');
  }
  const errs = findings.filter((f) => f.level === 'error');
  if (!findings.length) console.log(`${G}✓ clean — every tracked competitor matches the graph.${X}`);
  else console.log(`${errs.length ? R : G}${errs.length} error(s)${X}, ${findings.filter((f) => f.level === 'warn').length} warning(s), ${findings.filter((f) => f.level === 'info').length} note(s).`);
}

// ── Queue for human review ───────────────────────────────────────────────────
if (PENDING_OUT && findings.length) {
  const now = new Date().toISOString();
  const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
  let queued = 0;
  for (const f of findings) {
    const question = `[competitor-scan/${f.check}] ${f.msg}`;
    if (existing.includes(JSON.stringify(question).slice(1, -1))) continue; // idempotent re-runs
    appendFileSync(
      PENDING,
      JSON.stringify({
        subject: f.subject,
        predicate: `${KPRED}competitor-scan`,
        question,
        type: f.level === 'error' ? 'drift-warning' : 'question',
        agent: 'offline:competitor-scan',
        priority: f.level === 'error' ? 'high' : 'medium',
        addedAt: now,
        addedByMcp: true,
      }) + '\n',
    );
    queued++;
  }
  console.log(`\n${queued} finding(s) queued → ${PENDING} (review in Reckons.AI).`);
}

// A license that moved under us is the one thing worth stopping for.
process.exit(findings.some((f) => f.level === 'error') ? 1 : 0);
