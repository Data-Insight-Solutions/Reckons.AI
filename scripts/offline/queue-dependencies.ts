#!/usr/bin/env npx tsx
/**
 * Queue the roadmap's dependency edges as reviewable pending facts (F74.3, script tier).
 *
 * WHY. The review queue is full of facts ABOUT features and empty of facts RELATING them, so a
 * drained graph is a cloud of leaves with no structure — nothing for the hierarchy layout to lay
 * out, and nothing for a cascade to walk. The relations are not missing from the project, only
 * from the queue: `static/reckons-roadmap.ttl` states 140 `kpred:depends-on` edges.
 *
 * This proposes those edges as ordinary pending facts, so they arrive through the same review the
 * rest of the queue does. They are PROPOSALS, not assertions: each is a claim that one feature
 * needs another, and settling it is a human decision like any other.
 *
 * Each row carries `objectKind: 'iri'` so it imports as a real edge between two entities. Without
 * it the drain would make the object a literal and the "edge" would be a leaf holding a string.
 *
 *   npx tsx scripts/offline/queue-dependencies.ts            dry-run: show what would be queued
 *   npx tsx scripts/offline/queue-dependencies.ts --apply    append to the pending queue
 *   npx tsx scripts/offline/queue-dependencies.ts --only-queued
 *       restrict to features that already have pending facts, so the tree covers what you are
 *       actually reviewing rather than the whole roadmap
 */
import { readFileSync } from 'fs';
import N3 from 'n3';
import { QUEUE_PATH, transactPendingQueue } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

const APPLY = process.argv.includes('--apply');
const ONLY_QUEUED = process.argv.includes('--only-queued');
const ROADMAP = 'static/reckons-roadmap.ttl';
const KPRED = 'urn:kbase:predicate/';
const AGENT = 'offline:queue-dependencies';

const quads = new N3.Parser().parse(readFileSync(ROADMAP, 'utf8'));
const label = new Map<string, string>();
const featureId = new Map<string, string>();
const deps: Array<{ from: string; to: string }> = [];

for (const q of quads) {
  const s = q.subject.value, p = q.predicate.value, o = q.object.value;
  if (p.endsWith('2000/01/rdf-schema#label')) label.set(s, o);
  else if (p === `${KPRED}feature-id`) featureId.set(s, o);
  else if (p === `${KPRED}depends-on` && q.object.termType === 'NamedNode') deps.push({ from: s, to: o });
}

const name = (iri: string) => {
  const id = featureId.get(iri);
  return `${id ? `${id} ` : ''}${label.get(iri) ?? iri.replace(/^urn:kbase:concept\//, 'kb:')}`;
};

// Existing queue: for --only-queued, and to avoid proposing the same edge twice.
const existing = readFileSync(QUEUE_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
  .filter((r): r is Record<string, unknown> => !!r);

const subjectsWithFacts = new Set(existing.map((r) => String(r.subject)));
const alreadyProposed = new Set(
  existing
    .filter((r) => r.predicate === `${KPRED}depends-on`)
    .map((r) => `${r.subject}|${r.object}`),
);

const now = new Date().toISOString();
const candidates = deps
  .filter(({ from, to }) => !alreadyProposed.has(`${from}|${to}`))
  .filter(({ from, to }) => !ONLY_QUEUED || subjectsWithFacts.has(from) || subjectsWithFacts.has(to));

const rows = candidates.map(({ from, to }) => ({
  subject: from,
  predicate: `${KPRED}depends-on`,
  object: to,
  // Without this the drain writes the object as a literal and the edge becomes a leaf.
  objectKind: 'iri' as const,
  // Provable by construction: every row here is transcribed from the canonical roadmap graph in
  // this same run, so the claim "the roadmap says X depends on Y" is re-derivable by reading that
  // file. Queueing them as questions asked a human to confirm a copy operation.
  verifiedBy: 'script:queue-dependencies/roadmap-edge',
  kb: 'roadmap',
  type: 'suggestion' as const,
  priority: 'normal' as const,
  agent: AGENT,
  addedAt: now,
  addedByMcp: true,
  note: `${name(from)} depends on ${name(to)} — stated in the roadmap graph.`,
}));

console.log(`\n${B}Roadmap dependency edges → pending facts${X}`);
console.log(`${D}${'─'.repeat(74)}${X}`);
console.log(`  ${String(deps.length).padStart(4)} depends-on edges in ${ROADMAP}`);
if (alreadyProposed.size) console.log(`  ${String(alreadyProposed.size).padStart(4)} ${D}already proposed — skipped${X}`);
if (ONLY_QUEUED) console.log(`  ${D}restricted to features that already have pending facts${X}`);
console.log(`  ${G}${String(rows.length).padStart(4)} to queue${X}\n`);

for (const r of rows.slice(0, 12)) {
  console.log(`  ${C}${name(r.subject)}${X}`);
  console.log(`    ${D}depends-on →${X} ${name(r.object)}`);
}
if (rows.length > 12) console.log(`  ${D}… and ${rows.length - 12} more${X}`);

console.log(`\n${D}${'─'.repeat(74)}${X}`);
if (!APPLY) {
  console.log(`${Y}dry-run — nothing written.${X} Re-run with ${B}--apply${X} to queue these.`);
} else if (rows.length === 0) {
  console.log(`${Y}nothing to queue.${X}`);
} else {
  const added = transactPendingQueue(QUEUE_PATH, (cur) => {
    const base = cur.trim() ? cur.trimEnd() + '\n' : '';
    return { content: base + rows.map((r) => JSON.stringify(r)).join('\n') + '\n', result: rows.length };
  });
  console.log(`${G}✓ queued ${added} dependency fact(s)${X} — drain the roadmap graph to review them.`);
  console.log(`${D}  They import as real edges (objectKind: iri), so the tree layout has structure to draw.${X}`);
}
console.log('');
