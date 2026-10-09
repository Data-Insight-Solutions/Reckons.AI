/**
 * BUILD THE REVIEWED GETTING STARTED SPACE (F248 step 2, script tier) — no model, same output
 * every run.
 *
 * Reads the curated starter (static/starter-everyday.ttl), the plan (everyday-plan.json) and the
 * approved sample texts (static/starter/everyday-sources/<id>.md), and writes
 * static/starter-everyday-reviewed.ttl in the app's own full export format (toTurtleFull), so the
 * app's own importer reads it back: each sample as a meta:Source with the hash of its text, and
 * each planned fact with its source, its excerpt, its status, who settled it and when, and any
 * statement it replaced. Facts the plan does not name stay curated: confirmed, no source.
 *
 * THE PASSAGE MUST BE IN THE SOURCE (the F248 principle). Every excerpt is re-found in its
 * source's text here; one that is missing fails the build by name. Excerpts are re-derived from
 * the approved texts (excerptFor), never stored separately, so the text and its evidence cannot
 * drift apart.
 *
 * Usage: npx tsx scripts/starter/build-everyday.ts            write the reviewed starter
 *        npx tsx scripts/starter/build-everyday.ts --check    fail if the file on disk is stale
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl.js';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { hashSourceText } from '../../src/lib/rdf/source-cache.js';
import type { Source, Statement, Term } from '../../src/lib/rdf/types.js';
import { excerptFor, readPlan, type Plan, type PlanFact } from './draft-sample-sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STARTER = path.join(ROOT, 'static', 'starter-everyday.ttl');
export const OUT = path.join(ROOT, 'static', 'starter-everyday-reviewed.ttl');
export const TEXT_DIR = path.join(ROOT, 'static', 'starter', 'everyday-sources');
/** Where the loader fetches a sample's text from, relative to the site root. */
export const textUrl = (id: string) => `/starter/everyday-sources/${id}.md`;

const CONCEPT = 'urn:kbase:concept/';
const PRED = 'urn:kbase:predicate/';
/** Curated facts are dated to when the friends started planning; nothing about them is reviewed. */
const CURATED_AT = Date.parse('2026-07-03T18:00:00Z');

const termKey = (t: Term) => (t.kind === 'literal' ? t.value : t.value.startsWith(CONCEPT) ? t.value.slice(CONCEPT.length) : t.value);
export const factKey = (st: Pick<Statement, 's' | 'p' | 'o'>) => `${termKey(st.s)}|${st.p.value.slice(PRED.length)}|${termKey(st.o)}`;
/** Stable id: the same fact gets the same id on every build. */
export const stableId = (key: string) => `starter-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

export type BuildInput = { starterTtl: string; plan: Plan; texts: Record<string, string> };
export type BuildResult = { statements: Statement[]; sources: Source[]; problems: string[] };

/** Pure apart from hashing: curated statements + the plan + the texts → annotated statements and sources. */
export async function buildReviewed({ starterTtl, plan, texts }: BuildInput): Promise<BuildResult> {
  const problems: string[] = [];
  const { statements: curated } = await importTurtleFull(starterTtl, { name: 'starter-everyday.ttl' });
  const byKey = new Map<string, Statement>();
  for (const st of curated) {
    const key = factKey(st);
    byKey.set(key, { ...st, id: stableId(key), status: 'confirmed', createdAt: CURATED_AT, updatedAt: CURATED_AT });
  }
  const sources: Source[] = [];
  for (const src of plan.sources) {
    const text = texts[src.id];
    if (text === undefined) { problems.push(`${src.id}: no approved text at ${path.relative(ROOT, path.join(TEXT_DIR, `${src.id}.md`))}`); continue; }
    const written = Date.parse(src.written);
    sources.push({
      id: src.id, title: src.title, uri: `note://sample/${src.id}`, kind: src.kind as Source['kind'],
      ingestedAt: written, hash: await hashSourceText(text), trustLevel: 'review',
    });
    for (const f of src.facts) {
      const excerpt = excerptFor(text, f.must, f.by);
      if (!excerpt) { problems.push(`${src.id}: no ${f.by ? `message from ${f.by}` : 'line or sentence'} of the text contains ${f.must.map((m) => JSON.stringify(m)).join(' + ')} (fact ${f.fact})`); continue; }
      const st = byKey.get(f.fact) ?? newFact(f.fact, problems, byKey);
      if (!st) continue;
      const status = (f.status ?? 'confirmed') as Statement['status'];
      const at = f.at ? Date.parse(f.at) : undefined;
      byKey.set(f.fact, {
        ...st,
        g: { kind: 'iri', value: `urn:kbase:source/${src.id}` },
        sourceId: src.id, excerpt, grounded: true, status, confidence: status === 'pending' ? 0.8 : 1,
        createdAt: written, updatedAt: at ?? written,
        ...(status !== 'pending' && at ? { settledBy: { actor: f.reviewer ?? src.reviewer, channel: 'review', at } } : {}),
        ...(f.supersedes ? { supersedes: stableId(f.supersedes) } : {}),
      });
    }
  }
  const supersededIds = new Set([...byKey.values()].flatMap((s) => (s.supersedes ? [s.supersedes] : [])));
  for (const id of supersededIds) {
    const old = [...byKey.values()].find((s) => s.id === id);
    if (!old) problems.push(`a fact supersedes ${id}, which is not in the plan`);
    else if (old.status !== 'superseded') problems.push(`${factKey(old)} is replaced by another fact but its status is ${old.status}, not superseded`);
  }
  const statements = [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { statements, sources, problems };
}

/**
 * A planned fact the curated starter does not hold: an old or wrong value the friends replaced or
 * rejected. Only a literal object on a known subject and predicate is allowed, so the plan cannot
 * invent an entity.
 */
function newFact(key: string, problems: string[], byKey: Map<string, Statement>): Statement | undefined {
  const [s, p, ...rest] = key.split('|');
  const o = rest.join('|');
  const sibling = [...byKey.values()].find((st) => termKey(st.s) === s && st.p.value === PRED + p);
  if (!sibling || sibling.o.kind !== 'literal') { problems.push(`${key}: not in the starter, and not a new value of an existing literal fact`); return undefined; }
  return { ...sibling, id: stableId(key), o: { kind: 'literal', value: o } };
}

export function render(r: BuildResult): string {
  const header = [
    'Reckons.AI — Getting started, with its sample sources and their review (F248).',
    'GENERATED by scripts/starter/build-everyday.ts from static/starter-everyday.ttl,',
    'scripts/starter/everyday-plan.json and static/starter/everyday-sources/*.md. Do not edit by hand.',
    'Every source here is a fictional SAMPLE, labelled as one. Alex and Jordan are characters.',
  ].join('\n');
  // The serializer stamps the current time; the file must not change unless its inputs do.
  return toTurtleFull(r.statements, r.sources, { header }).replace(/^# generated .*\n/m, '');
}

async function main(): Promise<void> {
  const plan = readPlan();
  const texts: Record<string, string> = {};
  for (const s of plan.sources) {
    const p = path.join(TEXT_DIR, `${s.id}.md`);
    if (existsSync(p)) texts[s.id] = readFileSync(p, 'utf8');
  }
  const result = await buildReviewed({ starterTtl: readFileSync(STARTER, 'utf8'), plan, texts });
  if (result.problems.length) {
    console.error(`build-everyday: ${result.problems.length} problem(s), nothing written:\n  ${result.problems.join('\n  ')}`);
    process.exit(1);
  }
  const ttl = render(result);
  const counts = result.statements.reduce<Record<string, number>>((c, s) => ({ ...c, [s.status]: (c[s.status] ?? 0) + 1 }), {});
  const summary = `${result.statements.length} statements (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${result.sources.length} sample sources`;
  if (process.argv.includes('--check')) {
    const onDisk = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (onDisk !== ttl) { console.error(`build-everyday --check: ${path.relative(ROOT, OUT)} is stale. Run: npx tsx scripts/starter/build-everyday.ts`); process.exit(1); }
    console.log(`build-everyday --check: up to date — ${summary}`);
    return;
  }
  writeFileSync(OUT, ttl);
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${summary}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-everyday.ts')) void main();
