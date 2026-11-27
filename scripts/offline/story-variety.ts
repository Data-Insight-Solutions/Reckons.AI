#!/usr/bin/env npx tsx
/**
 * STORY VARIETY (F300.6, kb:story-variety; SCRIPT tier: deterministic, zero tokens).
 *
 * WHY IT EXISTS. Matt, 2026-11-24: "Make sure all stories use different filters and features."
 * A guided story is a VIEW of a space: the filters it turns on, the layout it asks for, the
 * highlights it points at, the offers it makes, the leaps its highlighted entities carry, the
 * media its steps play. Two stories that differ only in the words they say while showing the
 * same view are not two walks — they are one walk narrated twice. This check makes the mix a
 * thing a script can see, so "give every story its own mix" (roadmap F300.6) stops being a
 * mood and becomes a state of the files.
 *
 * WHAT IT CHECKS, for every story in the bundled example spaces (the files EXAMPLE_KBS in
 * src/lib/storage/example-kbs.ts points at, plus static/starter-*.ttl; the review-0.2.x release
 * spaces stay out, F263):
 *   1. the story uses story:filter on at least one step — a story with no filter never says
 *      what view of the space it is;
 *   2. no two stories use the same feature set. A feature set is the story's kinds of feature
 *      (filter, layout, highlight, offer, leap, media) together with the filter names and
 *      layout names it names. Highlight IRIs, offer values and media paths are NOT in the set:
 *      they differ by construction (each space highlights its own entities), and counting them
 *      would let the check pass while every story still shows the same view.
 *
 * A story "uses a leap" when a step highlights an entity of the SAME file that carries
 * urn:reckons:leap — the one place a story can say "go on to another place" without a route.
 *
 * READS WITH THE REPO'S OWN STORY READER (F300.1, src/lib/rdf/story-steps.ts): no regexes over
 * the TTL. It parses each file with n3, hands the quads to readStoryQuads, and works from the
 * UnifiedStory it returns.
 *
 * THE SAME STORY IN TWO FILES COUNTS ONCE: the Getting started story is curated in
 * static/starter-everyday.ttl and re-serialized into its generated reviewed copy, and both are
 * bundled. First file in scope order wins; the curated file and its copy carry the same mix.
 *
 * NOT BLOCKING YET (kpred:job-blocking "false"): it currently fails by design — the bundled
 * stories predate it and most of them use no filter at all. F292.4 and the F300.6 work give
 * every story its own mix; when the table is clean, the job graduates to blocking the way the
 * other example checks did.
 *
 * Usage:
 *   npx tsx scripts/offline/story-variety.ts          per-story table to stdout
 *   npx tsx scripts/offline/story-variety.ts --json   machine-readable
 * Exit: 0 when every story has a filter and no two share a feature set; 1 otherwise.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Parser } from 'n3';
import { EXAMPLE_KBS } from '../../src/lib/storage/example-kbs';
import { readStoryQuads, type QuadLike, type UnifiedStory } from '../../src/lib/rdf/story-steps';

const ROOT = new URL('../..', import.meta.url).pathname;

/** The predicate that makes an entity a leap (src/lib: KB Leap / switchToKb by stable id or link). */
export const LEAP = 'urn:reckons:leap';

/** The feature kinds a story can use, in the order the table prints them. */
export const KINDS = ['filter', 'layout', 'highlight', 'offer', 'leap', 'media'] as const;
export type Kind = (typeof KINDS)[number];

export interface StoryFeatures {
  /** story:filter names, unioned over the steps, sorted. */
  filters: string[];
  /** story:layout names, unioned over the steps, sorted. */
  layouts: string[];
  /** distinct story:highlight IRIs across the steps. */
  highlights: number;
  /** story:offerSetting + story:openPage across the steps. */
  offers: number;
  /** highlighted entities that carry urn:reckons:leap in the same file. */
  leaps: number;
  /** steps that carry story:media. */
  media: number;
  /** which of KINDS are non-empty, sorted — the story's "feature set" kind line. */
  kinds: Kind[];
}

export interface StoryRow {
  iri: string;
  label: string;
  /** repo-relative static/ file the story was read from. */
  file: string;
  steps: number;
  features: StoryFeatures;
}

/** One story's feature mix, straight off the UnifiedStory the one reader returns. */
export function storyFeatures(story: UnifiedStory, leapEntities: ReadonlySet<string> = new Set()): StoryFeatures {
  const filters = new Set<string>();
  const layouts = new Set<string>();
  const highlights = new Set<string>();
  let offers = 0;
  let leaps = 0;
  let media = 0;
  for (const s of story.steps) {
    for (const f of s.filters ?? []) filters.add(f);
    if (s.layout) layouts.add(s.layout);
    for (const h of s.highlights) {
      highlights.add(h);
      if (leapEntities.has(h)) leaps++;
    }
    offers += s.offers.length;
    if (s.media) media++;
  }
  const kinds: Kind[] = [
    ...(filters.size ? ['filter' as Kind] : []),
    ...(layouts.size ? ['layout' as Kind] : []),
    ...(highlights.size ? ['highlight' as Kind] : []),
    ...(offers ? ['offer' as Kind] : []),
    ...(leaps ? ['leap' as Kind] : []),
    ...(media ? ['media' as Kind] : []),
  ];
  return { filters: [...filters].sort(), layouts: [...layouts].sort(), highlights: highlights.size, offers, leaps, media, kinds };
}

/**
 * THE FEATURE SET, as an identity string. Kinds plus the filter and layout names: enough to tell
 * "the hubs view with a picture" from "the islands view with a picture", not so much that two
 * walks of the same space could never coincide. Deliberately NOT the highlight IRIs, offer
 * values or media paths — see the file header.
 */
export function featureSet(f: StoryFeatures): string {
  return JSON.stringify({ filters: f.filters, layouts: f.layouts, kinds: f.kinds });
}

/** The two failure rules. Returns one line per problem, empty when the table is clean. */
export function checkRows(rows: StoryRow[]): string[] {
  const failures: string[] = [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (r.features.filters.length === 0) {
      failures.push(`${r.iri} (${r.file}): no story:filter on any step — the story never says which view of the space it is`);
    }
    const key = featureSet(r.features);
    const twin = seen.get(key);
    if (twin) failures.push(`${r.iri} (${r.file}) shares its feature set with ${twin}`);
    else seen.set(key, `${r.iri} (${r.file})`);
  }
  return failures;
}

/**
 * Read every story in the given files, deduped by story IRI (first file in this list wins),
 * with per-file leap detection. `quads` must be an array (n3's parse output); a one-shot
 * generator would be consumed twice here.
 */
export function rowsFromQuads(entries: { file: string; quads: QuadLike[] }[]): StoryRow[] {
  const rows: StoryRow[] = [];
  const byIri = new Map<string, StoryRow>();
  for (const e of entries) {
    const leapEntities = new Set(
      e.quads.filter((q) => q.predicate.value === LEAP && q.subject.termType === 'NamedNode').map((q) => q.subject.value)
    );
    for (const st of readStoryQuads(e.quads)) {
      if (st.origin !== 'story') continue; // legacy ktype:TestWorkflow is a test, not a player story
      if (byIri.has(st.iri)) continue; // curated file and its generated copy: one story
      const row: StoryRow = { iri: st.iri, label: st.label, file: e.file, steps: st.steps.length, features: storyFeatures(st, leapEntities) };
      byIri.set(st.iri, row);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The files in scope, in priority order: what EXAMPLE_KBS opens first (a generated copy there
 * outranks the file it was serialized from), then every other static/starter-*.ttl. review-0.2.x
 * release spaces are out (F263: their home is the workspace), and they carry no story:Story.
 */
export function scopeFiles(staticDir: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (f: string) => { const n = f.replace(/^\//, ''); if (!seen.has(n)) { seen.add(n); files.push(n); } };
  for (const e of EXAMPLE_KBS) {
    if (/^review-/.test(e.id)) continue;
    add(e.file);
  }
  let names: string[] = [];
  try { names = readdirSync(staticDir); } catch { /* test with a missing dir: just the EXAMPLE_KBS files */ }
  for (const n of [...names].sort()) if (/^starter.*\.ttl$/.test(n)) add(n);
  return files;
}

function table(rows: StoryRow[]): string {
  const head = ['story', 'file', 'steps', 'filters', 'layouts', 'high', 'offers', 'leaps', 'media', 'kinds'];
  const body = rows.map((r) => [
    r.iri.split('/').pop() ?? r.iri, r.file, String(r.steps),
    r.features.filters.join(',') || '—', r.features.layouts.join(',') || '—',
    String(r.features.highlights), String(r.features.offers), String(r.features.leaps), String(r.features.media),
    r.features.kinds.join('+') || '—',
  ]);
  const all = [head, ...body];
  const w = head.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (r: string[]) => r.map((v, c) => v.padEnd(w[c])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

if (process.argv[1]?.endsWith('story-variety.ts')) {
  const staticDir = path.join(ROOT, 'static');
  const entries: { file: string; quads: QuadLike[] }[] = [];
  for (const f of scopeFiles(staticDir)) {
    const full = path.join(staticDir, f);
    if (!existsSync(full)) continue;
    const quads = new Parser().parse(readFileSync(full, 'utf8'));
    if (quads.length) entries.push({ file: f, quads });
  }
  const rows = rowsFromQuads(entries);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ stories: rows, failures: checkRows(rows) }, null, 2));
  } else {
    console.log(table(rows));
    const failures = checkRows(rows);
    console.log(`\n${rows.length} story(ies) across ${entries.length} file(s).`);
    if (failures.length) {
      console.log('FAIL:');
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log('OK: every story names a filter and no two share a feature set.');
  }
}
