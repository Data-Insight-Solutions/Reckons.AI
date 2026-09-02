#!/usr/bin/env npx tsx
/**
 * THE WHOLE CHAIN, END TO END, ON ONE GRAPH (script tier — no model, no tokens).
 *
 * WHY THIS EXISTS. Matt, 2026-09-02: "vocabulary, hierarchy and other important elements of
 * extraction and analysis need to work well together, to make a clear cohesive decision tree for
 * review." Every stage in that sentence is built and unit-tested IN ISOLATION — vocabulary-repair,
 * entity-typing, hierarchy, fact-aggregation, review-tree each have their own test file — and
 * NOTHING measures them composed. So a defect that lives in the seam between two stages is
 * invisible to all of them, which is exactly where the two bugs fixed in 4b1e773 were living.
 *
 * This runs the stages in the order a fact actually meets them and reports what each one
 * CONTRIBUTES, so refinement has a baseline to move. It settles nothing and writes no graph.
 *
 *   read       what the graph actually contains (via the app's importer, not a quad count)
 *   vocabulary entity names that look like damaged versions of other entity names
 *   typing     how many entities a deterministic survey can type
 *   hierarchy  roots, depth, and how many entities hang under nothing
 *   aggregate  how many questions the cascade floor can form, and how much they settle
 *   tree       the decision tree a person actually faces
 *
 * The last line is the one that matters: FACTS PER DECISION. A chain that is working turns many
 * facts into few decisions; a chain that is not leaves a person a flat list with a summary on top.
 *
 *   npx tsx scripts/offline/extraction-chain.ts --graph=<path>
 *   … --json     machine-readable, for a test to assert on
 */
import { readGraph } from './read-graph.js';
import { buildVocabulary, repairCandidates } from '../../src/lib/rdf/vocabulary-repair.js';
import { surveyTypes } from '../../src/lib/rdf/entity-typing.js';
import { BUILT_IN_TYPES } from '../../src/lib/rdf/entity-types.js';
import { buildHierarchy } from '../../src/lib/rdf/hierarchy.js';
import { clusterForCascade, cascadeSummary } from '../../src/lib/rdf/fact-aggregation.js';
import { buildReviewTree, reviewTreeSummary } from '../../src/lib/rdf/review-tree.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', R = '\x1b[31m', X = '\x1b[0m';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const GRAPH = arg('graph', 'reckons-workspace/kbs/personal-notes/personal-notes.ttl');
const JSON_OUT = args.includes('--json');

const KCONCEPT = 'urn:kbase:concept/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Entity slug -> readable words. `orange-logic-is-an-enterprise-dam` -> "orange logic is an …". */
const words = (iri: string) => iri.replace(KCONCEPT, '').replace(/[-_]/g, ' ').trim();

export interface ChainReport {
  graph: string;
  read: { statements: number; entities: number; syntheticSource: boolean };
  vocabulary: { entries: number; suspects: Array<{ heard: string; match: string; reason: string; confidence: number }> };
  typing: { proposals: number; undecided: number; alreadyTyped: number };
  hierarchy: { roots: number; maxDepth: number; placed: number; orphans: number };
  aggregate: { clusters: number; covered: number; perQuestion: number };
  tree: { decisions: number; orphanJudgments: number; suppressed: number };
  verdict: { facts: number; decisions: number; factsPerDecision: number };
}

function depthOf(nodes: ReturnType<typeof buildHierarchy>, d = 1): number {
  let max = d;
  for (const n of nodes) if (n.children?.length) max = Math.max(max, depthOf(n.children, d + 1));
  return max;
}
function countPlaced(nodes: ReturnType<typeof buildHierarchy>): number {
  let n = 0;
  for (const node of nodes) n += 1 + countPlaced(node.children ?? []);
  return n;
}

/**
 * SENTENCE-SHAPED ENTITY SLUGS ARE THE LOUDEST EXTRACTION DEFECT AND NOTHING FLAGS THEM.
 * `kb:orange-logic-is-an-enterprise-dam` is a whole claim collapsed into one node: it can never
 * match another entity, never be typed, and never join a hierarchy, so every later stage silently
 * does nothing with it. A verb in the slug is the tell.
 */
const COPULA = /(^|-)(is|are|was|were|has|have|owns|uses|needs)(-|$)/;
function sentenceShaped(iri: string): boolean {
  const slug = iri.replace(KCONCEPT, '');
  return COPULA.test(slug) && slug.split('-').length >= 4;
}

/**
 * The analysis, separated from the printing so a test can assert on it. The CLI below is only a
 * renderer — every rule this file encodes is exercised by extraction-chain.test.ts against
 * tests/fixtures/extraction-chain.ttl.
 */
export async function runChain(graph: string): Promise<
  ChainReport & { seams: { sentenceEntities: string[] }; lines: { cascade: string; tree: string } }
> {
  const GRAPH = graph;
  const { statements, syntheticSource } = await readGraph(GRAPH, { asReviewSet: true });

  // ── READ ──────────────────────────────────────────────────────────────────
  const entities = new Set<string>();
  for (const st of statements) {
    if (st.s.kind === 'iri') entities.add(st.s.value);
    if (st.o.kind === 'iri') entities.add(st.o.value);
  }
  const typeOf = (iri: string) =>
    statements.find((st) => st.s.value === iri && st.p.value === RDF_TYPE)?.o.value;

  // ── VOCABULARY ────────────────────────────────────────────────────────────
  // Ask the repair tier what it makes of the graph's OWN entity names. A name that closely matches
  // a different name in the same graph is the mis-transcription signature: "enterprise dam" beside
  // "enterprise dams", "Recon's AI" beside "Reckons.AI".
  const vocabulary = buildVocabulary(statements);
  const suspects: ChainReport['vocabulary']['suspects'] = [];
  const seen = new Set<string>();
  for (const entry of vocabulary) {
    const others = vocabulary.filter((v) => v.iri !== entry.iri);
    for (const cand of repairCandidates(entry.name, others, 2)) {
      if (cand.confidence >= 0.7 && cand.reason !== 'exact') {
        const key = [entry.name, cand.match].sort().join('~');
        if (seen.has(key)) continue;
        seen.add(key);
        suspects.push({ heard: entry.name, match: cand.match, reason: cand.reason, confidence: cand.confidence });
      }
    }
  }
  suspects.sort((a, b) => b.confidence - a.confidence);

  // ── TYPING ────────────────────────────────────────────────────────────────
  const survey = surveyTypes(statements, BUILT_IN_TYPES, []);

  // ── HIERARCHY ─────────────────────────────────────────────────────────────
  const roots = buildHierarchy(statements);
  const placed = countPlaced(roots);

  // ── AGGREGATE ─────────────────────────────────────────────────────────────
  const clusters = clusterForCascade(statements, { syntheticSource });
  const covered = clusters.reduce((n, c) => n + c.members.length, 0);

  // ── TREE ──────────────────────────────────────────────────────────────────
  const tree = buildReviewTree(statements, statements, { typeOf });
  const suppressed = tree.suppressed.record + tree.suppressed.log;

  const decisions = tree.decisions.length + clusters.length;
  const report: ChainReport = {
    graph: GRAPH,
    read: { statements: statements.length, entities: entities.size, syntheticSource },
    vocabulary: { entries: vocabulary.length, suspects: suspects.slice(0, 12) },
    typing: { proposals: survey.proposals.length, undecided: survey.undecided.length, alreadyTyped: survey.alreadyTyped },
    hierarchy: { roots: roots.length, maxDepth: roots.length ? depthOf(roots) : 0, placed, orphans: Math.max(0, entities.size - placed) },
    aggregate: { clusters: clusters.length, covered, perQuestion: clusters.length ? covered / clusters.length : 0 },
    tree: { decisions: tree.decisions.length, orphanJudgments: tree.orphans.length, suppressed },
    verdict: { facts: statements.length, decisions, factsPerDecision: decisions ? statements.length / decisions : 0 },
  };

  return {
    ...report,
    seams: { sentenceEntities: [...entities].filter(sentenceShaped) },
    // The renderer needs the prose summaries too; recomputing them in main() meant reading the
    // graph twice and drifting from what was measured.
    lines: { cascade: cascadeSummary(clusters), tree: reviewTreeSummary(tree) },
  };
}

export type ChainResult = Awaited<ReturnType<typeof runChain>>;

async function main() {
  const r = await runChain(GRAPH);
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return; }

  console.log(`\n${B}Extraction chain${X} ${D}— ${r.graph}${X}\n`);

  console.log(`${B}1 read${X}        ${r.read.statements} statements · ${r.read.entities} entities` +
    (r.read.syntheticSource ? ` ${Y}(no recorded sources — provenance is synthetic)${X}` : ''));

  const v = r.vocabulary;
  console.log(`${B}2 vocabulary${X}  ${v.entries} names · ${v.suspects.length ? `${Y}${v.suspects.length} look like damaged twins${X}` : `${G}no near-duplicates${X}`}`);
  for (const s of v.suspects.slice(0, 6)) {
    console.log(`  ${D}·${X} ${C}${s.heard}${X} ${D}~${X} ${C}${s.match}${X} ${D}(${s.reason}, ${s.confidence.toFixed(2)})${X}`);
  }

  const t = r.typing;
  const typable = t.proposals + t.undecided;
  console.log(`${B}3 typing${X}      ${t.alreadyTyped} typed · ${t.proposals} proposable · ${t.undecided} undecided` +
    (typable ? ` ${D}(${((t.proposals / typable) * 100).toFixed(0)}% of untyped settleable)${X}` : ''));

  const h = r.hierarchy;
  console.log(`${B}4 hierarchy${X}   ${h.roots} root(s) · depth ${h.maxDepth} · ${h.placed} placed · ` +
    (h.orphans ? `${Y}${h.orphans} under nothing${X}` : `${G}none loose${X}`));

  console.log(`${B}5 aggregate${X}   ${r.lines.cascade}`);
  console.log(`${B}6 tree${X}        ${r.lines.tree}`);

  // ── THE SEAMS ─────────────────────────────────────────────────────────────
  const sentences = r.seams.sentenceEntities;
  console.log(`\n${B}Seams${X} ${D}— where a stage's output reaches no later stage${X}`);
  if (sentences.length) {
    console.log(`  ${R}✗${X} ${sentences.length} entit${sentences.length === 1 ? 'y is' : 'ies are'} a whole SENTENCE collapsed into one node —`);
    console.log(`    ${D}cannot be typed, matched or placed, so stages 2-4 silently skip them${X}`);
    for (const e of sentences.slice(0, 4)) console.log(`      ${D}·${X} ${words(e)}`);
  } else {
    console.log(`  ${G}✓${X} no sentence-shaped entity slugs`);
  }
  if (v.suspects.length && h.orphans) {
    console.log(`  ${R}✗${X} vocabulary found ${v.suspects.length} damaged twin(s) and hierarchy left ${h.orphans} orphan(s):`);
    console.log(`    ${D}repair does not run before placement, so a mis-heard name is placed as its own entity${X}`);
  }
  if (r.tree.orphanJudgments) {
    console.log(`  ${R}✗${X} ${r.tree.orphanJudgments} judgment(s) under NO decision — the tree has no root to hang them on`);
  }

  /*
   * THE HEADLINE SPLITS, BECAUSE THE AGGREGATE NUMBER FLATTERS. A first version printed
   * "217 facts -> 33 decisions (6.6 per decision)" in GREEN on a graph whose decision tree was
   * EMPTY: all 33 were bookkeeping batches from the cascade floor, and every one of the 53 actual
   * claims was an orphan judgment. A ratio that counts "accept this batch of links?" alongside a
   * real claim is a green light on a broken chain — the overclaim kb:honest-status forbids.
   */
  const claimsCovered = r.tree.decisions;
  const claimsLoose = r.tree.orphanJudgments;
  console.log(`\n${B}Verdict${X}`);
  console.log(`  ${D}bookkeeping${X}  ${G}${r.aggregate.covered} fact(s) → ${r.aggregate.clusters} batch question(s)${X}` +
    `${D}  (${r.aggregate.perQuestion.toFixed(1)} per question)${X}`);
  const claimColor = claimsCovered + claimsLoose === 0 ? D : claimsLoose === 0 ? G : claimsCovered === 0 ? R : Y;
  console.log(`  ${D}claims${X}       ${claimColor}${claimsCovered} under a decision · ${claimsLoose} loose${X}` +
    `${D}  ← this is the number that matters${X}`);
  if (claimsLoose && claimsCovered === 0) {
    console.log(`\n  ${R}THE DECISION TREE IS EMPTY.${X} Every claim is an orphan: nothing in the chain`);
    console.log(`  ${D}produced the structure a tree is built from, so review is a flat list of ${claimsLoose}.${X}`);
  }
  console.log(`${D}\nA working chain turns many facts into few decisions. A flat list with a summary on top is the failure.${X}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
