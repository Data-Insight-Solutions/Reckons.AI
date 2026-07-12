#!/usr/bin/env npx tsx
/**
 * Landing-page feature list, generated FROM THE GRAPH (SCRIPT tier).
 *
 * The landing page used to hard-code its roadmap list, and it had already drifted: it
 * advertised "MCP server (16 tools)" while the graph said 20. A hand-maintained list
 * next to a machine-readable source of truth will always lose — and on the landing
 * page, drift is not a stale docstring, it is a public claim that is not true
 * (kb:honest-status).
 *
 * So the graph decides what the site says. Mark an entity with:
 *
 *   kpred:show-on-landing "true" ;
 *   kpred:landing-label   "MCP server" ;
 *   kpred:landing-note    "Search, query, compress, align…" ;
 *
 * and its LIVE kpred:has-status drives the badge. Ship a feature, change its status in
 * the graph, and the landing page follows. It cannot claim something is done when the
 * graph says planned.
 *
 * Usage:  npm run landing:features        (writes src/lib/data/landing-roadmap.json)
 *         npm run landing:features -- --check   (CI: fail if the committed file is stale)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { Parser } from 'n3';

const CHECK = process.argv.includes('--check');
const OUT = 'src/lib/data/landing-roadmap.json';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** Lifecycle → the badge the landing page shows. Honest by construction. */
const BADGE: Record<string, string> = {
  production: 'done',
  functional: 'done',
  scaffolded: 'building',
  'in-progress': 'building',
  planned: 'planned',
  speculative: 'exploring',
};

/** Display order: what's shipped first, what's dreamt of last. */
const RANK: Record<string, number> = { done: 0, building: 1, planned: 2, exploring: 3 };

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

const marked = [
  ...new Set(
    quads
      .filter((q) => q.predicate.value === KPRED + 'show-on-landing' && q.object.value === 'true')
      .map((q) => q.subject.value),
  ),
];

interface Row { status: string; label: string; note: string; }
const rows: Row[] = [];
const problems: string[] = [];

for (const iri of marked) {
  const label = obj(iri, KPRED + 'landing-label') ?? obj(iri, RDFS_LABEL);
  const note = obj(iri, KPRED + 'landing-note');
  const lifecycle = obj(iri, KPRED + 'has-status');

  if (!label || !note) { problems.push(`${iri}: missing landing-label or landing-note`); continue; }
  if (!lifecycle || !BADGE[lifecycle]) {
    problems.push(`${iri}: has-status "${lifecycle}" — cannot derive an honest badge`);
    continue;
  }
  rows.push({ status: BADGE[lifecycle], label, note });
}

rows.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.label.localeCompare(b.label));

if (problems.length) {
  console.error('Cannot generate the landing list:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}

const json = JSON.stringify(rows, null, 2) + '\n';

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error(`${OUT} is STALE — the landing page no longer matches the graph.`);
    console.error('Run: npm run landing:features');
    process.exit(1);
  }
  console.log(`${OUT} matches the graph (${rows.length} features).`);
  process.exit(0);
}

writeFileSync(OUT, json);
console.log(`${OUT} — ${rows.length} features from the graph:`);
for (const r of rows) console.log(`  [${r.status.padEnd(9)}] ${r.label}`);
