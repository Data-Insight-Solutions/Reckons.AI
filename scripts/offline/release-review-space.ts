#!/usr/bin/env npx tsx
/**
 * Release review space (F34.5, SCRIPT tier) — one generated starter space per release, whose nodes
 * are that release's main workflows as visual tests for a person to review by hand.
 * No model, no browser, zero tokens, deterministic: the same inputs give the same bytes, so
 * `--check` can fail a stale file the way md-align does.
 *
 * WHAT GOES IN
 *   - the release (ktype:Release, kpred:version) and its kpred:has-part features in the roadmap.
 *     Features marked kpred:headline come first, then the rest in the order the roadmap lists them.
 *   - the TestWorkflow entities in static/docs-testing.ttl (read by scripts/lib/test-workflow.ts).
 *
 * THE JOIN. A feature has a visual test when a TestWorkflow's kpred:test-file is one of the files
 * the feature (or a phase that is part-of it, at any depth) lists under kpred:tested-by. That is
 * data the graphs already carry; this script invents no link. A feature with no such workflow is
 * NOT dropped: it goes under one node, "No visual test yet", so the gap is on the canvas.
 *
 * WHAT COMES OUT (static/review-<version>.ttl)
 *   release (root) -> one node per workflow, in story order (hnav) -> one node per step, carrying
 *   the step text, the screenshot (p:photo), what the test checks, and a kmeta:review-verdict that
 *   starts as "unreviewed" and that the person sets from the node panel (pass / fail / note).
 *
 * Usage:
 *   npx tsx scripts/offline/release-review-space.ts                  # regenerate every static/review-*.ttl
 *   npx tsx scripts/offline/release-review-space.ts --release=0.2.7  # one release (writes it, even if new)
 *   npx tsx scripts/offline/release-review-space.ts --check          # fail when a generated file is stale
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Parser } from 'n3';
import type { Quad } from '@rdfjs/types';
import { ROOT, loadWorkflows, parseTtl, type Workflow } from '../lib/test-workflow.js';

const KPRED = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RELEASE_TYPE = 'urn:kbase:type/Release';

export const GAP_LABEL = 'No visual test yet';
export const VERDICT_UNSET = 'unreviewed';

export function reviewFileName(version: string): string {
  return `review-${version}.ttl`;
}

interface Feature {
  iri: string;
  label: string;
  featureId: string;
  status: string;
  headline: boolean;
  /** Every kpred:tested-by path on the feature and on everything part-of it. */
  tests: Set<string>;
}

export interface ReviewStats {
  version: string;
  parts: number;
  workflows: number;
  steps: number;
  gaps: number;
}

/** A Turtle string literal. Escapes the four characters that cannot appear raw. */
function lit(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** Index the roadmap: objects by (subject, predicate) in file order, so story order is stable. */
function index(quads: Quad[]) {
  const objs = new Map<string, string[]>();
  const subjects = new Map<string, Quad[]>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const k = q.subject.value + '\u0000' + q.predicate.value;
    const arr = objs.get(k) ?? [];
    if (!arr.includes(q.object.value)) arr.push(q.object.value);
    objs.set(k, arr);
    const sq = subjects.get(q.subject.value) ?? [];
    sq.push(q);
    subjects.set(q.subject.value, sq);
  }
  const all = (s: string, p: string) => objs.get(s + '\u0000' + p) ?? [];
  const one = (s: string, p: string) => all(s, p)[0] ?? '';
  return { all, one, subjects };
}

/**
 * Build the review space for one release as Turtle text, plus the numbers the root node quotes.
 * Pure: roadmap quads and workflows in, text out, so a test runs it on a synthetic fixture.
 */
export function buildReview(roadmap: Quad[], workflows: Workflow[], version: string): { ttl: string; stats: ReviewStats } {
  const { all, one, subjects } = index(roadmap);
  const releases = [...subjects.keys()].filter((s) =>
    all(s, RDF_TYPE).includes(RELEASE_TYPE) && one(s, KPRED + 'version') === version);
  if (releases.length !== 1) throw new Error(`expected exactly one ktype:Release with kpred:version "${version}", found ${releases.length}`);
  const release = releases[0];

  const children = new Map<string, string[]>();
  for (const s of subjects.keys()) {
    for (const parent of all(s, KPRED + 'part-of')) {
      const arr = children.get(parent) ?? [];
      arr.push(s);
      children.set(parent, arr);
    }
  }
  const testsOf = (iri: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(iri)) return out;
    seen.add(iri);
    for (const t of all(iri, KPRED + 'tested-by')) out.add(t);
    for (const c of children.get(iri) ?? []) for (const t of testsOf(c, seen)) out.add(t);
    return out;
  };

  const headlineSet = new Set(all(release, KPRED + 'headline'));
  const partIris = all(release, KPRED + 'has-part');
  const ordered = [...partIris.filter((p) => headlineSet.has(p)), ...partIris.filter((p) => !headlineSet.has(p))];
  const features: Feature[] = ordered.map((iri) => ({
    iri,
    label: one(iri, RDFS_LABEL) || iri,
    featureId: one(iri, KPRED + 'feature-id'),
    status: one(iri, KPRED + 'has-status') || 'unknown',
    headline: headlineSet.has(iri),
    tests: testsOf(iri),
  }));

  // Story order: a workflow appears once, at the first feature that reaches it.
  const placed = new Map<string, { workflow: Workflow; feature: Feature; also: Feature[] }>();
  const gaps: Feature[] = [];
  for (const f of features) {
    const hits = workflows.filter((w) => f.tests.has(w.testFile));
    if (!hits.length) { gaps.push(f); continue; }
    for (const w of hits) {
      const seen = placed.get(w.iri);
      if (seen) { if (!seen.also.includes(f)) seen.also.push(f); }
      else placed.set(w.iri, { workflow: w, feature: f, also: [] });
    }
  }
  const stories = [...placed.values()];

  const R = (rest: string) => `rev:${rest}`;
  const rootId = R('release');
  const gapId = R('gap');
  const L: string[] = [];
  const featureName = (f: Feature) => `${f.featureId ? f.featureId + ' ' : ''}${f.label}`;
  const stepCount = stories.reduce((n, s) => n + s.workflow.steps.length, 0);

  const rootComment =
    `The visual tests of v${version}, in the order a person would review them. ` +
    `${stories.length} of this release's ${features.length} parts have a TestWorkflow (${stepCount} steps, each a screenshot and what the test checks); ` +
    `${gaps.length} do not yet, and are listed under "${GAP_LABEL}" so the gap stays visible. ` +
    `Select a step, look at its picture, and set pass, fail or a note in the node panel. ` +
    `Generated from the roadmap and the Testing graph by scripts/offline/release-review-space.ts; edit those, not this file. ` +
    `Release status when generated: ${one(release, KPRED + 'has-status') || 'unknown'}.`;

  L.push(
    `## Reckons.AI — Review v${version}`,
    '## GENERATED by scripts/offline/release-review-space.ts (F34.5). Do not edit by hand: change the roadmap or',
    '## the Testing graph and run `npx tsx scripts/offline/release-review-space.ts`. `--check` fails when stale.',
    '',
    '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix ktype: <urn:kbase:type/> .',
    '@prefix p:     <urn:kbase:predicate/> .',
    '@prefix kmeta: <urn:kbase:meta/> .',
    '@prefix hnav:  <urn:reckons:nav/> .',
    `@prefix rev:   <urn:reckons:review/${version}/> .`,
    '',
    `${rootId} rdf:type ktype:Concept ;`,
    `    rdfs:label ${lit(`Review v${version}`)} ;`,
    `    rdfs:comment ${lit(rootComment)} ;`,
    `    hnav:order "0"^^xsd:integer ;`,
  );
  const topIds = [...stories.map((s) => R(`wf-${slug(s.workflow.id)}`)), ...(gaps.length ? [gapId] : [])];
  L.push(topIds.length ? `    hnav:layer "0"^^xsd:integer ;` : '', topIds.length ? `    p:has ${topIds.join(', ')} .` : `    hnav:layer "0"^^xsd:integer .`);
  L.push('');

  topIds.forEach((id, i) => {
    const story = stories[i];
    const prev = i > 0 ? topIds[i - 1] : null;
    const next = i < topIds.length - 1 ? topIds[i + 1] : null;
    const nav = [`    hnav:order "${i + 1}"^^xsd:integer`, `    hnav:layer "1"^^xsd:integer`];
    if (next) nav.push(`    hnav:next ${next}`);
    if (prev) nav.push(`    hnav:prev ${prev}`);
    if (story) {
      const w = story.workflow;
      const f = story.feature;
      const stepIds = w.steps.map((s) => R(`wf-${slug(w.id)}-${String(s.order).padStart(2, '0')}-${slug(s.id)}`));
      const also = story.also.length ? ` Also covers: ${story.also.map(featureName).join('; ')}.` : '';
      const comment =
        `${f.headline ? 'Headline part' : 'Part'} of v${version}: ${featureName(f)} (status: ${f.status}). ` +
        `${w.definition ? w.definition.split(/\n\s*\n/)[0].trim() + ' ' : ''}` +
        `Run by ${w.testFile}.${also}`;
      L.push(
        `${id} rdf:type ktype:Concept ;`,
        `    rdfs:label ${lit(`${i + 1}. ${w.title}`)} ;`,
        `    rdfs:comment ${lit(comment)} ;`,
        ...nav.map((n) => n + ' ;'),
        `    p:has ${stepIds.join(', ')} .`,
        '',
      );
      w.steps.forEach((s, j) => {
        const sid = stepIds[j];
        const snav = [`    hnav:order "${s.order}"^^xsd:integer`, `    hnav:layer "2"^^xsd:integer`];
        if (j < stepIds.length - 1) snav.push(`    hnav:next ${stepIds[j + 1]}`);
        if (j > 0) snav.push(`    hnav:prev ${stepIds[j - 1]}`);
        const text =
          `${s.text}\n\nWhere: ${s.pageName} (${s.page}).\n\nThe test checks: ${s.assertion}` +
          (s.screenshot ? '' : '\n\nNo screenshot has been captured for this step yet.');
        L.push(
          `${sid} rdf:type ktype:Concept ;`,
          `    rdfs:label ${lit(`${s.order}. ${s.title}`)} ;`,
          `    rdfs:comment ${lit(text)} ;`,
          ...(s.screenshot ? [`    p:photo ${lit(s.screenshot)} ;`] : []),
          ...snav.map((n) => n + ' ;'),
          `    kmeta:review-verdict ${lit(VERDICT_UNSET)} .`,
          '',
        );
      });
    } else {
      const itemIds = gaps.map((g) => R(`gap-${slug(g.featureId || g.label)}`));
      L.push(
        `${gapId} rdf:type ktype:Concept ;`,
        `    rdfs:label ${lit(GAP_LABEL)} ;`,
        `    rdfs:comment ${lit(`${gaps.length} part(s) of v${version} that no TestWorkflow lists a test file for. They are listed here so the gap stays visible: review them some other way, or write the workflow.`)} ;`,
        ...nav.map((n) => n + ' ;'),
        `    p:has ${itemIds.join(', ')} .`,
        '',
      );
      gaps.forEach((g, j) => {
        L.push(
          `${itemIds[j]} rdf:type ktype:Concept ;`,
          `    rdfs:label ${lit(featureName(g))} ;`,
          `    rdfs:comment ${lit(`Status in the roadmap: ${g.status}. ${GAP_LABEL}: no TestWorkflow runs a test this part lists under kpred:tested-by${g.tests.size ? ` (it lists ${[...g.tests].join(', ')})` : ' (it lists none)'}.`)} .`,
          '',
        );
      });
    }
  });

  return {
    ttl: L.join('\n') + '\n',
    stats: { version, parts: features.length, workflows: stories.length, steps: stepCount, gaps: gaps.length },
  };
}

/** Parse check: the file we emit must be valid Turtle. */
export function assertParses(ttl: string): void {
  new Parser().parse(ttl);
}

const ROADMAP = join(ROOT, 'static', 'reckons-roadmap.ttl');
const TESTING = join(ROOT, 'static', 'docs-testing.ttl');

export function generate(version: string, roadmapFile = ROADMAP, testingFile = TESTING) {
  const out = buildReview(parseTtl(roadmapFile), loadWorkflows(parseTtl(testingFile)), version);
  assertParses(out.ttl);
  return out;
}

function existingVersions(): string[] {
  return readdirSync(join(ROOT, 'static'))
    .map((f) => /^review-(\d+\.\d+\.\d+)\.ttl$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const explicit = args.find((a) => a.startsWith('--release='))?.slice('--release='.length).split(',').filter(Boolean);
  const versions = explicit ?? existingVersions();
  if (!versions.length) { console.log('No static/review-*.ttl files and no --release given: nothing to do.'); return; }

  let stale = 0;
  for (const v of versions) {
    const { ttl, stats } = generate(v);
    const file = join(ROOT, 'static', reviewFileName(v));
    const summary = `v${v}: ${stats.workflows} workflow(s), ${stats.steps} step(s), ${stats.gaps} part(s) with no visual test yet, of ${stats.parts}`;
    if (check) {
      const have = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (have !== ttl) {
        stale++;
        console.log(`STALE ${reviewFileName(v)} (${have === null ? 'missing' : 'differs from what the roadmap and Testing graph generate'}). Run: npx tsx scripts/offline/release-review-space.ts --release=${v}`);
      } else console.log(`ok    ${reviewFileName(v)} — ${summary}`);
    } else {
      writeFileSync(file, ttl);
      console.log(`wrote static/${reviewFileName(v)} — ${summary}`);
    }
  }
  process.exit(stale ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
