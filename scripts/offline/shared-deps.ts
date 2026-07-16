#!/usr/bin/env npx tsx
/**
 * Shared-dependency analysis of the roadmap (Matt, 2026-07-15: "look at the whole roadmap for
 * shared dependencies — avoid separate code for nearly the same task").
 *
 * The divergence GraphLabels just fixed (two copies of one label overlay) is the failure this
 * guards against at the PLAN level: two features that need nearly the same thing, built separately.
 * This reads the feature graph and surfaces three signals:
 *
 *   1. DEPENDENCY HUBS — an entity many features depend-on / relate-to. That is a SHARED
 *      CAPABILITY; it should be built once and reused, not re-implemented per dependent.
 *   2. SHARED FILES — a source file listed by more than one feature (has-file / tested-by). Good:
 *      those features already share code. Shown so the shared modules are visible.
 *   3. OVERLAP WARNINGS — features that point at the SAME hub but whose has-file sets are DISJOINT.
 *      They need the same thing yet touch no common file: the exact shape of "separate code for
 *      nearly the same task". These are the candidates for a shared abstraction.
 *
 * Deterministic, zero tokens, no model — it just reads the graph. Script tier (F74.3).
 *
 *   npx tsx scripts/offline/shared-deps.ts            full report
 *   npx tsx scripts/offline/shared-deps.ts --top=15   cap each section
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Parser, type Quad } from 'n3';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const FEATURE = 'urn:kbase:type/Feature';
const TOP = Number((process.argv.find((a) => a.startsWith('--top='))?.split('=')[1]) ?? 20);
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';

const quads: Quad[] = [];
for (const f of readdirSync('static').filter((x) => x.endsWith('.ttl')).sort()) {
  try {
    quads.push(...new Parser().parse(readFileSync(path.join('static', f), 'utf8')));
  } catch {
    /* graph-lint reports parse errors */
  }
}

const short = (iri: string) => iri.replace(KPRED, 'kpred:').replace('urn:kbase:concept/', 'kb:').replace('urn:kbase:type/', 'ktype:');
const featureIris = new Set(quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === FEATURE).map((q) => q.subject.value));

interface Feat {
  iri: string;
  label: string;
  files: Set<string>;
  links: Set<string>; // depends-on ∪ relates-to targets
}
const LINK_PREDS = new Set([`${KPRED}depends-on`, `${KPRED}relates-to`, `${KPRED}part-of`]);
const FILE_PREDS = new Set([`${KPRED}has-file`, `${KPRED}tested-by`]);

const feats = new Map<string, Feat>();
for (const iri of featureIris) feats.set(iri, { iri, label: iri, files: new Set(), links: new Set() });
for (const q of quads) {
  const f = feats.get(q.subject.value);
  if (!f) continue;
  if (q.predicate.value === RDFS_LABEL) f.label = q.object.value;
  else if (FILE_PREDS.has(q.predicate.value)) f.files.add(q.object.value);
  else if (LINK_PREDS.has(q.predicate.value)) f.links.add(q.object.value);
}

// ── 1. Dependency hubs: targets many features point at ──────────────────────
const hubCount = new Map<string, string[]>();
for (const f of feats.values()) for (const t of f.links) (hubCount.get(t) ?? hubCount.set(t, []).get(t)!).push(f.iri);
const hubs = [...hubCount.entries()].filter(([, fs]) => fs.length >= 3).sort((a, b) => b[1].length - a[1].length);

console.log(`${B}Shared-dependency analysis${X} ${D}— ${feats.size} features across static/*.ttl${X}\n`);
console.log(`${B}${C}dependency hubs${X} ${D}— a capability ${'>='}3 features rely on; build once, reuse${X}`);
for (const [target, fs] of hubs.slice(0, TOP)) {
  console.log(`  ${B}${fs.length}${X} → ${short(target)}  ${D}${fs.map((i) => feats.get(i)?.label ?? short(i)).slice(0, 4).join(' · ')}${fs.length > 4 ? ' …' : ''}${X}`);
}

// ── 2. Shared files: source touched by more than one feature ────────────────
const fileOwners = new Map<string, string[]>();
for (const f of feats.values()) for (const file of f.files) (fileOwners.get(file) ?? fileOwners.set(file, []).get(file)!).push(f.label);
const sharedFiles = [...fileOwners.entries()].filter(([, o]) => new Set(o).size > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`\n${B}${G}shared files${X} ${D}— source listed by >1 feature (already shared code)${X}`);
if (sharedFiles.length === 0) console.log(`  ${D}none — every file belongs to exactly one feature${X}`);
for (const [file, owners] of sharedFiles.slice(0, TOP)) console.log(`  ${B}${new Set(owners).size}${X} ${file}  ${D}${[...new Set(owners)].slice(0, 3).join(' · ')}${X}`);

// ── 3. Overlap warnings: same hub, DISJOINT files ───────────────────────────
console.log(`\n${B}${Y}overlap warnings${X} ${D}— features sharing a hub but NO common file (near-same task, separate code?)${X}`);
let warned = 0;
const seen = new Set<string>();
for (const [target, owners] of hubs) {
  // pairwise within each hub, flag those with files but no overlap
  const withFiles = owners.map((i) => feats.get(i)!).filter((f) => f.files.size > 0);
  for (let i = 0; i < withFiles.length; i++)
    for (let j = i + 1; j < withFiles.length; j++) {
      const a = withFiles[i], b = withFiles[j];
      const overlap = [...a.files].some((x) => b.files.has(x));
      if (overlap) continue;
      const key = [a.iri, b.iri].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (warned++ < TOP) console.log(`  ${Y}·${X} ${a.label} ${D}⋈${X} ${b.label}  ${D}both → ${short(target)}, disjoint files${X}`);
    }
}
if (warned === 0) console.log(`  ${G}none — every co-dependent feature pair shares at least one file${X}`);
console.log(`\n${D}${warned} overlap pair(s), ${hubs.length} hub(s), ${sharedFiles.length} shared file(s). Read a warning as "should these share a module?", not "bug".${X}`);
