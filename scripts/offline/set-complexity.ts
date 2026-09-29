#!/usr/bin/env npx tsx
/**
 * SET COMPLEXITY — what do sets actually COST? Script tier, zero tokens.
 *
 * WHY THIS EXISTS. Matt, 2026-09-11: "We must take a serious analysis of if sets are worth the
 * complexity. Anything above and beyond standard triples is worth deep complexity analysis.
 * Search and compute should not suffer greatly for any core standardized methodology."
 *
 * That is the right demand and it had no answer, so this measures rather than argues. The verdict
 * belongs to Matt; this script's job is to make it a decision about numbers.
 *
 * THE FRAMING THAT MATTERS, and it is not "sets vs triples". A set IS triples — skos:member is an
 * ordinary predicate and a Collection is an ordinary node. Nothing here leaves the substrate
 * (kb:set-substrate, .measured: "AN UNORDERED SET NEEDS NO SUBSTRATE CHANGE AT ALL"). So the
 * question is narrower and sharper: what do the EXTRA triples cost, per capability bought?
 *
 * FOUR COSTS, measured separately because they have wildly different sizes:
 *
 *   1. STORAGE      quads of set machinery, against the cheapest thing that groups: one predicate.
 *   2. SEARCH       BM25 indexes ONE DOCUMENT PER STATEMENT. Every membership row is a document,
 *                   so grouping dilutes the index. This is the cost Matt's question is really
 *                   about, and it is the one nobody had looked at.
 *   3. COMPUTE      readSets is a full pass building nine maps. Measured against the corpus, and
 *                   against the plain-predicate scan it replaces.
 *   4. CONCEPTUAL   how many distinct terms a reader must know to understand a set.
 *
 * AND THE TIERS ARE REPORTED APART, because they are not one feature and should not be bought or
 * refused as one:
 *
 *   PLAIN SET   type + label + N members         — N+2 quads
 *   ORDERED     adds a skolemised node per member — N+2 + 3N quads, a 4x multiplier
 *   BLOCKS      page composition over sets        — F187.5, separate again
 *
 * Usage: npx tsx scripts/offline/set-complexity.ts [--quiet] [--json]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  readSets, readNotations, COLLECTION, ORDERED_COLLECTION, MEMBER, PREF_LABEL, DEFINITION,
  SET_KIND, MEMBER_ORDER, IN_SET, HAS_MEMBER_ENTITY, SET_RELATES_TO, HAS_MEMBER, ENTITY_SET_TYPE,
  HAS_BLOCK, BLOCK_SET, BLOCK_COMPONENT, BLOCK_ORDER, BLOCK_CONTENT, BLOCK_HEADING,
} from '../../src/lib/rdf/sets.js';
import { BM25Index, type BM25Doc } from '../../src/lib/rdf/bm25.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const QUIET = process.argv.includes('--quiet');
const JSON_OUT = process.argv.includes('--json');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** Predicates that exist only because sets exist. Order machinery is flagged apart from the rest. */
const PLAIN_SET_PREDICATES = new Set([MEMBER, HAS_MEMBER, SET_KIND, SET_RELATES_TO]);
const ORDER_PREDICATES = new Set([MEMBER_ORDER, IN_SET, HAS_MEMBER_ENTITY]);
const BLOCK_PREDICATES = new Set([HAS_BLOCK, BLOCK_SET, BLOCK_COMPONENT, BLOCK_ORDER, BLOCK_CONTENT, BLOCK_HEADING]);

type Tally = { plain: number; order: number; blocks: number; total: number };

function loadCorpus(): { quads: Quad[]; files: number } {
  const files = readdirSync(STATIC_DIR).filter((f) => f.endsWith('.ttl') && f !== 'docs-all.ttl');
  const quads: Quad[] = [];
  let parsed = 0;
  for (const f of files) {
    try {
      quads.push(...new Parser().parse(readFileSync(join(STATIC_DIR, f), 'utf8')));
      parsed++;
    } catch { /* a graph that does not parse is graph-lint's finding, not this script's */ }
  }
  return { quads, files: parsed };
}

/** Which quads exist only to express grouping. */
function tallyMachinery(quads: Quad[], setIris: Set<string>): Tally {
  const t: Tally = { plain: 0, order: 0, blocks: 0, total: quads.length };
  for (const q of quads) {
    const p = q.predicate.value;
    if (ORDER_PREDICATES.has(p)) { t.order++; continue; }
    if (BLOCK_PREDICATES.has(p)) { t.blocks++; continue; }
    if (PLAIN_SET_PREDICATES.has(p)) { t.plain++; continue; }
    // A type declaration, label or definition counts as machinery only on a set — the same
    // predicates on an ordinary entity are not a cost of sets.
    if (p === RDF_TYPE && (q.object.value === COLLECTION || q.object.value === ORDERED_COLLECTION || q.object.value === ENTITY_SET_TYPE)) { t.plain++; continue; }
    if ((p === PREF_LABEL || p === DEFINITION) && setIris.has(q.subject.value)) t.plain++;
  }
  return t;
}

/**
 * Search dilution — the cost Matt's question is really about.
 *
 * BM25 makes ONE DOCUMENT PER STATEMENT (src/lib/rdf/bm25.ts, docText), so a set of N members puts
 * N more documents into the index whose entire text is "<set label> member <member label>". Two
 * things can go wrong and they are different:
 *
 *   DILUTION   the index grows, so every idf shifts slightly. Small and unavoidable.
 *   CROWDING   a query for a member's name now matches its membership rows, which say nothing
 *              about the member. If those rows displace real facts out of the top 10, search has
 *              genuinely got worse — and THAT is the number worth having.
 *
 * Measured by running the same queries against the index with and without set machinery.
 */
function measureSearch(quads: Quad[], setIris: Set<string>, memberNames: string[]): {
  docsWith: number; docsWithout: number; queries: Array<{ q: string; displaced: number; machineryInTop10: number }>;
} {
  const label = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value === RDFS_LABEL || q.predicate.value === PREF_LABEL) {
      if (!label.has(q.subject.value)) label.set(q.subject.value, q.object.value);
    }
  }
  const short = (iri: string) => label.get(iri) ?? iri.split(/[/#]/).filter(Boolean).pop() ?? iri;

  const isMachinery = (q: Quad): boolean => {
    const p = q.predicate.value;
    if (PLAIN_SET_PREDICATES.has(p) || ORDER_PREDICATES.has(p) || BLOCK_PREDICATES.has(p)) return true;
    if (p === RDF_TYPE && (q.object.value === COLLECTION || q.object.value === ORDERED_COLLECTION || q.object.value === ENTITY_SET_TYPE)) return true;
    return (p === PREF_LABEL || p === DEFINITION) && setIris.has(q.subject.value);
  };

  const toDoc = (q: Quad, i: number): BM25Doc => ({
    id: String(i),
    subject: short(q.subject.value),
    predicate: short(q.predicate.value),
    object: q.object.termType === 'Literal' ? q.object.value : short(q.object.value),
  });

  const withDocs = quads.map(toDoc);
  const machineryIds = new Set<string>();
  quads.forEach((q, i) => { if (isMachinery(q)) machineryIds.add(String(i)); });
  const withoutDocs = withDocs.filter((d) => !machineryIds.has(d.id));

  const withIdx = new BM25Index(withDocs);
  const withoutIdx = new BM25Index(withoutDocs);

  const queries = memberNames.map((q) => {
    const a = withIdx.search(q, 10).map((r) => r.id);
    const b = withoutIdx.search(q, 10).map((r) => r.id);
    const machineryInTop10 = a.filter((id) => machineryIds.has(id)).length;
    // Real results that were in the top 10 before sets and are not after.
    const aSet = new Set(a);
    const displaced = b.filter((id) => !aSet.has(id)).length;
    return { q, displaced, machineryInTop10 };
  });
  return { docsWith: withDocs.length, docsWithout: withoutDocs.length, queries };
}

function main(): void {
  const { quads, files } = loadCorpus();
  const notations = readNotations(quads);
  const sets = readSets(quads, notations);
  const setIris = new Set(sets.map((s) => s.iri));

  const tally = tallyMachinery(quads, setIris);
  const machinery = tally.plain + tally.order + tally.blocks;

  const ordered = sets.filter((s) => s.ordered);
  const memberTotal = sets.reduce((n, s) => n + s.members.length, 0);
  const withOrdinals = sets.reduce((n, s) => n + s.members.filter((m) => m.order !== undefined).length, 0);

  /*
   * THE BASELINE. The cheapest thing that groups is ONE PREDICATE: `shortlist has-member X`, N
   * quads and no type, no label, no kind. Everything above that is what sets charge, and the
   * charge is what buys a set a NAME, a DEFINITION, a KIND and recognizability to a reader.
   */
  const baselineQuads = memberTotal;
  const overhead = machinery - baselineQuads;

  // COMPUTE — readSets against the plain scan it replaces, both over the same corpus.
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) readSets(quads, notations);
  const readSetsMs = (performance.now() - t0) / 5;

  const t1 = performance.now();
  for (let i = 0; i < 5; i++) {
    const groups = new Map<string, string[]>();
    for (const q of quads) if (q.predicate.value === MEMBER || q.predicate.value === HAS_MEMBER) {
      groups.set(q.subject.value, [...(groups.get(q.subject.value) ?? []), q.object.value]);
    }
  }
  const plainScanMs = (performance.now() - t1) / 5;

  // SEARCH — query the names of real members, which is what a user actually types.
  const sampleMembers = sets.flatMap((s) => s.members.map((m) => m.iri)).slice(0, 200);
  const names = [...new Set(sampleMembers.map((i) => i.split(/[/#]/).filter(Boolean).pop() ?? i))].slice(0, 25);
  const search = measureSearch(quads, setIris, names);
  const crowded = search.queries.filter((q) => q.machineryInTop10 > 0);
  const worsened = search.queries.filter((q) => q.displaced > 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      corpus: { files, quads: quads.length }, sets: sets.length, ordered: ordered.length,
      members: memberTotal, machinery: tally, overhead, readSetsMs, plainScanMs, search: {
        ...search, crowdedQueries: crowded.length, worsenedQueries: worsened.length,
      },
    }, null, 2));
    return;
  }

  const pct = (n: number, d: number) => d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(2)}%`;

  console.log(C.bold('\n══ set complexity ══'));
  console.log(`  corpus            ${quads.length.toLocaleString()} quads across ${files} graphs`);
  console.log(`  sets              ${sets.length} (${ordered.length} ordered), ${memberTotal} memberships\n`);

  console.log(C.bold('  STORAGE'));
  console.log(`    plain set machinery   ${String(tally.plain).padStart(6)}  ${pct(tally.plain, tally.total)} of corpus`);
  console.log(`    order machinery       ${String(tally.order).padStart(6)}  ${pct(tally.order, tally.total)}  ${C.dim(`${withOrdinals} ordinals`)}`);
  console.log(`    page blocks (F187.5)  ${String(tally.blocks).padStart(6)}  ${pct(tally.blocks, tally.total)}`);
  console.log(`    ${C.bold('total')}                 ${String(machinery).padStart(6)}  ${pct(machinery, tally.total)}`);
  console.log(`    ${C.dim(`vs one-predicate baseline (${baselineQuads} quads): +${overhead} quads of overhead`)}`);
  if (withOrdinals > 0) {
    console.log(`    ${C.dim(`order costs ${(tally.order / withOrdinals).toFixed(1)} quads per ordered member`)}`);
  }

  console.log(C.bold('\n  SEARCH') + C.dim('   BM25 makes one document per statement'));
  console.log(`    index            ${search.docsWith.toLocaleString()} docs with sets, ${search.docsWithout.toLocaleString()} without  (+${pct(search.docsWith - search.docsWithout, search.docsWithout)})`);
  console.log(`    queries tested   ${search.queries.length} (real member names)`);
  const crowdColor = crowded.length === 0 ? C.green : C.yellow;
  console.log(`    machinery in top-10   ${crowdColor(String(crowded.length))} of ${search.queries.length} queries`);
  const worseColor = worsened.length === 0 ? C.green : C.red;
  console.log(`    real results displaced ${worseColor(String(worsened.length))} of ${search.queries.length} queries`);
  for (const q of worsened.slice(0, 5)) {
    console.log(C.dim(`      "${q.q}" — ${q.displaced} real result(s) pushed out, ${q.machineryInTop10} membership row(s) in`));
  }

  console.log(C.bold('\n  COMPUTE'));
  console.log(`    readSets over corpus  ${readSetsMs.toFixed(1)}ms`);
  console.log(`    plain predicate scan  ${plainScanMs.toFixed(1)}ms`);
  console.log(`    ${C.dim(`ratio ${(readSetsMs / Math.max(plainScanMs, 0.001)).toFixed(1)}x — both O(n) over quads, one pass each`)}`);

  console.log(C.bold('\n  CONCEPTUAL'));
  const plainTerms = [COLLECTION, MEMBER, PREF_LABEL, DEFINITION, SET_KIND, SET_RELATES_TO];
  const orderTerms = [ORDERED_COLLECTION, MEMBER_ORDER, IN_SET, HAS_MEMBER_ENTITY];
  const blockTerms = [HAS_BLOCK, BLOCK_SET, BLOCK_COMPONENT, BLOCK_ORDER, BLOCK_CONTENT, BLOCK_HEADING];
  console.log(`    terms to understand a plain set   ${plainTerms.length}  ${C.dim('(4 are standard SKOS)')}`);
  console.log(`    + ordered sets                    ${orderTerms.length}  ${C.dim('(1 standard, 3 local — the skolemised membership node)')}`);
  console.log(`    + page blocks                     ${blockTerms.length}  ${C.dim('(0 standard — all local)')}`);
  console.log('');

  if (!QUIET) {
    console.log(C.bold('  READ THIS BEFORE QUOTING A NUMBER'));
    console.log(C.dim('    Storage is not the interesting cost and never was — a set is triples, and'));
    console.log(C.dim('    triples are what this system stores. The two costs that could actually hurt are'));
    console.log(C.dim('    SEARCH CROWDING (above) and the ORDER MULTIPLIER, which is 4 quads per member'));
    console.log(C.dim('    for a capability most sets do not use. Buy them separately.'));
    console.log('');
  }
}

main();
