#!/usr/bin/env npx tsx
/**
 * The thesis section on the landing page, GENERATED from the graph (SCRIPT tier).
 *
 * Marketing copy hand-written next to a machine-readable source of truth always loses —
 * we already caught the landing page claiming "MCP server (16 tools)" when the graph said
 * 20. Philosophy is worse than a feature list to get wrong: a principle we have quietly
 * stopped honouring, still printed on the front page, is exactly the overclaim
 * kb:honest-status exists to prevent.
 *
 * So the tenets live in the graph (kb:thesis), and this generates the page from them.
 *
 * Each tenet carries kpred:tenet-status:
 *   built   — this is enforced by code today
 *   belief  — this is a commitment we hold, not yet a control
 *
 * The distinction is rendered, not hidden. A belief dressed as a feature is a lie with
 * good manners.
 *
 * Usage:
 *   npm run landing:principles            (writes src/lib/data/landing-thesis.json)
 *   npm run landing:principles -- --check (CI: fail if the committed file is stale)
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { Parser } from 'n3';
import { readTextOr } from './lib/read-file.js';

const CHECK = process.argv.includes('--check');
const OUT = 'src/lib/data/landing-thesis.json';

const KPRED = 'urn:kbase:predicate/';
const HNAV = 'urn:reckons:nav/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const files = readdirSync('static')
  .filter((f) => f.endsWith('.ttl'))
  .map((f) => path.join('static', f))
  .filter((f) => !/^#\s*generated/im.test(readFileSync(f, 'utf8').slice(0, 200)));

const quads = files.flatMap((f) => {
  try {
    return new Parser({ format: 'TriG' }).parse(readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
});

const obj = (s: string, p: string) =>
  quads.find((q) => q.subject.value === s && q.predicate.value === p)?.object.value;

const tenetIris = [
  ...new Set(
    quads
      .filter((q) => q.predicate.value === KPRED + 'show-on-landing' && q.object.value === 'true')
      .map((q) => q.subject.value)
      .filter((iri) => obj(iri, KPRED + 'tenet-body') !== undefined),
  ),
];

interface Tenet {
  headline: string;
  /**
   * The FIRST SENTENCE only. The landing page is not where a reader should meet a 70-word
   * argument seven times over — Matt, 2026-09-06: "landing isn't a good place for that level of
   * detail." The full body is published at /docs/principles, generated from the same triple, so
   * there is still exactly one source and the depth lives where someone came looking for it.
   */
  lead: string;
  status: 'built' | 'belief';
  order: number;
}

const problems: string[] = [];
const tenets: Tenet[] = [];

for (const iri of tenetIris) {
  const headline = obj(iri, RDFS_LABEL);
  const body = obj(iri, KPRED + 'tenet-body');
  const status = obj(iri, KPRED + 'tenet-status');
  const order = Number(obj(iri, HNAV + 'order') ?? 99);

  if (!headline || !body) {
    problems.push(`${iri}: missing rdfs:label or kpred:tenet-body`);
    continue;
  }
  if (status !== 'built' && status !== 'belief') {
    // Refusing to guess is the whole point: an unmarked tenet could be rendered as a
    // shipped control when it is only an intention.
    problems.push(`${iri}: kpred:tenet-status must be "built" or "belief" (got "${status}")`);
    continue;
  }
  // Split on the first sentence end followed by a capital, so "kb:honest-status." mid-sentence
  // does not truncate the lead.
  // First sentence — but a lead has to stand alone, and some bodies open with a fragment. The
  // evidence tenet begins "This is the spine.", which on the landing page said nothing at all, so
  // a short opener takes the following sentence with it.
  const sentences = (body.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [body]).map((x) => x.trim());
  const MIN_LEAD_WORDS = 9, MAX_LEAD_SENTENCES = 3;
  let lead = sentences[0] ?? body;
  for (let i = 1; i < sentences.length && i < MAX_LEAD_SENTENCES; i++) {
    if (lead.split(/\s+/).length >= MIN_LEAD_WORDS) break;
    lead = `${lead} ${sentences[i]}`;   // "Think privately. Be wrong privately." is still only
  }                                     // five words, so one extra sentence is not always enough.
  tenets.push({ headline, lead, status, order });
}

if (problems.length) {
  console.error('Cannot generate the thesis section:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}

tenets.sort((a, b) => a.order - b.order);
const json = JSON.stringify(tenets.map(({ order, ...t }) => t), null, 2) + '\n';

if (CHECK) {
  const current = readTextOr(OUT, '');
  if (current !== json) {
    console.error(`${OUT} is STALE — the landing page no longer matches the graph.`);
    console.error('Run: npm run landing:principles');
    process.exit(1);
  }
  console.log(`${OUT} matches the graph (${tenets.length} tenets).`);
  process.exit(0);
}

writeFileSync(OUT, json);
console.log(`${OUT} — ${tenets.length} tenets from the graph:`);
for (const t of tenets) console.log(`  [${t.status.padEnd(6)}] ${t.headline}`);
