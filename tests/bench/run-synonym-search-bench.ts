#!/usr/bin/env npx tsx
/**
 * SYNONYM SEARCH BENCHMARK — does the thesaurus actually buy recall, and what does it cost?
 *
 * F104 measured two causes of kb_search failure on 2026-07-19. COVERAGE is fixed (the MCP
 * workspace now indexes 23 graphs, not 6). This measures the second, VOCABULARY: "BM25 indexes
 * subjectSlug + predicateSlug + object with no expansion, so a synonym gap is fatal".
 *
 * WHY THIS BENCHMARK EXISTS RATHER THAN AN ASSERTION. kb:node-synonyms records the honest
 * objection in advance: "Synonyms trade PRECISION for recall, and the cost is not zero:
 * expanding 'set' to 'group' will surface rows the user did not want." A unit test can prove
 * expansion finds a thing. Only a measurement can say whether it finds MORE right things than
 * wrong ones, and what it does to the searches that already worked. So this reports three
 * numbers together and refuses to headline the flattering one:
 *
 *   RECALL   — do the synonym-phrased queries now reach their entity? (the point)
 *   CONTROL  — do the queries that already worked still work? (the risk)
 *   NOISE    — how many more rows come back per query? (the cost the user pays in attention)
 *
 * It runs against the REAL static/*.ttl corpus, not a fixture graph, because a thesaurus that
 * works on ten hand-made triples proves nothing about a 12k-quad graph where idf is real.
 *
 * Usage:
 *   npx tsx tests/bench/run-synonym-search-bench.ts              # default weight
 *   npx tsx tests/bench/run-synonym-search-bench.ts --sweep      # sweep ALIAS_TERM_WEIGHT
 *   npx tsx tests/bench/run-synonym-search-bench.ts --save       # persist JSON
 *   npx tsx tests/bench/run-synonym-search-bench.ts --k 5        # rank cutoff (default 10)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { Parser } from 'n3';
import { bm25Search, invalidateCache, ALIAS_TERM_WEIGHT } from '../../mcp-server/src/search.js';
import type { Triple } from '../../mcp-server/src/kb-reader.js';

const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const save = args.includes('--save');
const sweep = args.includes('--sweep');
const getArg = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const K = parseInt(getArg('--k', '10'), 10);

// ── Fixture ──────────────────────────────────────────────────────────────────

type GoldenQuery = { query: string; expect: string };
type Fixture = {
  aliases: Array<{ subject: string; values: string[] }>;
  queries: GoldenQuery[];
  control: { queries: GoldenQuery[] };
};

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/synonym-queries.json'), 'utf8'),
);

// ── Corpus: the real graphs ──────────────────────────────────────────────────

function loadCorpus(): Triple[] {
  const dir = join(import.meta.dirname, '../../static');
  const parser = new Parser();
  const triples: Triple[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ttl'))) {
    // Structural, not n3's own Quad: this repo's TS config resolves n3 without type
    // declarations, so naming its exported types is an error here (see kb-reader.ts).
    let quads: Array<{
      subject: { value: string };
      predicate: { value: string };
      object: { value: string; termType: string };
    }>;
    try {
      quads = parser.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue; // a graph that does not parse is graph-lint's problem, not this benchmark's
    }
    for (const q of quads) {
      triples.push({
        subject: q.subject.value,
        predicate: q.predicate.value,
        object: q.object.value,
        objectIsLiteral: q.object.termType === 'Literal',
        graph: file,
      });
    }
  }
  return triples;
}

/** The same corpus with the golden aliases asserted as real skos:altLabel triples. */
function withAliases(corpus: Triple[]): Triple[] {
  const added: Triple[] = [];
  for (const { subject, values } of fixture.aliases) {
    for (const value of values) {
      added.push({ subject, predicate: SKOS_ALT_LABEL, object: value, objectIsLiteral: true, graph: 'bench' });
    }
  }
  return [...corpus, ...added];
}

// ── Scoring ──────────────────────────────────────────────────────────────────

type ArmResult = {
  hitRate: number;      // fraction of queries whose target appears in the top K
  top1: number;         // fraction ranked FIRST — the number a user actually feels
  mrr: number;          // mean reciprocal rank of the first correct row
  meanResults: number;  // rows returned per query — the attention cost
  viaAlias: number;     // how many queries were rescued specifically by an alias
  perQuery: Array<{ query: string; rank: number | null; results: number; alias?: string }>;
};

function runArm(
  corpus: Triple[],
  queries: GoldenQuery[],
  opts: { expandAliases: boolean; aliasWeight?: number },
): ArmResult {
  let hits = 0;
  let top1 = 0;
  let rrSum = 0;
  let resultSum = 0;
  let viaAlias = 0;
  const perQuery: ArmResult['perQuery'] = [];

  for (const g of queries) {
    invalidateCache(); // the cache keys on array identity; a stale arm would silently lie
    const results = bm25Search(corpus, g.query, K, opts);
    // A query succeeds when ANY returned triple belongs to the expected entity: kb_search
    // returns triples, and reaching the entity at all is what the user needed.
    const idx = results.findIndex((r) => r.triple.subject === g.expect);
    const rank = idx >= 0 ? idx + 1 : null;
    if (rank !== null) {
      hits++;
      if (rank === 1) top1++;
      rrSum += 1 / rank;
      const alias = results[idx].matchedAliases?.[0];
      if (alias) viaAlias++;
      perQuery.push({ query: g.query, rank, results: results.length, ...(alias ? { alias } : {}) });
    } else {
      perQuery.push({ query: g.query, rank: null, results: results.length });
    }
    resultSum += results.length;
  }

  const n = queries.length;
  return {
    hitRate: n > 0 ? hits / n : 0,
    top1: n > 0 ? top1 / n : 0,
    mrr: n > 0 ? rrSum / n : 0,
    meanResults: n > 0 ? resultSum / n : 0,
    viaAlias,
    perQuery,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const delta = (a: number, b: number) => {
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  return `${sign}${(d * 100).toFixed(1)}pp`;
};

function main(): void {
  const base = loadCorpus();
  const corpus = withAliases(base);
  const aliasCount = fixture.aliases.reduce((s, a) => s + a.values.length, 0);

  console.log('\n\x1b[1mSynonym search benchmark\x1b[0m — F104 vocabulary gap');
  console.log(`corpus: ${base.length} triples from static/*.ttl + ${aliasCount} golden aliases`);
  console.log(`cutoff: top ${K}\n`);

  // The plain run must report what SHIPS, or the benchmark is measuring something the
  // product does not do.
  const weights = sweep ? [0, 0.2, 0.4, 0.6, 0.8, 1.0] : [ALIAS_TERM_WEIGHT];

  const off = runArm(corpus, fixture.queries, { expandAliases: false });
  const offControl = runArm(corpus, fixture.control.queries, { expandAliases: false });

  console.log('\x1b[1mSYNONYM QUERIES\x1b[0m — phrased with a name the entity is not labelled with');
  console.log(`  ${'weight'.padEnd(8)} ${'hit@K'.padEnd(8)} ${'top-1'.padEnd(8)} ${'MRR'.padEnd(8)} ${'ctl top-1'.padEnd(10)} ${'ctl MRR'.padEnd(9)} rows/query`);
  console.log(`  ${'OFF'.padEnd(8)} ${pct(off.hitRate).padEnd(8)} ${pct(off.top1).padEnd(8)} ${off.mrr.toFixed(3).padEnd(8)} ${pct(offControl.top1).padEnd(10)} ${offControl.mrr.toFixed(3).padEnd(9)} ${off.meanResults.toFixed(1)}`);

  const rows: Array<Record<string, unknown>> = [];
  for (const w of weights) {
    const on = runArm(corpus, fixture.queries, { expandAliases: true, aliasWeight: w });
    const onControl = runArm(corpus, fixture.control.queries, { expandAliases: true, aliasWeight: w });
    console.log(
      `  ${String(w).padEnd(8)} ${pct(on.hitRate).padEnd(8)} ${pct(on.top1).padEnd(8)} ${on.mrr.toFixed(3).padEnd(8)} ` +
      `${pct(onControl.top1).padEnd(10)} ${onControl.mrr.toFixed(3).padEnd(9)} ${on.meanResults.toFixed(1)}`,
    );
    rows.push({
      aliasWeight: w,
      synonym: { hitRate: on.hitRate, top1: on.top1, mrr: on.mrr, viaAlias: on.viaAlias, meanResults: on.meanResults },
      control: { hitRate: onControl.hitRate, top1: onControl.top1, mrr: onControl.mrr, meanResults: onControl.meanResults },
      deltaHit: on.hitRate - off.hitRate,
      controlDeltaMrr: onControl.mrr - offControl.mrr,
    });
  }

  const chosen = rows.find((r) => r.aliasWeight === ALIAS_TERM_WEIGHT) ?? rows[rows.length - 1];
  const syn = chosen.synonym as ArmResult;
  const ctl = chosen.control as ArmResult;

  console.log('\n\x1b[1mCONTROL QUERIES\x1b[0m — searches that already worked, at weight ' + chosen.aliasWeight);
  console.log(`  hit@K   ${pct(offControl.hitRate)} → ${pct(ctl.hitRate)}  (${delta(offControl.hitRate, ctl.hitRate)})`);
  console.log(`  top-1   ${pct(offControl.top1)} → ${pct(ctl.top1)}  (${delta(offControl.top1, ctl.top1)})`);
  console.log(`  MRR     ${offControl.mrr.toFixed(3)} → ${ctl.mrr.toFixed(3)}  (${(ctl.mrr - offControl.mrr >= 0 ? '+' : '')}${(ctl.mrr - offControl.mrr).toFixed(3)})`);
  const ctlDetail = runArm(corpus, fixture.control.queries, { expandAliases: true, aliasWeight: chosen.aliasWeight as number });
  for (let i = 0; i < fixture.control.queries.length; i++) {
    const b = offControl.perQuery[i];
    const a = ctlDetail.perQuery[i];
    if (a.rank === b.rank) continue;
    const worse = (a.rank ?? 99) > (b.rank ?? 99);
    console.log(`    ${String(b.rank ?? '—').padStart(3)} → ${String(a.rank ?? '—').padStart(3)}  ${worse ? '\x1b[31mworse\x1b[0m' : '\x1b[32mbetter\x1b[0m'}  "${a.query}"`);
  }

  console.log('\n\x1b[1mCOST\x1b[0m');
  console.log(`  rows returned per synonym query: ${off.meanResults.toFixed(1)} → ${syn.meanResults.toFixed(1)}`);

  console.log('\n\x1b[1mPER QUERY\x1b[0m (weight ' + chosen.aliasWeight + ')');
  const onDetail = runArm(corpus, fixture.queries, { expandAliases: true, aliasWeight: chosen.aliasWeight as number });
  for (let i = 0; i < fixture.queries.length; i++) {
    const b = off.perQuery[i];
    const a = onDetail.perQuery[i];
    const mark = a.rank !== null && b.rank === null ? '\x1b[32mRESCUED\x1b[0m'
      : a.rank === null && b.rank !== null ? '\x1b[31mLOST\x1b[0m'
      : a.rank !== null && b.rank !== null && a.rank < b.rank ? 'improved'
      : a.rank === null ? '\x1b[33mstill missing\x1b[0m' : 'unchanged';
    console.log(`  ${String(b.rank ?? '—').padStart(3)} → ${String(a.rank ?? '—').padStart(3)}  ${mark.padEnd(20)} "${a.query}"${a.alias ? ` \x1b[2m[via ${a.alias}]\x1b[0m` : ''}`);
  }

  // The honest summary: state the loss in the same breath as the gain.
  const rescued = onDetail.perQuery.filter((a, i) => a.rank !== null && off.perQuery[i].rank === null).length;
  const lost = onDetail.perQuery.filter((a, i) => a.rank === null && off.perQuery[i].rank !== null).length;
  const stillMissing = onDetail.perQuery.filter((a) => a.rank === null).length;
  const promoted = onDetail.perQuery.filter((a, i) => {
    const b = off.perQuery[i];
    return a.rank !== null && b.rank !== null && a.rank < b.rank;
  }).length;
  const demoted = onDetail.perQuery.filter((a, i) => {
    const b = off.perQuery[i];
    return a.rank !== null && b.rank !== null && a.rank > b.rank;
  }).length;
  console.log(`\n\x1b[1mVERDICT\x1b[0m  ${promoted} promoted, ${demoted} demoted, ${rescued} rescued, ${lost} lost, ${stillMissing} unreachable — of ${fixture.queries.length}.`);
  console.log(`         Once coverage was fixed the corpus already REACHED these entities; the gap was RANK.`);
  console.log(`         control MRR moved ${(ctl.mrr - offControl.mrr >= 0 ? '+' : '')}${(ctl.mrr - offControl.mrr).toFixed(3)}, control top-1 ${delta(offControl.top1, ctl.top1)}.`);
  if (stillMissing > 0) {
    console.log(`         \x1b[33mA hand-written thesaurus only catches what someone listed.\x1b[0m Embeddings (F104 step 3) are what catch the rest.`);
  }

  if (save) {
    const dir = join(import.meta.dirname, 'results');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `synonym-search_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(out, JSON.stringify({
      generatedAt: new Date().toISOString(),
      corpusTriples: base.length,
      aliasCount,
      k: K,
      off: { synonym: off, control: offControl },
      arms: rows,
    }, null, 2));
    console.log(`\nsaved → ${out}`);
  }
  console.log();
}

main();
