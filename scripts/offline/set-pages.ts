#!/usr/bin/env npx tsx
/**
 * SET-DEFINED PAGES (F187.5) — what would the docs look like if a SET were a page?
 *
 * SCRIPT TIER: deterministic, zero tokens, no model, and it writes nothing.
 *
 * Matt, 2026-09-08: "Not every graph entity needs to land on a page. I believe sets should define
 * the pages, and the pages can be linked especially when they share an entity. Lets use sets and
 * order within sets, to accomplish page organization."
 *
 * WHY DERIVE RATHER THAN AUTHOR. No docs graph contains a skos:Collection yet, so the model cannot
 * be tried by composing what exists. The alternative — hand-authoring sets for 107 thin pages — is
 * an expensive way to discover the model is wrong. kb:entity-sets already records that a set can
 * be DERIVED from a predicate, verified by hand on a real graph, so this derives candidates from
 * structure the docs graphs already carry and reports the site they would produce:
 *
 *   skos:broader   a parent and its children are a set, and the parent names it
 *   HUBS           a highly-connected entity is a key concept, and its neighbourhood is the set
 *
 * WHY HUBS AND NOT A SHARED TYPE. The first draft derived the second kind from rdf:type — every
 * ktype:Concept in one graph — and Matt rejected it on sight: "hubs would be a better indicator of
 * potential sets, to further describe a key concept as a larger set of entities, rather than
 * something like a shared predicate term." The output proved him right before the argument did. A
 * type grouping produced pages titled "Concepts in timeline-ecosystem" and "Concepts in
 * use-cases" — a category is not a subject, and nobody opens a page named after a filter. A hub
 * is chosen by the graph's own shape: an entity many things point at is a key concept BECAUSE
 * things point at it, and its label is already the name of the page.
 *
 * WHAT IT REPORTS, and the last two are the point:
 *   PAGES     how many, and how substantial, against today's 172 pages at a median of 87 words
 *   ORPHANS   entities no candidate set claims — these would LOSE their page, and the difference
 *             between curating and losing content is entirely whether they are listed
 *   LINKS     pairs of sets sharing a member. Matt: pages can be linked especially when they share
 *             an entity. Derived, never authored, so the cross-links cannot go stale.
 *
 * Usage: npx tsx scripts/offline/set-pages.ts [--min-members=2] [--quiet]
 */

import { Parser, type Quad } from 'n3';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const QUIET = args.includes('--quiet');
/** A "set" of one is an entity wearing a hat. Two is the floor, as in set-score.ts. */
const MIN_MEMBERS = Math.max(2, parseInt(arg('min-members', '2'), 10) || 2);
/** Edges an entity needs before it counts as a hub — a key concept the graph itself points at. */
const HUB_DEGREE = Math.max(2, parseInt(arg('hub-degree', '4'), 10) || 4);

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_DEF = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const KTYPE_NS = 'urn:kbase:type/';
const NAV_NS = 'urn:reckons:docs/nav/';

/** Mirrors SOURCES in docs-pages.ts. Kept in step by docs-graph-registration.ts. */
const CORPUS = [
  'docs-triples-rdf.ttl', 'docs-llm.ttl', 'docs-use-cases.ttl', 'docs-features.ttl',
  'docs-integrations-tech.ttl', 'docs-tips-security.ttl', 'docs-timeline-ecosystem.ttl',
  'docs-architecture.ttl', 'docs-coding-workflow.ttl', 'docs-testing.ttl',
  'docs-user-paths.ttl', 'starter-guide.ttl',
];

interface Ent { iri: string; graph: string; title: string; words: number; types: string[]; parent?: string }

/** Entities plus the IRI-to-IRI edges between them — the graph's shape, which is what finds hubs. */
function readEntities(): { entities: Ent[]; edges: Array<[string, string]> } {
  const out: Ent[] = [];
  const edges: Array<[string, string]> = [];
  for (const file of CORPUS) {
    const path = join(STATIC_DIR, file);
    if (!existsSync(path)) continue;
    let quads: Quad[];
    try { quads = new Parser().parse(readFileSync(path, 'utf8')); } catch { continue; }

    const types = new Map<string, string[]>(), titles = new Map<string, string>();
    const words = new Map<string, number>(), parents = new Map<string, string>();
    for (const q of quads) {
      const s = q.subject.value;
      if (s.startsWith(NAV_NS)) continue;
      if (q.predicate.value === RDF_TYPE && q.object.value.startsWith(KTYPE_NS)) {
        types.set(s, [...(types.get(s) ?? []), q.object.value.slice(KTYPE_NS.length)]);
      } else if (q.predicate.value === RDFS_LABEL) titles.set(s, q.object.value);
      else if (q.predicate.value === SKOS_BROADER) parents.set(s, q.object.value);
      // Every literal counts toward weight: it is what renderProse would put on the page.
      if (q.object.termType === 'Literal' && q.predicate.value !== RDFS_LABEL) {
        words.set(s, (words.get(s) ?? 0) + q.object.value.split(/\s+/).length);
      } else if (q.object.termType === 'NamedNode' && q.predicate.value !== RDF_TYPE
                 && !q.object.value.startsWith(NAV_NS)) {
        // An edge to another entity. rdf:type is excluded: it points at a CLASS, not a peer, and
        // counting it would make every entity a neighbour of ktype:Concept and that the only hub.
        edges.push([s, q.object.value]);
      }
    }
    for (const [iri, t] of types) {
      out.push({
        iri, graph: file, title: titles.get(iri) ?? iri.split(/[/#]/).pop() ?? iri,
        words: words.get(iri) ?? 0, types: [...t].sort(), parent: parents.get(iri),
      });
    }
  }
  return { entities: out, edges };
}

interface CandidateSet { id: string; label: string; basis: 'broader' | 'hub'; graph: string; members: Ent[] }

/** Two derivations, kept apart so the report can say which structure produced which page. */
function derive(entities: Ent[], edges: Array<[string, string]>): CandidateSet[] {
  const byIri = new Map(entities.map((e) => [e.iri, e]));
  const sets: CandidateSet[] = [];

  // (1) A parent and its children. The parent NAMES the set and is also its lede.
  const kids = new Map<string, Ent[]>();
  for (const e of entities) {
    if (!e.parent) continue;
    kids.set(e.parent, [...(kids.get(e.parent) ?? []), e]);
  }
  for (const [parent, members] of kids) {
    const p = byIri.get(parent);
    if (!p || members.length < MIN_MEMBERS) continue;
    sets.push({ id: `broader:${parent}`, label: p.title, basis: 'broader', graph: p.graph, members: [p, ...members] });
  }

  // (2) HUBS. An entity many things point at is a key concept, and its neighbourhood is the set
  // it names. Degree is counted over IRI edges only — a literal is a property of an entity, not a
  // connection to another one, and counting literals would rank the wordiest entity as the most
  // central rather than the most connected.
  const claimedByBroader = new Set(sets.flatMap((s) => s.members.map((m) => m.iri)));
  const degree = new Map<string, number>();
  const neighbours = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!byIri.has(a) || !byIri.has(b) || a === b) continue;
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }

  const hubs = [...degree.entries()]
    .filter(([iri, d]) => d >= HUB_DEGREE && !claimedByBroader.has(iri))
    .sort((x, y) => y[1] - x[1]);

  const takenByHub = new Set<string>();
  for (const [iri] of hubs) {
    const hub = byIri.get(iri)!;
    // A neighbour already inside another set stays there: one entity may appear on two pages, and
    // that overlap is the cross-link, but a hub should not be built entirely out of borrowed parts.
    const members = [...(neighbours.get(iri) ?? [])]
      .map((n) => byIri.get(n))
      .filter((n): n is Ent => Boolean(n) && !takenByHub.has(n!.iri) && !claimedByBroader.has(n!.iri));
    if (members.length + 1 < MIN_MEMBERS) continue;
    for (const m of members) takenByHub.add(m.iri);
    takenByHub.add(iri);
    sets.push({ id: `hub:${iri}`, label: hub.title, basis: 'hub', graph: hub.graph, members: [hub, ...members] });
  }

  return sets;
}

function main(): void {
  const { entities, edges } = readEntities();
  const sets = derive(entities, edges);

  const claimed = new Set(sets.flatMap((s) => s.members.map((m) => m.iri)));
  const orphans = entities.filter((e) => !claimed.has(e.iri));

  const words = (s: CandidateSet) => s.members.reduce((n, m) => n + m.words, 0);
  const sorted = [...sets].sort((a, b) => words(b) - words(a));
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

  console.log('');
  console.log(C.bold('set-defined pages') + C.dim(' — what the docs would be if a SET were a page (F187.5)'));
  console.log(C.dim(`  ${entities.length} entities · today they publish as ${entities.length} separate pages, median 87 words`));
  console.log(
    `  ${C.bold(String(sets.length))} candidate page(s) — median ${C.bold(String(median(sets.map(words))))} words, `
    + `${sets.filter((s) => s.members.length >= 4).length} with 4+ sections`,
  );

  if (!QUIET) {
    console.log('');
    for (const s of sorted.slice(0, 12)) {
      console.log(
        `  ${C.bold(s.label.slice(0, 40).padEnd(42))} ${String(s.members.length).padStart(2)} entities  `
        + `${String(words(s)).padStart(4)} words  ${C.dim(s.basis)}`,
      );
    }
    if (sorted.length > 12) console.log(C.dim(`  … and ${sorted.length - 12} more`));
  }

  // LINKS — the derived navigation. Two sets sharing a member are related by that fact.
  const links: Array<{ a: CandidateSet; b: CandidateSet; shared: string[] }> = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const bm = new Set(sets[j].members.map((m) => m.iri));
      const shared = sets[i].members.filter((m) => bm.has(m.iri)).map((m) => m.title);
      if (shared.length) links.push({ a: sets[i], b: sets[j], shared });
    }
  }
  console.log('');
  console.log(C.bold(`  ${links.length} cross-link(s)`) + C.dim(' — pages that share an entity, derived not authored'));
  for (const l of links.slice(0, 6)) {
    console.log(C.dim(`    ${l.a.label.slice(0, 28)} ↔ ${l.b.label.slice(0, 28)}  (${l.shared.slice(0, 3).join(', ')})`));
  }
  if (links.length > 6) console.log(C.dim(`    … and ${links.length - 6} more`));

  // ORPHANS — the number that decides whether this architecture is honest.
  console.log('');
  if (orphans.length === 0) {
    console.log(C.green('  every entity is claimed by a candidate set — nothing would lose its place.'));
  } else {
    console.log(C.yellow(C.bold(`  ${orphans.length} entit${orphans.length === 1 ? 'y is' : 'ies are'} claimed by no set`))
      + C.dim(' — each would need a set, a parent, or a stated exclusion'));
    if (!QUIET) for (const o of orphans.slice(0, 10)) {
      console.log(C.dim(`    ${o.title.slice(0, 44).padEnd(46)} ${String(o.words).padStart(4)}w  ${o.graph.replace(/^docs-|\.ttl$/g, '')}`));
    }
    if (orphans.length > 10) console.log(C.dim(`    … and ${orphans.length - 10} more`));
  }
  console.log('');
  console.log(C.dim('  Derived from skos:broader and HUB DEGREE only. This proposes NOTHING and writes NOTHING —\n'
    + '  it exists so the one-set-one-page model can be judged against real numbers before sets are\n'
    + '  authored by hand. An orphan here is not automatically a failure: Matt, 2026-09-08, "not every\n'
    + '  graph entity needs to land on a page". Some belong in a set nobody has written yet; some\n'
    + '  should be excluded with a stated reason. Both are decisions, and this is the list to make\n'
    + '  them against.'));
}

if (process.argv[1] && process.argv[1].endsWith('set-pages.ts')) main();
