#!/usr/bin/env npx tsx
/**
 * Test-coverage audit for shipped features (SCRIPT tier).
 *
 * NOTE THE CORRECTED FRAMING. An earlier version of this script treated an untested
 * `production` feature as a FALSE CLAIM. That was a category error: kpred:has-status
 * describes MATURITY AND DEPLOYMENT ("is this shipped and in use?"), while test
 * coverage is an orthogonal fact. A feature can be genuinely in production AND
 * untested — that is a RISK, not a lie, and "fixing" it by downgrading the status
 * would itself be dishonest, because the feature really is shipped.
 *
 * So the rule this enforces is not "prove your status". It is:
 *
 *     A shipped feature must either LINK a test (kpred:tested-by), or EXPLICITLY
 *     DECLARE that it has none (kpred:test-coverage "none").
 *
 * You may ship untested code. You may not do it SILENTLY. The gap becomes a visible,
 * queryable risk register in the graph instead of an absence nobody notices
 * (kb:honest-status). Undeclared gaps are errors; declared ones are warnings.
 *
 * A link to a test that does not actually exercise the feature is manufactured
 * evidence — strictly worse than an honest gap. The script cannot check that; the
 * reviewer must.
 *
 * Usage:
 *   npm run offline:evidence              report; exit 1 only on UNDECLARED gaps
 *   npm run offline:evidence -- --suggest search the repo for a likely test file
 *   npm run offline:evidence -- --json    machine-readable
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import path from 'path';
import { Parser } from 'n3';

const argv = process.argv.slice(2);
const SUGGEST = argv.includes('--suggest');
const JSON_OUT = argv.includes('--json');

const KB = 'urn:kbase:concept/';
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const FEATURE = 'urn:kbase:type/Feature';

/** Statuses that ASSERT the thing works. These are the claims that need evidence. */
const CLAIMS_TO_WORK = new Set(['production', 'functional']);

const short = (iri: string) => (iri.startsWith(KB) ? `kb:${iri.slice(KB.length)}` : iri.split('/').pop()!);

// ── Corpus (skip generated snapshots — fix the source, not the export).
const files = readdirSync('static')
  .filter((f) => f.endsWith('.ttl') || f.endsWith('.trig'))
  .map((f) => path.join('static', f))
  .filter((f) => !/^#\s*generated/im.test(readFileSync(f, 'utf8').slice(0, 200)));

const quads = files.flatMap((f) => {
  try { return new Parser({ format: 'TriG' }).parse(readFileSync(f, 'utf8')); } catch { return []; }
});

const objects = (s: string, p: string) =>
  quads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value);

const features = [...new Set(
  quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === FEATURE).map((q) => q.subject.value),
)];

// ── Every test file in the repo, for --suggest.
//
// mcp-server/ MUST be included: it has its own suite (mcp-server/src/__tests__), and
// omitting it made the MCP features look unbacked when they are in fact tested. An
// audit whose blind spot manufactures false findings is worse than no audit.
const TEST_ROOTS = ['src', 'tests', 'mcp-server/src'];
const testFiles: string[] = [];
for (const root of TEST_ROOTS) {
  (function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === 'node_modules' || e === 'dist' || e === '.svelte-kit') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(test|spec)\.ts$/.test(p)) testFiles.push(p);
    }
  })(root);
}

/** Token-overlap guess: does a test filename look like it covers this feature? */
function suggestTests(label: string, iri: string): string[] {
  const words = new Set(
    `${label} ${short(iri).replace(/^kb:/, '')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !['with', 'from', 'system', 'management', 'engine'].includes(w)),
  );
  if (!words.size) return [];
  return testFiles
    .map((f) => {
      const base = path.basename(f).toLowerCase();
      const hits = [...words].filter((w) => base.includes(w)).length;
      return { f, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.f);
}

interface Row {
  iri: string; label: string; status: string;
  linked: string[];   // tested-by targets that exist
  dead: string[];     // tested-by targets that are gone
  declared: boolean;  // kpred:test-coverage "none" — an explicit, visible admission
  suggestions: string[];
}

const undeclared: Row[] = [];  // untested AND not admitted — the only real error
const declared: Row[] = [];    // untested but admitted — the risk register
const backed: Row[] = [];

for (const iri of features) {
  const status = objects(iri, KPRED + 'has-status')[0];
  if (!status || !CLAIMS_TO_WORK.has(status)) continue;

  const label = objects(iri, RDFS_LABEL)[0] ?? short(iri);
  const tested = objects(iri, KPRED + 'tested-by');
  const linked = tested.filter((t) => existsSync(t));
  const dead = tested.filter((t) => !existsSync(t));

  const declaredNone = objects(iri, KPRED + 'test-coverage').includes('none');
  const row: Row = { iri, label, status, linked, dead, declared: declaredNone, suggestions: [] };

  if (linked.length > 0) backed.push(row);
  else if (declaredNone) declared.push(row);
  else {
    if (SUGGEST) row.suggestions = suggestTests(label, iri);
    undeclared.push(row);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ backed: backed.length, declared, undeclared }, null, 2));
  process.exit(undeclared.length ? 1 : 0);
}

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
const total = backed.length + declared.length + undeclared.length;

console.log(`${B}Test coverage of shipped features${X} — ${total} at production/functional\n`);

if (undeclared.length) {
  console.log(`${R}${B}UNDECLARED GAPS${X} ${D}(shipped, untested, and not admitting it)${X}\n`);
  for (const r of undeclared) {
    console.log(`  ${R}✗${X} ${r.status.padEnd(11)} ${B}${r.label}${X} ${D}${short(r.iri)}${X}`);
    if (r.dead.length) console.log(`       ${Y}tested-by points at a file that is GONE: ${r.dead.join(', ')}${X}`);
    for (const s of r.suggestions) console.log(`       ${D}candidate: ${s}${X}`);
  }
  console.log('');
}

if (declared.length) {
  console.log(`${Y}${B}DECLARED RISK${X} ${D}(shipped and untested — admitted in the graph)${X}\n`);
  for (const r of declared) {
    console.log(`  ${Y}!${X} ${r.status.padEnd(11)} ${r.label} ${D}${short(r.iri)}${X}`);
  }
  console.log('');
}

console.log(
  `${G}${backed.length} tested${X} · ${Y}${declared.length} declared-untested${X} · ` +
    `${undeclared.length ? R : G}${undeclared.length} undeclared${X}`,
);
if (undeclared.length) {
  console.log(
    `\n${D}You may ship untested code. You may not do it SILENTLY.\n` +
      `Link a test, or declare kpred:test-coverage "none". (kb:honest-status)${X}`,
  );
}
process.exit(undeclared.length ? 1 : 0);
