/**
 * Bench tasks for the local generation stages, READ FROM THE TESTING GRAPH (F183.2 /
 * kb:gen-bench-in-graph). The ground truth (briefs, seeds, checklists) is data in
 * static/docs-testing.ttl, not code, so the corpus and its measured results are queryable.
 *
 * Shape (urn:reckons:bench/): a bench:BenchTask per stage (bench:stage, bench:seed); bench:Brief
 * children (skos:broader the task, hnav:order, bench:tier smoke|hard); image briefs carry
 * kpred:prompt and bench:ChecklistItem children (skos:broader the brief, hnav:order, skos:notation
 * id, kpred:question); video briefs carry bench:source-brief, kpred:prompt, bench:min-motion;
 * splat briefs carry bench:source-brief, bench:gaussians, bench:depth-to-width-min/max,
 * bench:min-silhouette-iou. A malformed task THROWS with the entity named; nothing is defaulted,
 * because a silently defaulted answer key is a benchmark that grades against nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, type Quad } from 'n3';
import type { Stage } from './gen-assets.js';

export type Tier = 'smoke' | 'hard';
export interface ImageItem { id: string; question: string }
export interface ImageBrief { slug: string; label: string; tier: Tier; prompt: string; checklist: ImageItem[] }
export interface VideoBrief {
  slug: string; label: string; tier: Tier;
  /** The image brief whose first-seed incumbent output is the clip's source frame. */
  sourceImage: string;
  prompt: string;
  /** `minMotion` is the lowest acceptable mean frame-to-frame change (0..1). */
  expects: { minMotion: number; note: string };
}
export interface SplatBrief {
  slug: string; label: string; tier: Tier; sourceImage: string; gaussians: number;
  /** Depth/width is extent along the view axis over extent across it. */
  expects: { depthToWidth: [number, number]; minSilhouetteIoU: number; note: string };
}
export interface BenchTasks { seeds: number[]; image: ImageBrief[]; video: VideoBrief[]; splat: SplatBrief[] }

const B = 'urn:reckons:bench/';
const P = {
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  label: 'http://www.w3.org/2000/01/rdf-schema#label',
  broader: 'http://www.w3.org/2004/02/skos/core#broader',
  notation: 'http://www.w3.org/2004/02/skos/core#notation',
  order: 'urn:reckons:nav/order',
  prompt: 'urn:kbase:predicate/prompt',
  question: 'urn:kbase:predicate/question',
  description: 'urn:kbase:predicate/description',
};

export const TESTING_GRAPH = join(import.meta.dirname, '..', '..', 'static', 'docs-testing.ttl');

export function parseBenchTasks(ttl: string): BenchTasks {
  const quads: Quad[] = new Parser().parse(ttl);
  const by = new Map<string, Map<string, string[]>>();
  for (const q of quads) {
    const s = q.subject.value;
    if (!s.startsWith(B)) continue;
    const m = by.get(s) ?? new Map<string, string[]>();
    const a = m.get(q.predicate.value) ?? [];
    a.push(q.object.value);
    m.set(q.predicate.value, a);
    by.set(s, m);
  }
  const all = (s: string, p: string) => by.get(s)?.get(p) ?? [];
  const one = (s: string, p: string, what: string): string => {
    const v = all(s, p);
    if (v.length !== 1) throw new Error(`bench task ${s}: expected exactly one ${what}, found ${v.length}`);
    if (v[0].trim() === '') throw new Error(`bench task ${s}: ${what} is empty`);
    return v[0];
  };
  const num = (s: string, p: string, what: string): number => {
    const n = Number(one(s, p, what));
    if (!Number.isFinite(n)) throw new Error(`bench task ${s}: ${what} is not a number`);
    return n;
  };
  const ofType = (t: string) => [...by.keys()].filter((s) => all(s, P.type).includes(B + t));
  const children = (parent: string, t: string) => ofType(t)
    .filter((s) => all(s, P.broader).includes(parent))
    .sort((a, b) => num(a, P.order, 'hnav:order') - num(b, P.order, 'hnav:order'));
  const slug = (iri: string, stage: string) => {
    const pre = `${B}${stage}-`;
    if (!iri.startsWith(pre)) throw new Error(`bench brief ${iri}: name must start with bench:${stage}-`);
    return iri.slice(pre.length);
  };
  const tier = (s: string): Tier => {
    const t = one(s, B + 'tier', 'bench:tier');
    if (t !== 'smoke' && t !== 'hard') throw new Error(`bench brief ${s}: bench:tier must be smoke or hard, got "${t}"`);
    return t;
  };
  const sourceOf = (s: string): string => {
    const src = one(s, B + 'source-brief', 'bench:source-brief');
    if (!src.startsWith(`${B}image-`) || !by.has(src)) throw new Error(`bench brief ${s}: bench:source-brief ${src} is not an image brief in the graph`);
    return src.slice(`${B}image-`.length);
  };

  const tasks = ofType('BenchTask');
  const taskOf = (stage: Stage): string => {
    const t = tasks.filter((x) => all(x, B + 'stage')[0] === stage);
    if (t.length !== 1) throw new Error(`bench: expected exactly one BenchTask for stage "${stage}", found ${t.length}`);
    return t[0];
  };

  const seedSets = (['image', 'video', 'splat'] as Stage[]).map((st) => all(taskOf(st), B + 'seed').map(Number));
  const seeds = seedSets[0];
  if (!seeds.length || seeds.some((n) => !Number.isInteger(n))) throw new Error('bench: the image task needs integer bench:seed values');
  if (new Set(seeds).size !== seeds.length) throw new Error('bench: bench:seed values must be distinct');
  for (const st of seedSets) if (st.join() !== seeds.join()) throw new Error('bench: every stage must carry the same seeds, in the same order');

  const image = children(taskOf('image'), 'Brief').map((s): ImageBrief => {
    const items = children(s, 'ChecklistItem').map((it) => ({ id: one(it, P.notation, 'skos:notation'), question: one(it, P.question, 'kpred:question') }));
    if (items.length < 4) throw new Error(`bench brief ${s}: needs at least 4 checklist items, found ${items.length}`);
    if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error(`bench brief ${s}: checklist ids must be distinct`);
    return { slug: slug(s, 'image'), label: one(s, P.label, 'rdfs:label'), tier: tier(s), prompt: one(s, P.prompt, 'kpred:prompt'), checklist: items };
  });
  const video = children(taskOf('video'), 'Brief').map((s): VideoBrief => ({
    slug: slug(s, 'video'), label: one(s, P.label, 'rdfs:label'), tier: tier(s), sourceImage: sourceOf(s), prompt: one(s, P.prompt, 'kpred:prompt'),
    expects: { minMotion: num(s, B + 'min-motion', 'bench:min-motion'), note: one(s, P.description, 'kpred:description') },
  }));
  const splat = children(taskOf('splat'), 'Brief').map((s): SplatBrief => {
    const lo = num(s, B + 'depth-to-width-min', 'bench:depth-to-width-min');
    const hi = num(s, B + 'depth-to-width-max', 'bench:depth-to-width-max');
    if (!(lo >= 0 && hi > lo)) throw new Error(`bench brief ${s}: depth-to-width range must satisfy 0 <= min < max`);
    return {
      slug: slug(s, 'splat'), label: one(s, P.label, 'rdfs:label'), tier: tier(s), sourceImage: sourceOf(s), gaussians: num(s, B + 'gaussians', 'bench:gaussians'),
      expects: { depthToWidth: [lo, hi], minSilhouetteIoU: num(s, B + 'min-silhouette-iou', 'bench:min-silhouette-iou'), note: one(s, P.description, 'kpred:description') },
    };
  });
  if (!image.length || !video.length || !splat.length) throw new Error('bench: every stage needs at least one brief');
  const slugs = new Set(image.map((b) => b.slug));
  for (const b of [...video, ...splat]) if (!slugs.has(b.sourceImage)) throw new Error(`bench brief ${b.slug}: source image "${b.sourceImage}" has no image brief`);
  return { seeds, image, video, splat };
}

export function loadBenchTasks(file = TESTING_GRAPH): BenchTasks {
  return parseBenchTasks(readFileSync(file, 'utf8'));
}

/** Briefs of one stage, optionally narrowed to a tier ('all' keeps both). */
export function briefsFor<S extends Stage>(tasks: BenchTasks, stage: S, tier: Tier | 'all' = 'all') {
  const list = stage === 'image' ? tasks.image : stage === 'video' ? tasks.video : tasks.splat;
  return (tier === 'all' ? list : list.filter((b) => b.tier === tier)) as (S extends 'image' ? ImageBrief[] : S extends 'video' ? VideoBrief[] : SplatBrief[]);
}
