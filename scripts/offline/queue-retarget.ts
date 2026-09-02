#!/usr/bin/env npx tsx
/**
 * Assign a destination graph to legacy pending rows that have none (F80).
 *
 * WHY THIS EXISTS. `drainWorkspacePending` parses with `requireKb: true`, so a row without a `kb`
 * field is retained and never delivered to the review UI. That guard is correct — it is what stops
 * a roadmap proposal being imported into whichever graph happens to be open — but it left 413 of
 * 535 rows unreviewable: you drain, see 122, and believe that is the queue.
 *
 * The assignment is a RULE, not a judgement. Every legacy producer wrote a subject IRI whose
 * namespace already names what the row is about, so the target is read from the subject rather
 * than from the file the row happens to sit in. Rows matching no rule are reported and LEFT
 * UNTARGETED: guessing is what this script exists to avoid.
 *
 * Script tier by F74.3 — deterministic, zero tokens, checkable by a rule, right by construction.
 *
 * SAFE BY DEFAULT: dry-run unless --apply, and --apply backs the file up first. Rows that already
 * carry a `kb` are never touched, and untouched rows are written back byte-for-line.
 *
 *   npx tsx scripts/offline/queue-retarget.ts              dry-run: show the plan, write nothing
 *   npx tsx scripts/offline/queue-retarget.ts --apply      back up, then assign
 *   npx tsx scripts/offline/queue-retarget.ts --show 5     include N sample subjects per rule
 */
import { copyFileSync, existsSync } from 'fs';
import { QUEUE_PATH, transactPendingQueue } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const APPLY = process.argv.includes('--apply');
const SHOW = (() => {
  const i = process.argv.indexOf('--show');
  return i >= 0 ? Number(process.argv[i + 1]) || 3 : 0;
})();

/**
 * Ordered; first match wins. Prefixes are matched against the row's subject.
 *
 * `urn:sweep:review/*` is the one that matters most: those subjects are keyed by FILE PATH
 * (`review/src-lib-3d-KnowledgeGraph-svelte`), not by feature, so they are codebase rows that
 * happen to live in a roadmap-shaped queue. Filing them under roadmap would bury 149 code
 * findings among the features.
 */
const RULES: ReadonlyArray<{ prefix: string; target: string; why: string }> = [
  { prefix: 'urn:sweep:review/',     target: 'codebase',   why: 'code-review finding keyed by file path' },
  { prefix: 'urn:reckons:test/',     target: 'production', why: 'test-suite subject' },
  { prefix: 'urn:kbase:concept/',    target: 'roadmap',    why: 'feature/concept entity (kb: prefix)' },
  { prefix: 'urn:kbase:predicate/',  target: 'roadmap',    why: 'vocabulary hygiene (F75.1)' },
  { prefix: 'urn:reckons:feature/',  target: 'roadmap',    why: 'feature subject' },
  // No trailing slash: alignment-sweep.sh emits `urn:sweep:namespace`, `urn:sweep:assets` and
  // `urn:sweep:leap` bare (only `graph/` carries a segment). A trailing slash here silently
  // missed 6 rows on the first dry-run.
  { prefix: 'urn:sweep:graph',       target: 'roadmap',    why: 'sweep graph check' },
  { prefix: 'urn:sweep:namespace',   target: 'roadmap',    why: 'sweep namespace check' },
  { prefix: 'urn:sweep:assets',      target: 'roadmap',    why: 'sweep asset-path check' },
  { prefix: 'urn:sweep:leap',        target: 'roadmap',    why: 'sweep LEAP-mention check' },
  // graph-lint reports predicate economy against external vocabulary terms by full IRI.
  // Same class as urn:kbase:predicate/* — vocabulary hygiene, not a code or test finding.
  { prefix: 'http://www.w3.org/',    target: 'roadmap',    why: 'external vocabulary term (graph-lint)' },
  { prefix: 'http://purl.org/dc/',   target: 'roadmap',    why: 'external vocabulary term (graph-lint)' },
  // Bare `kb:` prefixed subjects — a producer inconsistency (the full IRI is urn:kbase:concept/…),
  // but unambiguous in meaning. Kept last so no full-IRI rule is shadowed.
  { prefix: 'kb:',                   target: 'roadmap',    why: 'concept subject written in prefixed form' },
];

function ruleFor(subject: unknown): (typeof RULES)[number] | undefined {
  if (typeof subject !== 'string') return undefined;
  return RULES.find((r) => subject.startsWith(r.prefix));
}

if (!existsSync(QUEUE_PATH)) {
  console.error(`${R}No pending queue at ${QUEUE_PATH}${X}`);
  process.exit(1);
}

// Back up BEFORE the lock is taken and before a single byte is rewritten. An agent must never
// quietly reshape the shared queue; --apply always leaves a restore path.
let backupPath: string | undefined;
if (APPLY) {
  backupPath = `${QUEUE_PATH}.retarget-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  copyFileSync(QUEUE_PATH, backupPath);
}

type Plan = {
  assigned: Map<string, { count: number; rules: Map<string, { count: number; samples: string[] }> }>;
  unmatched: { subject: string; agent: string }[];
  alreadyTargeted: number;
  unparseable: number;
  total: number;
};

const result = transactPendingQueue(QUEUE_PATH, (current) => {
  const lines = current.split('\n');
  const out: string[] = [];
  const plan: Plan = {
    assigned: new Map(),
    unmatched: [],
    alreadyTargeted: 0,
    unparseable: 0,
    total: 0,
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    plan.total++;

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      // Never rewrite what we cannot read. Retained byte-for-line.
      plan.unparseable++;
      out.push(line);
      continue;
    }

    if (typeof row.kb === 'string' && row.kb.trim()) {
      plan.alreadyTargeted++;
      out.push(line);
      continue;
    }

    const rule = ruleFor(row.subject);
    if (!rule) {
      plan.unmatched.push({
        subject: String(row.subject ?? '<none>'),
        agent: String(row.agent ?? '<none>'),
      });
      out.push(line);
      continue;
    }

    const bucket = plan.assigned.get(rule.target) ?? { count: 0, rules: new Map() };
    bucket.count++;
    const byRule = bucket.rules.get(rule.prefix) ?? { count: 0, samples: [] };
    byRule.count++;
    if (byRule.samples.length < Math.max(SHOW, 1)) byRule.samples.push(String(row.subject));
    bucket.rules.set(rule.prefix, byRule);
    plan.assigned.set(rule.target, bucket);

    out.push(JSON.stringify({ ...row, kb: rule.target }));
  }

  const content = out.length ? out.join('\n') + '\n' : '';
  // Dry-run: omit `content` entirely so the transaction leaves the file byte-for-byte unchanged.
  return APPLY ? { content, result: plan } : { result: plan };
});

// ── Report ──────────────────────────────────────────────────────────────────
const assignedTotal = [...result.assigned.values()].reduce((n, b) => n + b.count, 0);

console.log(`\n${B}Queue retarget${X} ${D}${QUEUE_PATH}${X}`);
console.log(`${D}${'─'.repeat(74)}${X}`);
console.log(`  ${String(result.total).padStart(4)} rows total`);
console.log(`  ${String(result.alreadyTargeted).padStart(4)} already targeted ${D}(untouched)${X}`);
console.log(`  ${String(assignedTotal).padStart(4)} ${G}assignable by rule${X}`);
if (result.unmatched.length) console.log(`  ${String(result.unmatched.length).padStart(4)} ${Y}unmatched — left untargeted${X}`);
if (result.unparseable) console.log(`  ${String(result.unparseable).padStart(4)} ${R}unparseable — retained verbatim${X}`);

for (const [target, bucket] of [...result.assigned].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n${B}→ ${C}${target}${X} ${D}(${bucket.count})${X}`);
  for (const [prefix, r] of [...bucket.rules].sort((a, b) => b[1].count - a[1].count)) {
    const why = RULES.find((x) => x.prefix === prefix)?.why ?? '';
    console.log(`  ${String(r.count).padStart(4)}  ${prefix.padEnd(24)} ${D}${why}${X}`);
    if (SHOW) for (const s of r.samples) console.log(`        ${D}${s}${X}`);
  }
}

if (result.unmatched.length) {
  console.log(`\n${Y}${B}Unmatched — no rule, deliberately left untargeted${X}`);
  const byAgent = new Map<string, string[]>();
  for (const u of result.unmatched) {
    const list = byAgent.get(u.agent) ?? [];
    if (list.length < 3) list.push(u.subject);
    byAgent.set(u.agent, list);
  }
  for (const [agent, subjects] of byAgent) {
    console.log(`  ${D}${agent}${X}`);
    for (const s of subjects) console.log(`      ${s}`);
  }
}

console.log(`\n${D}${'─'.repeat(74)}${X}`);
if (APPLY) {
  console.log(`${G}✓ applied${X} — ${assignedTotal} row(s) assigned a destination graph.`);
  console.log(`${D}  backup: ${backupPath}${X}`);
  console.log(`${D}  Drain each graph in Reckons.AI to review them.${X}`);
} else {
  console.log(`${Y}dry-run — nothing written.${X} Re-run with ${B}--apply${X} to assign.`);
}
console.log('');
