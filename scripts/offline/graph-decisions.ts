#!/usr/bin/env npx tsx
/**
 * Render a graph's HIERARCHICAL REVIEW TREE (F139, script tier) — the open decisions, with the
 * case for each one underneath and the bookkeeping behind a count.
 *
 * This is the command that answers Matt's question directly: of everything this graph says, what
 * is actually a DECISION, and what is a datetime stamp of work being done? It reads
 * src/lib/rdf/review-tree.ts — the same pure function the review surface uses — so what prints
 * here is what the UI will show, not a separate report that can drift from it.
 *
 * Sibling commands, deliberately not merged:
 *   altitude-report.ts   the CENSUS — how much of a graph is decisions vs bookkeeping.
 *   queue-tree.ts        the ORDER — which decision to take first, by the roadmap's dependency DAG.
 *   this                 the DEPTH — for one decision, what is the case for it.
 *
 * HONEST LIMIT: it reads the graph as WRITTEN (see read-graph.ts). Every statement is treated as
 * a live review item so the tree can be seen at all; in the app the pending slice is much smaller.
 * So the counts here are an UPPER BOUND on what review would show, not a prediction of it.
 *
 *   npx tsx scripts/offline/graph-decisions.ts                      the roadmap
 *   npx tsx scripts/offline/graph-decisions.ts static/knowledge.ttl one graph
 *   npx tsx scripts/offline/graph-decisions.ts --limit=20 --facts   more roots, with the facts
 */
import { readGraph } from './read-graph.js';
import { buildReviewTree, reviewTreeSummary, distillationRequest, questionText } from '../../src/lib/rdf/review-tree.js';
import { isLit } from '../../src/lib/rdf/types.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', M = '\x1b[35m', R = '\x1b[31m', X = '\x1b[0m';

const args = process.argv.slice(2);
const WITH_FACTS = args.includes('--facts');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 8;
const file = args.find((a) => !a.startsWith('--')) ?? 'static/reckons-roadmap.ttl';

// Opt in explicitly: a committed TTL holds no pending facts, so without this the tree correctly
// reports nothing to review. See read-graph.ts.
const { statements, typeOf } = readGraph(file, { asReviewSet: true });
const tree = buildReviewTree(statements, statements, { typeOf });

const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

console.log(`\n${B}${file}${X} ${D}— hierarchical review tree${X}`);
console.log(`${reviewTreeSummary(tree)}\n`);

for (const d of tree.decisions.slice(0, LIMIT)) {
  const flags = [
    d.contested ? `${R}CONTESTED${X}` : '',
    d.impliedBy === 'conflict' ? `${M}implied${X}` : '',
    d.escalate === 'stp' ? `${M}→ needs a reckoning${X}` : '',
    d.forcedBy.length ? `${Y}deadline${X}` : '',
    d.unlocks ? `${G}unlocks ${d.unlocks}${X}` : '',
    d.status ? `${D}${d.status}${X}` : '',
  ].filter(Boolean).join(' ');

  console.log(`${C}◆ ${B}${d.label}${X}${flags ? `  ${flags}` : ''}`);
  console.log(`  ${Y}?${X} ${oneLine(questionText(d), 220)}`);

  if (d.options.length) {
    for (const o of d.options) {
      console.log(`    ${G}○ ${o.label}${X} ${D}— costs ${o.rulesOut.length} fact${o.rulesOut.length === 1 ? '' : 's'}${X}`);
      if (WITH_FACTS) for (const c of o.rulesOut.slice(0, 4)) console.log(`        ${D}✗ ${oneLine(c.s.value, 70)}${X}`);
    }
  } else {
    // The state measured 2026-08-19 for every open decision in the roadmap. Say so rather than
    // rendering an empty options list as though the question were simple.
    console.log(`    ${D}prose only — no options modelled, so there is nothing to weigh side by side${X}`);
    console.log(`    ${D}→ distill: ${distillationRequest(d).task}, grounded in ${distillationRequest(d).sourceIds.length} facts${X}`);
  }

  const parts = [
    d.standing.length ? `${d.standing.length} standing` : '',
    d.judgments.length ? `${d.judgments.length} judgments` : '',
    d.evidence.length ? `${d.evidence.length} evidence` : '',
    d.hidden.length ? `${D}⌄ ${d.hidden.length} hidden${X}` : '',
  ].filter(Boolean).join(' · ');
  if (parts) console.log(`    ${D}${parts}${X}`);

  if (WITH_FACTS) {
    for (const j of d.judgments.slice(0, 3)) console.log(`      ${D}• ${oneLine(isLit(j.o) ? j.o.value : j.o.value, 120)}${X}`);
    for (const e of d.evidence.slice(0, 3)) console.log(`      ${G}▪ ${oneLine(isLit(e.o) ? e.o.value : e.o.value, 120)}${X}`);
  }
  console.log();
}

if (tree.decisions.length > LIMIT) {
  console.log(`${D}… ${tree.decisions.length - LIMIT} more open decisions (--limit=${tree.decisions.length})${X}\n`);
}
console.log(`${D}never shown to a person : ${tree.suppressed.record} records, ${tree.suppressed.log} logs${X}`);
console.log(`${D}a check could settle    : ${tree.machineSettleable.length}${X}`);
console.log(`${D}judgments under no decision : ${tree.orphans.length} ${D}(the clustering candidates)${X}\n`);
