#!/usr/bin/env npx tsx
/**
 * Taxonomy current (F263, SCRIPT tier) - does the central taxonomy match the code?
 *
 * static/reckons-terminology.ttl and static/reckons-vocabulary.ttl say what the words and the
 * closed value sets ARE. The code enforces its own copies. Nothing compared the two, so a type
 * added in entity-types.ts got no term, and a term could outlive the type it described. Every
 * check here has a checkable answer, so it is a rule, not a model's judgment.
 *
 * Checks:
 *   type-no-term       a BUILT_IN_TYPES entry that no term or vocabulary class names
 *   term-stale-type    a term pointing (match predicates) at a urn:kbase:type/ IRI that is
 *                      neither a built-in type nor a class declared anywhere in static/
 *   enum-missing       a value the code enforces that the vocabulary scheme lacks
 *   enum-extra         a vocabulary notation the code no longer accepts
 *
 * Enums compared: statement review status (src/lib/rdf/types.ts), the six feature statuses
 * (scheme vs the statuses features actually carry), and schema:ActionStatus (proposal.ts vs the
 * kshape:Proposal sh:in list). Generation job states: no such enum exists in code (2026-10-23),
 * so there is nothing to compare, and this script does not pretend otherwise.
 *
 * Usage: npx tsx scripts/offline/taxonomy-current.ts [--json] [--check]
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Parser, type Quad } from 'n3';
import { BUILT_IN_TYPES } from '../../src/lib/rdf/entity-types.ts';
import { ACTION_STATUSES } from '../../src/lib/rdf/proposal.ts';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const TYPE_NS = 'urn:kbase:type/';
const KPRED = 'urn:kbase:predicate/';
const LABEL_PREDS = [
  `${SKOS}prefLabel`, `${SKOS}altLabel`, `${SKOS}hiddenLabel`,
  `${KPRED}user-label`, `${KPRED}developer-label`, `${KPRED}standards-label`,
  'http://www.w3.org/2000/01/rdf-schema#label',
];
const MATCH_PREDS = [`${SKOS}exactMatch`, `${SKOS}closeMatch`, `${SKOS}relatedMatch`, `${KPRED}names-type`];

export type Gap = { kind: 'type-no-term' | 'term-stale-type' | 'enum-missing' | 'enum-extra'; subject: string; detail: string; description?: string };
export type TypeDef = { iri: string; label: string; description: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const has = (a: string, b: string) => a === b || ` ${a} `.includes(` ${b} `);

/** Every literal label a TERM-bearing subject carries, normalized. */
function labelIndex(quads: Quad[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const q of quads) {
    if (!LABEL_PREDS.includes(q.predicate.value) || q.object.termType !== 'Literal') continue;
    for (const part of q.object.value.split('/')) {
      const k = norm(part);
      if (k && !m.has(k)) m.set(k, q.subject.value);
    }
  }
  return m;
}

export function checkTypes(termQuads: Quad[], allQuads: Quad[], types: TypeDef[]): Gap[] {
  const gaps: Gap[] = [];
  const labels = labelIndex(termQuads);
  const named = new Set<string>();
  for (const q of termQuads) {
    named.add(q.subject.value);
    if (q.object.termType === 'NamedNode') named.add(q.object.value);
  }
  for (const t of types) {
    // Labels are matched whole; a one-word type must match a label exactly or as a whole-word part.
    const k = norm(t.label);
    const byLabel = labels.has(k) || [...labels.keys()].some((l) => k.includes(' ') ? l === k : has(l, k) && l.split(' ').length <= 3);
    if (!named.has(t.iri) && !byLabel) {
      gaps.push({ kind: 'type-no-term', subject: t.iri, detail: `built-in type "${t.label}" has no term or vocabulary class`, description: t.description });
    }
  }
  const known = new Set(types.map((t) => t.iri));
  const declared = new Set(allQuads.filter((q) => q.predicate.value === RDF_TYPE && /Class$/.test(q.object.value)).map((q) => q.subject.value));
  for (const q of termQuads) {
    if (!MATCH_PREDS.includes(q.predicate.value) || !q.object.value.startsWith(TYPE_NS)) continue;
    if (!known.has(q.object.value) && !declared.has(q.object.value)) {
      gaps.push({ kind: 'term-stale-type', subject: q.subject.value, detail: `names type ${q.object.value}, which the code no longer has` });
    }
  }
  return gaps;
}

export function schemeNotations(quads: Quad[], schemeIri: string): Set<string> {
  const members = new Set(quads.filter((q) => q.predicate.value === `${SKOS}inScheme` && q.object.value === schemeIri).map((q) => q.subject.value));
  const out = new Set<string>();
  for (const q of quads) if (members.has(q.subject.value) && q.predicate.value === `${SKOS}notation`) out.add(q.object.value);
  return out;
}

export function checkEnum(name: string, code: Iterable<string>, vocab: Set<string>): Gap[] {
  const c = new Set(code);
  const gaps: Gap[] = [];
  for (const v of c) if (!vocab.has(v)) gaps.push({ kind: 'enum-missing', subject: name, detail: `code accepts "${v}"; the vocabulary scheme has no such value` });
  for (const v of vocab) if (!c.has(v)) gaps.push({ kind: 'enum-extra', subject: name, detail: `vocabulary lists "${v}"; the code does not accept it` });
  return gaps;
}

/** The members of an `export type X = | 'a' | 'b'` union, read from source text. */
export function unionMembers(source: string, typeName: string): string[] {
  const bare = source.replace(/\/\/[^\n]*/g, '');
  const m = bare.match(new RegExp(`export type ${typeName}\\s*=([^;]*);`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

/** The IRIs inside the sh:in list of kshape:Proposal's actionStatus property. */
export function shInIris(quads: Quad[], path_: string): string[] {
  const prop = quads.find((q) => q.predicate.value === 'http://www.w3.org/ns/shacl#path' && q.object.value === path_)?.subject;
  const head = prop && quads.find((q) => q.subject.equals(prop) && q.predicate.value === 'http://www.w3.org/ns/shacl#in')?.object;
  const out: string[] = [];
  let cur = head;
  while (cur && cur.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil') {
    const first = quads.find((q) => q.subject.equals(cur!) && q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first');
    if (first) out.push(first.object.value);
    cur = quads.find((q) => q.subject.equals(cur!) && q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest')?.object;
  }
  return out;
}

const parse = (file: string) => new Parser().parse(readFileSync(file, 'utf8'));

export function run(root: string): { gaps: Gap[]; counts: Record<string, number>; types: number } {
  const p = (f: string) => path.join(root, f);
  const terms = parse(p('static/reckons-terminology.ttl'));
  const vocab = parse(p('static/reckons-vocabulary.ttl'));
  const all: Quad[] = [];
  for (const f of readdirSync(p('static')).filter((x) => x.endsWith('.ttl'))) {
    try { all.push(...parse(p(`static/${f}`))); } catch { /* graph-lint reports parse failures */ }
  }
  const types: TypeDef[] = BUILT_IN_TYPES.map((t) => ({ iri: t.iri, label: t.label, description: t.description }));
  const gaps = checkTypes([...terms, ...vocab], all, types);
  const typesSrc = readFileSync(p('src/lib/rdf/types.ts'), 'utf8');
  gaps.push(...checkEnum('statement review status', unionMembers(typesSrc, 'ReviewStatus'), schemeNotations(vocab, 'urn:kbase:type/ReviewStatusScheme')));
  const used = new Set<string>();
  for (const q of all) if (q.predicate.value === `${KPRED}has-status` && q.object.termType === 'Literal') used.add(q.object.value);
  const life = schemeNotations(vocab, 'urn:kbase:type/FeatureLifecycle');
  gaps.push(...checkEnum('feature status', [...used].filter((s) => life.has(s) || /^(speculative|planned|in-progress|scaffolded|functional|production)$/.test(s)), life));
  gaps.push(...checkEnum('schema:ActionStatus', ACTION_STATUSES, new Set(shInIris(vocab, 'https://schema.org/actionStatus'))));
  const counts: Record<string, number> = {};
  for (const g of gaps) counts[g.kind] = (counts[g.kind] ?? 0) + 1;
  return { gaps, counts, types: types.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const res = run(process.cwd());
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`Taxonomy current - ${res.types} built-in types, ${res.gaps.length} gap(s)\n`);
    for (const g of res.gaps) console.log(`  [${g.kind}] ${g.subject}: ${g.detail}`);
    if (res.gaps.length === 0) console.log('  the taxonomy matches the code.');
    console.log('\nGeneration job states: no such enum exists in code, so nothing was compared.');
  }
  if (argv.includes('--check') && res.gaps.length > 0) process.exit(1);
}
