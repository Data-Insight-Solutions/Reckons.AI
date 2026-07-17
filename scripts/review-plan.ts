#!/usr/bin/env npx tsx
/**
 * Run the review-at-scale pipeline over the REAL pending queue and print the plan.
 *
 * Dogfooding, and a verification: the unit tests prove the pipeline on synthetic input; this
 * proves it on the actual reckons-workspace/knowledge.pending.jsonl the app would load. It also
 * gives Matt a real triage view of the queue — what folds, what a machine settles, what is
 * genuinely his, and the few contested decisions worth his attention.
 *
 *   npx tsx scripts/review-plan.ts            plan over reckons-workspace/knowledge.pending.jsonl
 *   npx tsx scripts/review-plan.ts <file>     plan over a specific pending file
 *
 * Reads only; settles nothing.
 */
import { existsSync, readFileSync } from 'fs';
import { buildReviewPlan, reviewPlanSummary } from '../src/lib/rdf/review-pipeline.js';
import { lexicalFactSimilarity } from '../src/lib/rdf/lexical-similarity.js';
import type { Statement, ReviewStatus } from '../src/lib/rdf/types.js';

const FILE = process.argv[2] ?? 'reckons-workspace/knowledge.pending.jsonl';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

if (!existsSync(FILE)) {
  console.error(`No pending file at ${FILE}`);
  process.exit(1);
}

const priorityToConfidence: Record<string, number> = { high: 0.9, normal: 0.7, medium: 0.7, low: 0.5 };

const statements: Statement[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((line, i) => {
    try {
      const e = JSON.parse(line);
      const partial = e.object == null || e.object === '' || e.object === '?';
      const st: Statement = {
        id: `pending-${i}`,
        s: { kind: 'iri', value: String(e.subject) },
        p: { kind: 'iri', value: String(e.predicate) },
        o: { kind: 'literal', value: partial ? '?' : String(e.object) },
        g: { kind: 'iri', value: 'urn:reckons:pending' },
        sourceId: 'pending',
        confidence: priorityToConfidence[e.priority ?? 'normal'] ?? 0.7,
        status: 'pending' as ReviewStatus,
        createdAt: i,
        updatedAt: i,
        ...(partial ? { needsObject: true, question: e.question ?? e.note } : {}),
      };
      return [st];
    } catch {
      return [];
    }
  });

// Use the free lexical similarity for the suggest tier (embeddings would refine it at runtime).
const plan = buildReviewPlan(statements, { similarity: lexicalFactSimilarity });

console.log(`${B}Review plan${X} ${D}— ${statements.length} pending fact(s) from ${FILE}${X}\n`);
console.log(`  ${reviewPlanSummary(plan)}\n`);

console.log(`${B}by competence (F88)${X}`);
console.log(`  ${D}machine settles${X}  ${plan.routed.machine.length}`);
console.log(`  ${D}agent settles${X}    ${plan.routed.agent.length}`);
console.log(`  ${C}yours to decide${X}  ${plan.routed.user.length}   ${D}(${plan.entityCards.length} entity card(s))${X}\n`);

if (plan.attention.spotlight.length > 0) {
  console.log(`${B}${Y}the spotlight${X} ${D}— the contested few worth your attention first${X}`);
  for (const item of plan.attention.spotlight) {
    const flag = item.conflict ? `${Y}CONFLICT${X}` : item.decision ? `${C}DECISION${X}` : `impact ${item.impact}`;
    const subj = item.statement.s.value.split('/').pop();
    const pred = item.statement.p.value.split('/').pop();
    console.log(`  ${flag}  ${subj} ${D}·${X} ${pred}  ${D}(score ${item.score.toFixed(2)})${X}`);
  }
  if (plan.attention.heldBack > 0) console.log(`  ${D}+${plan.attention.heldBack} more waiting for the next pass${X}`);
  console.log('');
}

console.log(`${B}top entity cards${X} ${D}— decide about things, not rows${X}`);
for (const card of plan.entityCards.slice(0, 10)) {
  const bits = [
    card.additions ? `${card.additions} add` : '',
    card.removals ? `${card.removals} del` : '',
    card.questions ? `${card.questions} q` : '',
  ].filter(Boolean).join(', ');
  console.log(`  ${D}[${card.gate}]${X} ${card.label} ${D}— ${card.facts.length} fact(s): ${bits}${X}`);
}
if (plan.entityCards.length > 10) console.log(`  ${D}… and ${plan.entityCards.length - 10} more${X}`);

if (plan.mergeSuggestions.length > 0) {
  console.log(`\n${B}merge suggestions${X} ${D}— near-duplicate facts (lexical; review before merging)${X}`);
  for (const g of plan.mergeSuggestions.slice(0, 8)) {
    const a = g.keep.s.value.split('/').pop();
    const b = g.duplicates[0].s.value.split('/').pop();
    const pred = g.keep.p.value.split('/').pop();
    console.log(`  ${G}~${X} ${a} ${D}≈${X} ${b}  ${D}on ${pred} (sim ${g.similarity.toFixed(2)})${X}`);
  }
  if (plan.mergeSuggestions.length > 8) console.log(`  ${D}… and ${plan.mergeSuggestions.length - 8} more${X}`);
}
