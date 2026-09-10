#!/usr/bin/env npx tsx
/**
 * LAYER CLASSIFICATION — THE RISK REPORT (F194). Script tier: deterministic, zero tokens.
 *
 * Matt, 2026-09-09: "Initial ingest of the repo into a graph is helpful, but not nearly as helpful
 * as a full analysis of the risk of the specific refactoring goals, documentation updates needed."
 *
 * He is right, and this is the tool that answers it before anybody classifies anything. Splitting
 * predicates into claim / provenance / question is not a taxonomy exercise — Matt also decided that
 * PROVENANCE AUTO-CONFIRMS, which turns the classification into a trust boundary. A predicate filed
 * as provenance writes into the confirmed graph with NO HUMAN REVIEW. So the question that governs
 * this whole refactor is not "which layer is this" but:
 *
 *     IF THIS PREDICATE WERE CLASSIFIED PROVENANCE, HOW MANY STATEMENTS STOP BEING REVIEWED?
 *
 * That number is the blast radius, it is computable without a model, and it should decide the order
 * the work is done in — biggest radius reviewed most carefully, not first-alphabetically.
 *
 * WHAT THIS IS NOT. It proposes no classification. Naming the layer of a predicate is judgment over
 * language and belongs to the agent tier (scripts/offline/layer-classify.ts) with a human gate.
 * This half is arithmetic, and the two are kept apart on purpose: a risk report that also guesses
 * is a risk report nobody checks.
 *
 * THE CORPUS CAVEAT, stated because it changes how the numbers should be read. This reads the
 * TTL graphs in static/, which are this project's own published graphs. A USER's graph lives in
 * IndexedDB and will contain predicates that appear nowhere here. So these counts size the work
 * for the repo and are a LOWER BOUND for the ecosystem — which is exactly why the migration path
 * for users cannot depend on this list being complete.
 *
 * Usage: npx tsx scripts/offline/layer-risk.ts [--quiet] [--json] [--top=N]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const CONTENT = join(ROOT, 'content');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');
const TOP = Number.parseInt(argv.find((a) => a.startsWith('--top='))?.split('=')[1] ?? '15', 10);

const KPRED = 'urn:kbase:predicate/';
const LAYER = `${KPRED}layer`;
const NOTATION = 'http://www.w3.org/2004/02/skos/core#notation';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface PredStat {
  local: string;
  uses: number;
  graphs: Set<string>;
  iriObjects: number;
  literalObjects: number;
  subjects: Set<string>;
  samples: string[];
}

/**
 * NAME-SHAPED SUSPICION, and it is deliberately NOT a classification.
 *
 * These stems are how a human would start reading the list — they are a search order, not a
 * verdict. `has-file` is provenance; `has-status` is a claim about a feature and merely looks
 * similar. Anything matching here is printed for ATTENTION, never auto-filed, because the whole
 * risk of this refactor is a predicate filed provenance that should not have been.
 */
const PROVENANCE_STEMS = /source|excerpt|derived|extracted|ingest|has-file|test-file|tested-by|repo|commit|git|url|deploy|scene|diagram|icon|glb|asset|page-section|page-slug|runs-on|encoding|content-size/i;
const QUESTION_STEMS = /open-question|unknown|unanswered|needs-|blocked-by|known-gap|todo/i;

function parseAll(): Map<string, Quad[]> {
  const out = new Map<string, Quad[]>();
  for (const f of readdirSync(STATIC_DIR).filter((n) => n.endsWith('.ttl'))) {
    // docs-all.ttl is a concatenation of the others; counting it doubles every predicate.
    if (f === 'docs-all.ttl') continue;
    try { out.set(f, new Parser().parse(readFileSync(join(STATIC_DIR, f), 'utf8'))); } catch { /* graph-lint reports parse failures */ }
  }
  return out;
}

/** Layers already declared, read from the vocabulary rather than hard-coded. */
function declaredLayers(byFile: Map<string, Quad[]>): { valid: Set<string>; assigned: Map<string, string> } {
  const valid = new Set<string>();
  const assigned = new Map<string, string>();
  for (const quads of byFile.values()) {
    for (const q of quads) {
      if (q.predicate.value === NOTATION && q.subject.value.startsWith('urn:kbase:type/layer/')) {
        valid.add(q.object.value);
      }
      if (q.predicate.value === LAYER) assigned.set(q.subject.value, q.object.value);
    }
  }
  return { valid, assigned };
}

function main(): void {
  const byFile = parseAll();
  const { valid, assigned } = declaredLayers(byFile);

  const stats = new Map<string, PredStat>();
  for (const [file, quads] of byFile) {
    for (const q of quads) {
      const p = q.predicate.value;
      if (!p.startsWith(KPRED) || p === LAYER) continue;
      const st = stats.get(p) ?? {
        local: p.slice(KPRED.length), uses: 0, graphs: new Set(), iriObjects: 0,
        literalObjects: 0, subjects: new Set(), samples: [],
      };
      st.uses++;
      st.graphs.add(file);
      st.subjects.add(q.subject.value);
      if (q.object.termType === 'NamedNode') st.iriObjects++; else st.literalObjects++;
      if (st.samples.length < 2 && q.object.termType === 'Literal') {
        st.samples.push(q.object.value.replace(/\s+/g, ' ').slice(0, 90));
      }
      stats.set(p, st);
    }
  }

  const all = [...stats.entries()].sort((a, b) => b[1].uses - a[1].uses);
  const unclassified = all.filter(([iri]) => !assigned.has(iri));
  const classified = all.filter(([iri]) => assigned.has(iri));
  const totalUses = all.reduce((n, [, s]) => n + s.uses, 0);

  // ── The blast radius, which is the whole point ──────────────────────────────
  const suspects = unclassified.filter(([, s]) => PROVENANCE_STEMS.test(s.local));
  const questionish = unclassified.filter(([, s]) => QUESTION_STEMS.test(s.local));
  const atRisk = suspects.reduce((n, [, s]) => n + s.uses, 0);

  /*
   * DOCUMENTATION IMPACT. A refactor that changes what "reviewed" means invalidates every page
   * that explains reviewing. Counted rather than guessed, because "update the docs" is not a plan
   * and a number is.
   */
  let docsMentioningReview = 0, docsMentioningTriples = 0, docsTotal = 0;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []);
  try {
    for (const f of walk(CONTENT)) {
      docsTotal++;
      const text = readFileSync(f, 'utf8').toLowerCase();
      if (/\breview|confirm|pending\b/.test(text)) docsMentioningReview++;
      if (/\btriple|predicate|subject.*object\b/.test(text)) docsMentioningTriples++;
    }
  } catch { /* content/ may not be built */ }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      predicates: all.length, classified: classified.length, unclassified: unclassified.length,
      totalUses, provenanceSuspects: suspects.length, usesAtRisk: atRisk,
      questionSuspects: questionish.length,
      docs: { total: docsTotal, mentioningReview: docsMentioningReview, mentioningTriples: docsMentioningTriples },
      top: unclassified.slice(0, TOP).map(([iri, s]) => ({
        predicate: s.local, uses: s.uses, graphs: s.graphs.size,
        objects: s.iriObjects > s.literalObjects ? 'iri' : 'literal',
        suspect: PROVENANCE_STEMS.test(s.local) ? 'provenance' : QUESTION_STEMS.test(s.local) ? 'question' : null,
      })),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(C.bold('layer classification — risk report') + C.dim(`  ${byFile.size} graph(s), ${totalUses} predicate use(s)`));
  console.log('');
  console.log(`  ${C.bold(String(all.length))} distinct kpred: predicates`);
  console.log(`  ${classified.length} classified, ${C.yellow(String(unclassified.length))} not yet`);
  if (valid.size > 0) console.log(C.dim(`  valid layers: ${[...valid].sort().join(', ')}`));
  console.log('');

  console.log(C.bold('  BLAST RADIUS — what auto-confirm would touch'));
  console.log(`    ${C.red(String(suspects.length))} predicate(s) read as provenance BY NAME, covering ${C.red(String(atRisk))} use(s).`);
  console.log(C.dim('    If every one were filed provenance, that many statements would enter a graph'));
  console.log(C.dim('    with no human review. That is the number this refactor is really about.'));
  console.log(C.dim('    Name-shaped suspicion only: has-file is provenance, has-status merely looks like it.'));
  console.log('');

  if (!QUIET) {
    console.log(C.bold(`  THE ${Math.min(TOP, unclassified.length)} BIGGEST UNCLASSIFIED, by use — review order, highest radius first`));
    for (const [, s] of unclassified.slice(0, TOP)) {
      const tag = PROVENANCE_STEMS.test(s.local) ? C.red('prov?')
        : QUESTION_STEMS.test(s.local) ? C.yellow('ques?') : C.dim('  —  ');
      const kind = s.iriObjects > s.literalObjects ? 'iri' : 'lit';
      console.log(`    ${tag} ${C.cyan(s.local.padEnd(26))} ${String(s.uses).padStart(5)} use(s)  ${String(s.graphs.size).padStart(2)} graph(s)  ${kind}`);
      if (s.samples[0]) console.log(C.dim(`          e.g. "${s.samples[0]}${s.samples[0].length >= 90 ? '…' : ''}"`));
    }
    console.log('');
    if (questionish.length > 0) {
      console.log(C.bold('  QUESTION-LAYER CANDIDATES'));
      for (const [, s] of questionish) console.log(`    ${C.cyan(s.local.padEnd(26))} ${String(s.uses).padStart(5)} use(s)`);
      console.log('');
    }
  }

  console.log(C.bold('  DOCUMENTATION IMPACT'));
  console.log(`    ${docsMentioningReview} of ${docsTotal} published page(s) describe reviewing, confirming or pending state.`);
  console.log(`    ${docsMentioningTriples} of ${docsTotal} describe triples or predicates.`);
  console.log(C.dim('    Changing what "reviewed" means puts every one of those in question. This is the'));
  console.log(C.dim('    count that makes "update the docs" a plan instead of a wish.'));
  console.log('');

  console.log(C.bold('  THE LONG TAIL'));
  const singles = all.filter(([, s]) => s.uses === 1).length;
  const oneGraph = all.filter(([, s]) => s.graphs.size === 1).length;
  console.log(`    ${singles} predicate(s) used exactly once; ${oneGraph} appear in only one graph.`);
  console.log(C.dim('    These are cheap to classify and cheap to get wrong — a single use has a blast'));
  console.log(C.dim('    radius of one. Do them last, in bulk, and spend the review on the head.'));
  console.log('');
  console.log(C.dim('  Proposes nothing. Naming a layer is judgment and belongs to the agent tier with a'));
  console.log(C.dim('  human gate; this half is arithmetic. Corpus is static/*.ttl — a USER graph will'));
  console.log(C.dim('  hold predicates that appear nowhere here, so treat these as a LOWER BOUND.'));
}

if (process.argv[1] && process.argv[1].endsWith('layer-risk.ts')) main();
