#!/usr/bin/env npx tsx
/**
 * Graph lint (F74.3, SCRIPT tier) — deterministic graph invariants, no LLM.
 *
 * Every check here has a checkable answer, so it belongs in code rather than in a
 * local model's judgment: a script is right by construction, costs zero tokens, and
 * costs zero TRIAGE — the hidden tax that makes a noisy local-agent job a net loss.
 *
 * Checks (all encode bugs this project actually hit):
 *   dead-link      kpred:has-file / kpred:tested-by pointing at a path that is gone
 *   bad-status     a ktype:Feature whose kpred:has-status is outside the lifecycle
 *   duplicate-id   two features claiming the same kpred:feature-id (the F42/F43 collision)
 *   dangling-ref   depends-on / part-of / relates-to pointing at an entity that has no
 *                  rdf:type anywhere in the corpus — the graph pointing at nothing
 *   egress-gate    a feature that DISTRIBUTES user data (Reckons.AI as intermediary)
 *                  without a gate, or shipping ahead of its gate — and, in the other
 *                  direction, a user-export path that wrongly declares a blocking gate
 *   incomplete     a ktype:Feature missing a label, description, or status
 *
 * Usage:
 *   npm run offline:lint                 report + exit 1 on errors
 *   npm run offline:lint -- --pending    also queue findings for review in Reckons.AI
 *   npm run offline:lint -- --json       machine-readable (CI)
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const JSON_OUT = argv.includes('--json');
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';

const KB = 'urn:kbase:concept/';
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const FEATURE = 'urn:kbase:type/Feature';

/** Feature lifecycle, in maturity order. `in-progress` is de-facto (roadmap uses it for started work). */
const RANK: Record<string, number> = {
  speculative: 0, planned: 1, 'in-progress': 2, scaffolded: 3, functional: 4, production: 5,
};
const STATUSES = new Set(Object.keys(RANK));
/** Predicates whose object must be an entity that exists somewhere in the corpus. */
const REF_PREDS = ['depends-on', 'part-of', 'relates-to', 'blocks', 'blocked-by'].map((p) => KPRED + p);
/** Predicates whose object is a repo-relative path that must exist on disk. */
const PATH_PREDS = [KPRED + 'has-file', KPRED + 'tested-by'];

type Level = 'error' | 'warn';
interface Finding { level: Level; check: string; file: string; subject: string; msg: string; }
const findings: Finding[] = [];
const add = (level: Level, check: string, file: string, subject: string, msg: string) =>
  findings.push({ level, check, file, subject, msg });

const short = (iri: string) =>
  iri.startsWith(KB) ? `kb:${iri.slice(KB.length)}` : iri.startsWith(KPRED) ? `kpred:${iri.slice(KPRED.length)}` : iri;

// ── Load the corpus. static/ is the source of truth; reckons-workspace/kbs/* are
// copies made by setup-reckons-workspace.sh, so linting them would double-report.
//
// GENERATED graphs are skipped. static/knowledge.ttl is an exported snapshot (its
// header says so), and linting a derived artifact reports every defect twice — once
// where it must be fixed and once where it will be overwritten anyway. Fix the source;
// regenerate the snapshot.
const isGenerated = (text: string) => /^#\s*generated\b/im.test(text.slice(0, 200));

const files = readdirSync('static')
  .filter((f) => f.endsWith('.ttl') || f.endsWith('.trig'))
  .sort()
  .map((f) => path.join('static', f));
const quads: { q: Quad; file: string }[] = [];
const skipped: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (isGenerated(text)) { skipped.push(file); continue; }
  try {
    // TriG, not Turtle: every .ttl is already legal TriG (F75), so this reads today's
    // files unchanged while tolerating a named graph the day one appears.
    for (const q of new Parser({ format: 'TriG' }).parse(text)) quads.push({ q, file });
  } catch (e) {
    add('error', 'parse', file, file, `does not parse: ${e instanceof Error ? e.message : e}`);
  }
}

// Any subject with an rdf:type is a "real" entity — the existence set for dangling refs.
const typed = new Set(quads.filter(({ q }) => q.predicate.value === RDF_TYPE).map(({ q }) => q.subject.value));
const features = new Set(
  quads.filter(({ q }) => q.predicate.value === RDF_TYPE && q.object.value === FEATURE).map(({ q }) => q.subject.value),
);
const has = (subject: string, pred: string) =>
  quads.some(({ q }) => q.subject.value === subject && q.predicate.value === pred);
const objects = (subject: string, pred: string) =>
  quads.filter(({ q }) => q.subject.value === subject && q.predicate.value === pred).map(({ q }) => q.object.value);
const fileOf = (subject: string) => quads.find(({ q }) => q.subject.value === subject)?.file ?? '?';

// ── dead-link: a path predicate pointing at a file that no longer exists.
for (const { q, file } of quads) {
  if (!PATH_PREDS.includes(q.predicate.value)) continue;
  const p = q.object.value;
  if (!p || p.startsWith('http')) continue;
  if (!existsSync(p)) {
    add('error', 'dead-link', file, q.subject.value,
      `${short(q.predicate.value)} → "${p}" does not exist on disk (moved, renamed, or deleted).`);
  }
}

// ── bad-status: scoped to ktype:Feature — a Concept may legitimately use has-status
// to describe some other lifecycle (e.g. kb:review-workflow's pending → confirmed).
for (const { q, file } of quads) {
  if (q.predicate.value !== KPRED + 'has-status' || !features.has(q.subject.value)) continue;
  if (!STATUSES.has(q.object.value)) {
    add('error', 'bad-status', file, q.subject.value,
      `has-status "${q.object.value}" is not a lifecycle value (${[...STATUSES].join(' → ')}).`);
  }
}

// ── duplicate-id: two features claiming the same feature-id silently collide.
const byId = new Map<string, string[]>();
for (const { q } of quads) {
  if (q.predicate.value !== KPRED + 'feature-id') continue;
  byId.set(q.object.value, [...(byId.get(q.object.value) ?? []), q.subject.value]);
}
for (const [id, subjects] of byId) {
  const uniq = [...new Set(subjects)];
  if (uniq.length > 1) {
    add('error', 'duplicate-id', fileOf(uniq[0]), uniq[0],
      `feature-id "${id}" is claimed by ${uniq.length} entities: ${uniq.map(short).join(', ')} — renumber all but one.`);
  }
}

// ── dangling-ref: the graph pointing at an entity that was never defined.
for (const { q, file } of quads) {
  if (!REF_PREDS.includes(q.predicate.value)) continue;
  if (q.object.termType !== 'NamedNode' || !q.object.value.startsWith(KB)) continue;
  if (!typed.has(q.object.value)) {
    add('error', 'dangling-ref', file, q.subject.value,
      `${short(q.predicate.value)} → ${short(q.object.value)}, which has no rdf:type anywhere — define it or fix the reference.`);
  }
}

// ── egress-gate: DISTRIBUTION needs a gate; EXPORT must NOT have one (kb:data-egress-model).
// Two invariants, both enforceable:
//   1. mediated-distribution / third-party-service => kpred:gated-by required, and the
//      gate must be at least as mature as the feature it gates. This is what caught
//      publishing (functional) racing ahead of F66 publish-safety-gate (planned).
//   2. user-export => NO blocking gate. Export is a right; a gate here is a BUG, and a
//      lint that only checked direction (1) would happily let someone add one.
const GATED_EGRESS = new Set(['mediated-distribution', 'third-party-service']);
const EGRESS_VALUES = new Set(['none', 'user-export', ...GATED_EGRESS]);
const statusOf = (s: string) => objects(s, KPRED + 'has-status')[0];

for (const { q, file } of quads) {
  if (q.predicate.value !== KPRED + 'data-egress') continue;
  const subject = q.subject.value;
  const egress = q.object.value;
  const gates = objects(subject, KPRED + 'gated-by');

  if (!EGRESS_VALUES.has(egress)) {
    add('error', 'egress-gate', file, subject,
      `data-egress "${egress}" is not a known value (${[...EGRESS_VALUES].join(', ')}).`);
    continue;
  }

  if (egress === 'user-export' && gates.length > 0) {
    add('error', 'egress-gate', file, subject,
      `is user-export but declares kpred:gated-by ${gates.map(short).join(', ')} — EXPORT IS A RIGHT. Plain-text export of the user's own graph must never be blocked (advisory only).`);
    continue;
  }

  if (!GATED_EGRESS.has(egress)) continue;

  if (gates.length === 0) {
    add('error', 'egress-gate', file, subject,
      `data-egress "${egress}" but no kpred:gated-by — when Reckons.AI is the intermediary delivering content, it gates.`);
    continue;
  }
  const mine = RANK[statusOf(subject) ?? ''] ?? 0;
  for (const g of gates) {
    const gateRank = RANK[statusOf(g) ?? ''] ?? 0;
    if (mine > gateRank) {
      add('error', 'egress-gate', file, subject,
        `is "${statusOf(subject)}" with ${egress} egress, but its gate ${short(g)} is only "${statusOf(g) ?? 'undefined'}" — shipping ahead of its own safety gate.`);
    }
  }
}

// ── incomplete: a feature nobody can act on.
//
// A description may be stated as kpred:description OR skos:definition — the docs KBs
// use skos:definition, which is the STANDARD vocabulary and better practice than our
// custom predicate. Demanding kpred:description specifically produced three phantom
// findings, and the local describe-entities agent dutifully drafted descriptions for
// entities that already had perfectly good ones. A lint that invents work is worse
// than no lint: it spends the agent tier, and then it spends the reviewer.
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const describes = (s: string) => has(s, KPRED + 'description') || has(s, SKOS_DEFINITION);

for (const subject of features) {
  const missing = [
    !has(subject, RDFS_LABEL) && 'rdfs:label',
    !describes(subject) && 'a description (kpred:description or skos:definition)',
    !has(subject, KPRED + 'has-status') && 'kpred:has-status',
  ].filter(Boolean);
  if (missing.length) {
    add('warn', 'incomplete', fileOf(subject), subject, `Feature is missing ${missing.join(', ')}.`);
  }
}

// ── Report.
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({ files: files.length, quads: quads.length, errors, warns }, null, 2));
} else {
  const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', Y = '\x1b[33m', G = '\x1b[32m', X = '\x1b[0m';
  console.log(`${B}Graph lint${X} — ${quads.length} quads across ${files.length} graph(s)\n`);
  for (const group of ['parse', 'egress-gate', 'dead-link', 'bad-status', 'duplicate-id', 'dangling-ref', 'incomplete']) {
    const hits = findings.filter((f) => f.check === group);
    if (!hits.length) continue;
    const c = hits[0].level === 'error' ? R : Y;
    console.log(`${c}${B}${group}${X} (${hits.length})`);
    for (const f of hits) console.log(`  ${short(f.subject)} ${D}${f.file}${X}\n    ${f.msg}`);
    console.log('');
  }
  if (!findings.length) console.log(`${G}✓ clean — no invariant violations.${X}`);
  else console.log(`${errors.length ? R : G}${errors.length} error(s)${X}, ${warns.length} warning(s).`);
}

// ── Optionally queue for human review in the app (same shape as the other offline jobs).
if (PENDING_OUT && findings.length) {
  const now = new Date().toISOString();
  const existing = existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '';
  let queued = 0;
  for (const f of findings) {
    const question = `[graph-lint/${f.check}] ${short(f.subject)} — ${f.msg}`;
    if (existing.includes(JSON.stringify(question).slice(1, -1))) continue; // idempotent re-runs
    appendFileSync(PENDING, JSON.stringify({
      subject: f.subject,
      predicate: `urn:sweep:pred/graph-lint`,
      question,
      type: f.level === 'error' ? 'drift-warning' : 'question',
      agent: 'offline:graph-lint',
      priority: f.level === 'error' ? 'high' : 'medium',
      addedAt: now,
      addedByMcp: true,
    }) + '\n');
    queued++;
  }
  console.log(`\n${queued} finding(s) queued → ${PENDING} (review in Reckons.AI).`);
}

process.exit(errors.length ? 1 : 0);
