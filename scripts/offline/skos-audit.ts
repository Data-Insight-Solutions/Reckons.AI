#!/usr/bin/env npx tsx
/**
 * SKOS conformance audit (SCRIPT tier) — how do our graphs stand against SKOS?
 *
 * This project uses SKOS heavily (skos:broader, skos:related, skos:definition) without
 * ever having checked itself against the standard. "Are we SKOS-compliant?" sounds like a
 * research question, but most of it is NOT: the SKOS Reference (W3C REC, 2009) states
 * INTEGRITY CONDITIONS that are machine-checkable. So it is a script, not an opinion.
 *
 * Findings are split into two classes and the distinction is load-bearing:
 *
 *   VIOLATION — breaks a normative integrity condition in the SKOS Reference. These are
 *               defects against the standard.
 *   PRACTICE  — conflicts with widely-held convention (SKOS Primer, qSKOS-style quality
 *               criteria). Legal SKOS, but a vocabulary tool may handle it poorly. These
 *               are judgment calls and are reported as such, never as errors.
 *
 * Deliberately NOT checked: whether our concepts are the RIGHT concepts. No script decides
 * that.
 *
 * Usage:
 *   npx tsx scripts/offline/skos-audit.ts
 *   npx tsx scripts/offline/skos-audit.ts --json
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';

const JSON_OUT = process.argv.includes('--json');
const S = 'http://www.w3.org/2004/02/skos/core#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const quads: Quad[] = [];
for (const f of readdirSync('static').filter((x) => x.endsWith('.ttl')).sort()) {
  try { quads.push(...new Parser().parse(readFileSync(path.join('static', f), 'utf8'))); }
  catch { /* graph-lint reports parse errors */ }
}

const of = (p: string) => quads.filter((q) => q.predicate.value === `${S}${p}`);
const count = (p: string) => of(p).length;
const short = (i: string) => i.replace('urn:kbase:concept/', 'kb:').replace('urn:reckons:docs/', '').replace(/^.*[/#]/, '');

interface Finding { id: string; kind: 'VIOLATION' | 'PRACTICE'; title: string; detail: string; n: number; sample: string[] }
const findings: Finding[] = [];
const add = (f: Finding) => { if (f.n > 0) findings.push(f); };

// ── S13: prefLabel / altLabel / hiddenLabel are pairwise disjoint ────────────
const labelSets = new Map<string, Map<string, Set<string>>>(); // subject -> prop -> literals
for (const p of ['prefLabel', 'altLabel', 'hiddenLabel']) {
  for (const q of of(p)) {
    const m = labelSets.get(q.subject.value) ?? labelSets.set(q.subject.value, new Map()).get(q.subject.value)!;
    (m.get(p) ?? m.set(p, new Set()).get(p)!).add(q.object.value);
  }
}
const s13: string[] = [];
for (const [subj, m] of labelSets) {
  const pref = m.get('prefLabel') ?? new Set(), alt = m.get('altLabel') ?? new Set(), hid = m.get('hiddenLabel') ?? new Set();
  for (const v of pref) if (alt.has(v) || hid.has(v)) s13.push(`${short(subj)} "${v}"`);
  for (const v of alt) if (hid.has(v)) s13.push(`${short(subj)} "${v}"`);
}
add({ id: 'S13', kind: 'VIOLATION', title: 'Label properties must be pairwise disjoint', detail: 'The same literal appears as more than one of prefLabel/altLabel/hiddenLabel on one resource.', n: s13.length, sample: s13.slice(0, 5) });

// ── S14: at most one prefLabel per language tag ─────────────────────────────
const prefByLang = new Map<string, Map<string, number>>();
for (const q of of('prefLabel')) {
  const lang = (q.object as any).language || '';
  const m = prefByLang.get(q.subject.value) ?? prefByLang.set(q.subject.value, new Map()).get(q.subject.value)!;
  m.set(lang, (m.get(lang) ?? 0) + 1);
}
const s14 = [...prefByLang.entries()].flatMap(([s, m]) => [...m.entries()].filter(([, n]) => n > 1).map(([l, n]) => `${short(s)} has ${n} prefLabels @${l || 'no-lang'}`));
add({ id: 'S14', kind: 'VIOLATION', title: 'At most one prefLabel per language', detail: 'A resource carries multiple skos:prefLabel values in the same language tag.', n: s14.length, sample: s14.slice(0, 5) });

// ── S27: skos:related is disjoint with skos:broaderTransitive ───────────────
// Build the transitive closure of broader, then check no related pair sits inside it.
const broader = new Map<string, Set<string>>();
for (const q of [...of('broader'), ...of('broaderTransitive')]) {
  (broader.get(q.subject.value) ?? broader.set(q.subject.value, new Set()).get(q.subject.value)!).add(q.object.value);
}
for (const q of of('narrower')) { // narrower is the inverse
  (broader.get(q.object.value) ?? broader.set(q.object.value, new Set()).get(q.object.value)!).add(q.subject.value);
}
function ancestors(start: string): Set<string> {
  const seen = new Set<string>(); const stack = [...(broader.get(start) ?? [])];
  while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); for (const p of broader.get(n) ?? []) stack.push(p); }
  return seen;
}
const s27: string[] = [];
for (const q of of('related')) {
  const a = q.subject.value, b = q.object.value;
  if (ancestors(a).has(b) || ancestors(b).has(a)) s27.push(`${short(a)} related ${short(b)} — but also in a broader chain`);
}
add({ id: 'S27', kind: 'VIOLATION', title: 'related is disjoint with broaderTransitive', detail: 'A pair is asserted both hierarchically (broader/narrower) and associatively (related). SKOS forbids this: a concept cannot be both an ancestor of and merely associated with another.', n: s27.length, sample: s27.slice(0, 5) });

// ── Hierarchy cycles (quality, not normative) ───────────────────────────────
const cycles: string[] = [];
for (const s of broader.keys()) if (ancestors(s).has(s)) cycles.push(short(s));
add({ id: 'CYCLE', kind: 'PRACTICE', title: 'Cyclic hierarchical relations', detail: 'A concept is its own ancestor. Not forbidden by the Reference, but it breaks tree rendering and most vocabulary tools.', n: cycles.length, sample: cycles.slice(0, 5) });

// ── Concept scheme membership ───────────────────────────────────────────────
const schemes = quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${S}ConceptScheme`).length;
const concepts = new Set(quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${S}Concept`).map((q) => q.subject.value));
const inScheme = new Set(of('inScheme').map((q) => q.subject.value));
const orphanScheme = [...concepts].filter((c) => !inScheme.has(c));
add({ id: 'SCHEME', kind: 'PRACTICE', title: 'Concepts not in any ConceptScheme', detail: `${schemes} skos:ConceptScheme declared. SKOS concepts are conventionally grouped into a scheme via skos:inScheme, with entry points via skos:hasTopConcept — this is how a vocabulary tool knows where to start.`, n: orphanScheme.length, sample: orphanScheme.slice(0, 5).map(short) });

// ── prefLabel vs rdfs:label ─────────────────────────────────────────────────
const labelled = new Set(quads.filter((q) => q.predicate.value === RDFS_LABEL).map((q) => q.subject.value));
const noPref = [...concepts].filter((c) => !prefByLang.has(c));
add({ id: 'PREFLABEL', kind: 'PRACTICE', title: 'Concepts using rdfs:label instead of skos:prefLabel', detail: `skos:prefLabel is a sub-property of rdfs:label, so rdfs:label is COMPATIBLE, not wrong — but SKOS tools key on prefLabel, and without it a concept looks unlabelled to them. ${labelled.size} resources carry rdfs:label; ${count('prefLabel')} carry prefLabel.`, n: noPref.length, sample: noPref.slice(0, 5).map(short) });

// ── Language tags ───────────────────────────────────────────────────────────
const allLabels = [...of('prefLabel'), ...of('altLabel'), ...quads.filter((q) => q.predicate.value === RDFS_LABEL)];
const untagged = allLabels.filter((q) => !(q.object as any).language);
add({ id: 'LANG', kind: 'PRACTICE', title: 'Labels without a language tag', detail: 'SKOS label properties are designed around language tags; S14 (one prefLabel per language) cannot be enforced without them. Fine for a single-language vocabulary, blocking for translation.', n: untagged.length, sample: [] });

// ── broader/related used on things not typed skos:Concept ───────────────────
const hierSubjects = new Set([...of('broader'), ...of('narrower'), ...of('related')].flatMap((q) => [q.subject.value, q.object.value]));
const notConcept = [...hierSubjects].filter((s) => !concepts.has(s));
add({ id: 'DOMAIN', kind: 'PRACTICE', title: 'Hierarchy used on resources not typed skos:Concept', detail: 'skos:broader/narrower/related have domain and range skos:Concept, so a reasoner will INFER these resources are Concepts. Harmless in practice, but it means the type is implicit rather than stated — and our own ktype:Concept is a separate, unrelated class.', n: notConcept.length, sample: notConcept.slice(0, 5).map(short) });

// ── Orphans: concepts with no relations at all ──────────────────────────────
const related = new Set([...of('broader'), ...of('narrower'), ...of('related')].flatMap((q) => [q.subject.value, q.object.value]));
const orphans = [...concepts].filter((c) => !related.has(c));
add({ id: 'ORPHAN', kind: 'PRACTICE', title: 'Concepts with no hierarchical or associative relations', detail: 'An unconnected concept is reachable only by search. Not an error — but in a navigable vocabulary it is usually an oversight.', n: orphans.length, sample: orphans.slice(0, 5).map(short) });

const violations = findings.filter((f) => f.kind === 'VIOLATION');
const practices = findings.filter((f) => f.kind === 'PRACTICE');

if (JSON_OUT) {
  console.log(JSON.stringify({ counts: Object.fromEntries(['prefLabel','altLabel','hiddenLabel','broader','narrower','related','definition','inScheme','exactMatch','notation'].map((p) => [p, count(p)])), schemes, concepts: concepts.size, findings }, null, 2));
  process.exit(0);
}

console.log(`\n${B}SKOS conformance audit${X} ${D}— ${quads.length} quads, ${concepts.size} skos:Concept, ${schemes} skos:ConceptScheme${X}`);
console.log(`${D}vocabulary in use: ${['prefLabel','altLabel','hiddenLabel','broader','narrower','related','definition','inScheme'].map((p) => `${p} ${count(p)}`).join(' · ')}${X}\n`);

console.log(`${B}${violations.length ? R : G}NORMATIVE${X} ${D}— integrity conditions from the SKOS Reference (W3C REC). These are defects.${X}`);
if (!violations.length) console.log(`  ${G}none — no integrity condition is violated${X}`);
for (const f of violations) {
  console.log(`  ${R}${f.id}${X} ${B}${f.title}${X} ${R}${f.n}${X}`);
  console.log(`     ${D}${f.detail}${X}`);
  for (const s of f.sample) console.log(`     ${D}· ${s}${X}`);
}

console.log(`\n${B}${Y}CONVENTION${X} ${D}— widely-held practice, not normative. Judgment calls, reported not enforced.${X}`);
for (const f of practices) {
  console.log(`  ${Y}${f.id}${X} ${B}${f.title}${X} ${Y}${f.n}${X}`);
  console.log(`     ${D}${f.detail}${X}`);
  for (const s of f.sample) console.log(`     ${D}· ${s}${X}`);
}

console.log(`\n${D}${violations.length} normative violation(s), ${practices.length} convention finding(s).${X}`);
console.log(`${C}This audit checks CONFORMANCE, not whether these are the right concepts. No script decides that.${X}\n`);
