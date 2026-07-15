#!/usr/bin/env npx tsx
/**
 * Split a subgraph out of a graph (the complement of kb_merge).
 *
 * The roadmap grew to ~1888 nodes, and a graph you cannot hold in your head is a graph you
 * stop trusting. The fix is the product's own operation, run on itself: SPLIT the shipped work
 * out into its own graph, so the roadmap holds what is still PLANNED and a separate graph holds
 * what is DONE. Both remain queryable; neither is lost.
 *
 * Select by a rule — `--select has-status=production` — and the tool moves those entities AND
 * THEIR PARTS (phases, sub-features via kpred:part-of / kpred:has-phase), because a feature
 * without its phases is not a feature.
 *
 * THE CAREFUL PART IS REFERENCES, and it is why this is not a grep-and-delete. If an
 * in-progress feature depends-on a production one, moving the production feature away would
 * leave a dangling reference — a link to something the file no longer defines. graph-lint would
 * (correctly) go red. So:
 *
 *   - an entity that NOTHING in the remaining graph references moves CLEANLY (gone from source).
 *   - an entity that IS still referenced leaves a TOMBSTONE: its type, its label, and
 *     kpred:moved-to <target>. Three triples instead of twenty — the reference stays valid, the
 *     reader learns where the full definition went, and the node count still drops hard.
 *
 * Nothing is destroyed. The moved triples go to the target; a backup of the source is written.
 *
 * Usage:
 *   npx tsx scripts/agent/split.ts --from static/reckons-roadmap.ttl --to static/reckons-shipped.ttl --select has-status=production
 *   …                                                                                            --apply
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { Parser, Writer, DataFactory, type Quad } from 'n3';

const { namedNode, literal, quad } = DataFactory;
const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const PART_PREDS = [`${KPRED}part-of`, `${KPRED}has-phase`];

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FROM = flag('from');
const TO = flag('to');
const SELECT = flag('select');
const APPLY = argv.includes('--apply');

if (!FROM || !TO || !SELECT || !SELECT.includes('=')) {
  console.error(`${R}Usage: --from <src.ttl> --to <dst.ttl> --select <pred>=<value> [--apply]${X}`);
  console.error(`${D}e.g. --select has-status=production   moves every entity marked production.${X}`);
  process.exit(2);
}
if (!existsSync(FROM)) {
  console.error(`${R}No such source: ${FROM}${X}`);
  process.exit(2);
}

const [selPred, selVal] = SELECT.split('=');
const selPredIri = selPred.startsWith('urn:') ? selPred : `${KPRED}${selPred}`;

const quads = new Parser().parse(readFileSync(FROM, 'utf8')) as Quad[];

// ── Selection + expansion to parts ──────────────────────────────────────────
const selected = new Set(
  quads.filter((q) => q.predicate.value === selPredIri && q.object.value === selVal).map((q) => q.subject.value),
);

// Pull in the parts of a selected entity (recursively): a phase whose kpred:part-of points at a
// moved feature moves with it. A feature without its phases is half a feature.
let grew = true;
while (grew) {
  grew = false;
  for (const q of quads) {
    if (!PART_PREDS.includes(q.predicate.value)) continue;
    // child --part-of--> parent  OR  parent --has-phase--> child
    const child = q.predicate.value === `${KPRED}part-of` ? q.subject.value : q.object.value;
    const parent = q.predicate.value === `${KPRED}part-of` ? q.object.value : q.subject.value;
    if (selected.has(parent) && !selected.has(child)) {
      // only pull a child in if it is itself a defined entity in this file
      if (quads.some((x) => x.subject.value === child)) {
        selected.add(child);
        grew = true;
      }
    }
  }
}

if (selected.size === 0) {
  console.log(`${Y}Nothing matches ${SELECT}. Nothing to split.${X}`);
  process.exit(0);
}

// ── What moves, what stays, what would dangle ───────────────────────────────
const moveTriples = quads.filter((q) => selected.has(q.subject.value));
const stayTriples = quads.filter((q) => !selected.has(q.subject.value));

// Inbound references: a staying triple that points AT a moved entity. Its subject needs the
// moved entity to still resolve, so that moved entity must leave a tombstone.
const referencedFromOutside = new Set<string>();
for (const q of stayTriples) {
  if (selected.has(q.object.value)) referencedFromOutside.add(q.object.value);
}

const cleanMoves = [...selected].filter((s) => !referencedFromOutside.has(s));
const tombstoned = [...selected].filter((s) => referencedFromOutside.has(s));

// ── Report ──────────────────────────────────────────────────────────────────
const labelOf = (iri: string) =>
  quads.find((q) => q.subject.value === iri && q.predicate.value === RDFS_LABEL)?.object.value ?? iri.split('/').pop();

console.log(`${B}Split${X} ${D}— ${FROM} → ${TO}, where ${SELECT}${X}\n`);
console.log(`  ${selected.size} entit(ies) selected (with parts), ${moveTriples.length} triple(s) move.`);
console.log(`  ${G}${cleanMoves.length} move cleanly${X} (nothing left references them).`);
if (tombstoned.length) {
  console.log(`  ${C}${tombstoned.length} leave a tombstone${X} (still referenced — a 3-triple stub keeps links valid):`);
  for (const s of tombstoned.slice(0, 10)) console.log(`     ${D}·${X} ${labelOf(s)}`);
  if (tombstoned.length > 10) console.log(`     ${D}… and ${tombstoned.length - 10} more${X}`);
}
console.log('');

if (!APPLY) {
  console.log(`${D}Dry run. Pass --apply to move them (backups written first).${X}`);
  console.log(`${D}Source ${stayTriples.length + tombstoned.length * 3} triples after; target gains ${moveTriples.length}.${X}`);
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
//
// THE SOURCE IS EDITED TEXTUALLY, NOT RE-SERIALIZED. The roadmap is hand-authored — section
// headers, design notes, the reasoning behind decisions — and running it through an RDF writer
// would obliterate every comment while "just moving some triples". That is the exact
// never-machine-edit-an-authored-file mistake this project keeps relearning. So the source is
// edited as TEXT: the moved entities' blocks are cut out, everything else passes through byte
// for byte. The TARGET is a new generated graph, so it is fine to serialize.

/** Map each moved IRI to its prefixed form (kb:foo), using the file's @prefix declarations. */
const prefixes: [string, string][] = [];
for (const m of readFileSync(FROM, 'utf8').matchAll(/@prefix\s+(\w+):\s+<([^>]+)>/g)) prefixes.push([m[1], m[2]]);
prefixes.sort((a, b) => b[1].length - a[1].length); // longest namespace first
function prefixed(iri: string): string | null {
  for (const [pfx, ns] of prefixes) if (iri.startsWith(ns)) return `${pfx}:${iri.slice(ns.length)}`;
  return null;
}

/** Remove each subject's statement block from the text, preserving all else (comments included). */
function cutBlocks(text: string, subjects: Set<string>): string {
  const starts = new Set<string>();
  for (const s of subjects) {
    const p = prefixed(s);
    if (p) starts.add(p);
    starts.add(`<${s}>`);
  }
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping) {
      // A block starts when a line begins (col 0) with a moved subject term.
      const head = line.split(/\s/)[0];
      if (starts.has(head)) {
        skipping = true;
        // fall through to the end-of-statement check below for one-line blocks
      } else {
        out.push(line);
        continue;
      }
    }
    // While skipping: a statement ends on a line whose content ends with " ." (the terminator).
    if (skipping && /(^|\s)\.\s*$/.test(line)) {
      skipping = false;
    }
  }
  // Collapse the 3+ blank lines a removal can leave behind into a single separator.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

copyFileSync(FROM, FROM + '.bak');
if (existsSync(TO)) copyFileSync(TO, TO + '.bak');

// Source: cut the moved blocks textually, then append tombstones for still-referenced ones.
let sourceText = cutBlocks(readFileSync(FROM, 'utf8'), selected);
if (tombstoned.length) {
  const stubs = tombstoned
    .map((s) => {
      const type = quads.find((q) => q.subject.value === s && q.predicate.value === RDF_TYPE)?.object.value;
      const label = quads.find((q) => q.subject.value === s && q.predicate.value === RDFS_LABEL)?.object.value ?? '';
      const p = prefixed(s) ?? `<${s}>`;
      const typeP = type ? (prefixed(type) ?? `<${type}>`) : 'rdfs:Resource';
      return `${p} rdf:type ${typeP} ;\n    rdfs:label ${JSON.stringify(label)} ;\n    kpred:moved-to ${JSON.stringify(TO)} .`;
    })
    .join('\n\n');
  sourceText = sourceText.trimEnd() +
    `\n\n# ── Tombstones — shipped, moved to ${TO}, stub kept so references still resolve ──\n\n` +
    stubs + '\n';
}
writeFileSync(FROM, sourceText);

// Target: existing content + the moved triples (a generated graph — serialization is fine).
const existingTarget = existsSync(TO) ? (new Parser().parse(readFileSync(TO + '.bak', 'utf8')) as Quad[]) : [];
const targetQuads = [...existingTarget, ...moveTriples];
const w = new Writer({ format: 'Turtle', prefixes: { kb: 'urn:kbase:concept/', kpred: KPRED, ktype: 'urn:kbase:type/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', hnav: 'urn:reckons:nav/' } });
w.addQuads(targetQuads);
w.end((err, result: string) => {
  if (err) throw err;
  // NB: do NOT start a header line with "# generated" — graph-lint SKIPS files it thinks are
  // generated (they are checked at their source). This is a real content graph, a peer of the
  // roadmap, and MUST be linted: its entities are referenced by roadmap INVARIANTS (the
  // egress-gate safety check needs the moved gate's status to stay resolvable). A "# generated"
  // header here made graph-lint skip it and a safety check went red. Learned the hard way.
  writeFileSync(TO, `# Shipped work, split out of the roadmap (scripts/agent/split.ts) so the plan stays legible.\n# A real content graph, linted like any other — NOT a docs artifact.\n\n` + result);
});

console.log(`${G}Moved ${moveTriples.length} triple(s), preserving the source's comments.${X}`);
console.log(`  ${FROM}: authored text kept; ${selected.size} block(s) cut, ${tombstoned.length} tombstone(s) appended.`);
console.log(`  ${TO}: ${targetQuads.length} triples.`);
console.log(`  ${D}Backups: ${FROM}.bak, ${TO}.bak${X}`);
console.log(`  ${Y}Run: npx tsx scripts/offline/graph-lint.ts && npm run align — then remove the .bak files.${X}`);
