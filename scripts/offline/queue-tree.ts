#!/usr/bin/env npx tsx
/**
 * Order pending decisions by the roadmap's own dependency DAG (F74.3, script tier).
 *
 * THE PROBLEM. The queue has no usable concept of relations between pending facts: only 8 of 529
 * rows carry `blocks`, so `blastRadius()` has almost nothing to walk and every fact looks equally
 * urgent. Presented as a flat list, 529 rows is not a backlog — it is a wall.
 *
 * THE INSIGHT. The relations are not missing, they are just somewhere else. The roadmap graph
 * already states which feature needs which (`kpred:depends-on`, 140 edges), and most queue subjects
 * ARE features. So the ordering can be projected from the plan instead of invented: decide the
 * prerequisite before the thing that needs it, because deciding a feature whose foundation is still
 * undecided is how you end up revisiting it.
 *
 * The tree therefore reads PREREQUISITE FIRST. `F81 depends-on F80` puts F80 above F81: settle F80's
 * facts, then walk down to the more specific facts that were waiting on it.
 *
 *   unlocks   how many features transitively depend on this one — what settling it releases.
 *   facts     pending rows about this feature, i.e. what there actually is to decide here.
 *
 * HONEST LIMITS. This orders what the roadmap describes; it does not rank importance. A feature
 * absent from the DAG is listed separately as unordered, NOT as unimportant — the plan simply says
 * nothing about its prerequisites. Cycles are reported rather than broken silently. Nothing is
 * settled, written or deleted: this reads the graph and the queue and prints an order.
 *
 *   npx tsx scripts/offline/queue-tree.ts             the dependency-ordered decision tree
 *   npx tsx scripts/offline/queue-tree.ts --facts     include each node's pending fact text
 *   npx tsx scripts/offline/queue-tree.ts --all       also list subjects outside the DAG
 */
import { readFileSync } from 'fs';
import N3 from 'n3';
import { QUEUE_PATH } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', M = '\x1b[35m', X = '\x1b[0m';

const WITH_FACTS = process.argv.includes('--facts');
const SHOW_ALL = process.argv.includes('--all');
const ROADMAP = 'static/reckons-roadmap.ttl';
const KPRED = 'urn:kbase:predicate/';

// ── The plan: features, their dependencies, and their status ────────────────
const quads = new N3.Parser().parse(readFileSync(ROADMAP, 'utf8'));
const label = new Map<string, string>();
const featureId = new Map<string, string>();
const status = new Map<string, string>();
/** feature -> the features it NEEDS (its prerequisites). */
const needs = new Map<string, Set<string>>();

for (const q of quads) {
  const s = q.subject.value, p = q.predicate.value, o = q.object.value;
  if (p.endsWith('2000/01/rdf-schema#label')) label.set(s, o);
  else if (p === `${KPRED}feature-id`) featureId.set(s, o);
  else if (p === `${KPRED}has-status`) status.set(s, o);
  else if (p === `${KPRED}depends-on`) needs.set(s, (needs.get(s) ?? new Set()).add(o));
}

// ── The queue: pending facts grouped by subject ─────────────────────────────
type Row = { subject: string; type?: string; priority?: string; text: string };
const rows: Row[] = readFileSync(QUEUE_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .map((r: any) => ({
    subject: String(r.subject),
    type: r.type,
    priority: r.priority,
    text: String(r.question ?? r.note ?? r.object ?? ''),
  }));

const factsBy = new Map<string, Row[]>();
for (const r of rows) factsBy.set(r.subject, [...(factsBy.get(r.subject) ?? []), r]);

// ── Reverse the DAG: prerequisite -> the features that need it ──────────────
const unlocks = new Map<string, Set<string>>();
for (const [feature, prereqs] of needs) {
  for (const p of prereqs) unlocks.set(p, (unlocks.get(p) ?? new Set()).add(feature));
}

/** Every feature the DAG mentions AND that has pending facts. */
const inPlay = new Set<string>();
for (const s of factsBy.keys()) if (needs.has(s) || unlocks.has(s)) inPlay.add(s);

/** Transitive count of features released by settling this one. Cycles are not re-entered. */
const reachMemo = new Map<string, number>();
function reach(f: string, seen = new Set<string>()): number {
  if (reachMemo.has(f)) return reachMemo.get(f)!;
  if (seen.has(f)) return 0;
  seen.add(f);
  const out = new Set<string>();
  for (const d of unlocks.get(f) ?? []) {
    out.add(d);
    for (let i = 0; i < reach(d, seen); i++) out.add(`${d}#${i}`);
  }
  seen.delete(f);
  reachMemo.set(f, out.size);
  return out.size;
}

const name = (f: string) => {
  const id = featureId.get(f);
  const l = label.get(f) ?? f.replace(/^urn:kbase:concept\//, 'kb:');
  return `${id ? `${id} ` : ''}${l}`;
};

/** Roots: in-play features whose own prerequisites are NOT themselves in play. */
const roots = [...inPlay].filter((f) => ![...(needs.get(f) ?? [])].some((p) => inPlay.has(p)));

console.log(`\n${B}Decision tree${X} ${D}— pending facts ordered by the roadmap's depends-on DAG${X}`);
console.log(`${D}${'─'.repeat(78)}${X}`);
console.log(`${D}Prerequisites first. Settle a parent, then walk down to the facts that waited on it.${X}\n`);

const printed = new Set<string>();
function render(f: string, depth: number, trail: Set<string>): void {
  if (trail.has(f)) {
    console.log(`${'  '.repeat(depth)}${Y}↺ cycle back to ${name(f)}${X}`);
    return;
  }
  const facts = factsBy.get(f) ?? [];
  const n = reach(f);
  const st = status.get(f);
  const seen = printed.has(f);
  const bullet = depth === 0 ? `${M}●${X}` : `${D}└─${X}`;

  console.log(
    `${'  '.repeat(depth)}${bullet} ${B}${name(f)}${X}` +
    (facts.length ? ` ${C}${facts.length} fact${facts.length > 1 ? 's' : ''}${X}` : ` ${D}(no pending facts)${X}`) +
    (n ? ` ${D}· unlocks ${n}${X}` : '') +
    (st ? ` ${D}[${st}]${X}` : '') +
    (seen ? ` ${D}(shown above)${X}` : ''),
  );

  if (WITH_FACTS && !seen) {
    for (const r of facts) {
      console.log(`${'  '.repeat(depth + 1)}  ${D}[${r.type ?? '?'}]${X} ${r.text.replace(/\s+/g, ' ').slice(0, 130)}`);
    }
  }
  if (seen) return;
  printed.add(f);

  const next = new Set([...trail, f]);
  for (const child of [...(unlocks.get(f) ?? [])].filter((c) => inPlay.has(c)).sort((a, b) => reach(b) - reach(a))) {
    render(child, depth + 1, next);
  }
}

for (const r of roots.sort((a, b) => reach(b) - reach(a) || (factsBy.get(b)?.length ?? 0) - (factsBy.get(a)?.length ?? 0))) {
  render(r, 0, new Set());
  console.log('');
}

// ── Everything the DAG says nothing about ───────────────────────────────────
const unordered = [...factsBy.keys()].filter((s) => !inPlay.has(s));
const unorderedFacts = unordered.reduce((n, s) => n + (factsBy.get(s)?.length ?? 0), 0);
console.log(`${D}${'─'.repeat(78)}${X}`);
console.log(
  `${B}${inPlay.size}${X} subject(s) ordered by the plan; ` +
  `${B}${unordered.length}${X} subject(s) / ${B}${unorderedFacts}${X} fact(s) the DAG says nothing about.`,
);
console.log(`${D}Unordered is not unimportant — the roadmap simply states no prerequisites for them.${X}`);

if (SHOW_ALL) {
  console.log(`\n${B}unordered subjects${X}`);
  for (const s of unordered.sort((a, b) => (factsBy.get(b)?.length ?? 0) - (factsBy.get(a)?.length ?? 0)).slice(0, 25)) {
    console.log(`  ${String(factsBy.get(s)?.length).padStart(4)}  ${s.replace(/^urn:kbase:concept\//, 'kb:')}`);
  }
}
console.log('');
