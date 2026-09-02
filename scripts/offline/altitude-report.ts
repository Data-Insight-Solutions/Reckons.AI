#!/usr/bin/env npx tsx
/**
 * Measure a graph by ALTITUDE (F139, script tier) — how much of it is decisions, and how much
 * of it is bookkeeping nobody should ever have been shown.
 *
 * THIS SCRIPT EXISTS TO FALSIFY ITS OWN FEATURE. The altitude tree only works if altitude is
 * derivable from what the graph already says. That is a claim about real data, so it gets
 * measured rather than asserted — and the number that matters most is the UNCLASSIFIED share,
 * because every unclassified fact defaults to `judgment` and lands in front of a person. A
 * design that hides noise by guessing has just moved the noise, and this is the check that
 * catches it.
 *
 * Complements scripts/offline/queue-tree.ts rather than repeating it: that orders decisions by
 * the roadmap's dependency DAG (which to take FIRST), this classifies facts by consequence
 * (which are worth taking AT ALL). Depth and order are different questions.
 *
 *   npx tsx scripts/offline/altitude-report.ts                      all static/*.ttl
 *   npx tsx scripts/offline/altitude-report.ts static/knowledge.ttl one graph
 *   npx tsx scripts/offline/altitude-report.ts --unclassified       the predicates to go fix
 */
import { readFileSync, readdirSync } from 'fs';
import N3 from 'n3';
import {
  altitudeOf, isClassified, isOpenDecision, censusByAltitude,
  ALTITUDE_RANK, type Altitude,
} from '../../src/lib/rdf/fact-altitude.js';
import type { Statement } from '../../src/lib/rdf/types.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', R = '\x1b[31m', X = '\x1b[0m';

const args = process.argv.slice(2);
const SHOW_UNCLASSIFIED = args.includes('--unclassified');
const files = args.filter((a) => !a.startsWith('--'));

const targets = files.length
  ? files
  : readdirSync('static').filter((f) => f.endsWith('.ttl')).map((f) => `static/${f}`);

/** Minimal Statement shape — this reads a graph, it does not review one. */
function toStatements(ttl: string): Statement[] {
  const quads = new N3.Parser().parse(ttl);
  return quads.map((q, i) => ({
    id: String(i),
    s: { kind: q.subject.termType === 'Literal' ? 'literal' : 'iri', value: q.subject.value },
    p: { kind: 'iri', value: q.predicate.value },
    o: { kind: q.object.termType === 'Literal' ? 'literal' : 'iri', value: q.object.value },
    g: { kind: 'iri', value: 'urn:kbase:graph/report' },
    sourceId: 'report', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  })) as unknown as Statement[];
}

const ORDER: Altitude[] = ['decision', 'judgment', 'evidence', 'record', 'log'];
const COLOR: Record<Altitude, string> = { decision: C, judgment: Y, evidence: G, record: D, log: D };

const unclassifiedPreds = new Map<string, number>();
let grandTotal = 0, grandClassified = 0, grandSuppressed = 0, grandOpen = 0;

console.log(`\n${B}Altitude census${X} ${D}— if this fact were wrong, what would we do differently?${X}\n`);

for (const file of targets) {
  let statements: Statement[];
  try {
    statements = toStatements(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`${R}✗ ${file}${X} — does not parse: ${(e as Error).message.split('\n')[0]}`);
    continue;
  }
  if (statements.length === 0) continue;

  const census = censusByAltitude(statements);
  const open = statements.filter(isOpenDecision).length;
  for (const st of statements) {
    if (!isClassified(st)) unclassifiedPreds.set(st.p.value, (unclassifiedPreds.get(st.p.value) ?? 0) + 1);
  }

  grandTotal += census.total;
  grandClassified += census.classified;
  grandSuppressed += census.counts.record + census.counts.log;
  grandOpen += open;

  const cov = census.total ? (census.classified / census.total) * 100 : 0;
  const covColor = cov >= 90 ? G : cov >= 60 ? Y : R;
  console.log(
    `${B}${file}${X} ${D}${census.total} facts${X}  ` +
      `coverage ${covColor}${cov.toFixed(1)}%${X}  ` +
      `suppressed ${(census.suppressedShare * 100).toFixed(1)}%  ` +
      `${C}${open} open decision${open === 1 ? '' : 's'}${X}`,
  );
  const bars = ORDER.map((a) => {
    const n = census.counts[a];
    const pct = census.total ? (n / census.total) * 100 : 0;
    return `${COLOR[a]}${a.padEnd(9)}${String(n).padStart(5)} ${pct.toFixed(1).padStart(5)}%${X}`;
  });
  console.log(`  ${bars.join('  ')}\n`);
}

const cov = grandTotal ? (grandClassified / grandTotal) * 100 : 0;
const sup = grandTotal ? (grandSuppressed / grandTotal) * 100 : 0;
console.log(`${B}Across ${targets.length} graph${targets.length === 1 ? '' : 's'}:${X} ${grandTotal} facts`);
console.log(`  predicate coverage        ${cov >= 90 ? G : Y}${cov.toFixed(1)}%${X} ${D}(the rest default to judgment and reach a human)${X}`);
console.log(`  never shown to a person   ${G}${sup.toFixed(1)}%${X} ${D}(record + log)${X}`);
console.log(`  open decisions            ${C}${grandOpen}${X} ${D}(the live items — what review is actually for)${X}`);

if (unclassifiedPreds.size) {
  const top = [...unclassifiedPreds.entries()].sort((a, b) => b[1] - a[1]);
  const shown = SHOW_UNCLASSIFIED ? top : top.slice(0, 10);
  console.log(`\n${Y}Unclassified predicates${X} ${D}— ${unclassifiedPreds.size} distinct; each defaults to judgment. Fix these, not the classifier.${X}`);
  for (const [p, n] of shown) console.log(`  ${String(n).padStart(5)}  ${p.replace('urn:kbase:predicate/', 'kpred:')}`);
  if (!SHOW_UNCLASSIFIED && top.length > shown.length) console.log(`  ${D}… ${top.length - shown.length} more (--unclassified)${X}`);
}
console.log();
