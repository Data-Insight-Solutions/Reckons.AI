#!/usr/bin/env npx tsx
/**
 * LANDING DATA vs THE GRAPH (SCRIPT tier) — two sources of truth, one of them redundant.
 *
 * Matt, 2026-08-14, on finding markdown and JSON around the repo: "lets make sure that is
 * required and not definable within .ttl".
 *
 * MEASURED ANSWER for src/lib/data/landing-thesis.json: it is not merely definable in TTL, it
 * already IS. The seven thesis statements exist as ktype:Tenet entities carrying
 * pred:tenet-body, and the graph even models WHICH of them belong on the landing page with
 * pred:show-on-landing. Compared on 2026-08-14, headline and body were identical 7 of 7 — so
 * the JSON is a duplicate that has not drifted YET, with nothing to stop it.
 *
 * The honest fix is to GENERATE the JSON from the graph the way content/*.md already is
 * (scripts/docs-pages.ts), leaving one source. That is a build change and it is recorded as
 * the follow-up. This check is the cheap protection in the meantime: it costs nothing, and it
 * turns "these could drift" into "these cannot drift unnoticed".
 *
 * landing-roadmap.json is deliberately NOT compared item-for-item. It is an editorial
 * SELECTION for a landing page — eight items chosen and re-worded for a first-time reader —
 * not a projection of the roadmap's 164 features. Demanding it match would be demanding the
 * marketing copy be the changelog. What IS checked is that every status it claims is a real
 * lifecycle value, so it cannot advertise a state the graph does not have.
 *
 * Usage: npx tsx scripts/offline/landing-data-align.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';

const ROOT = new URL('../..', import.meta.url).pathname;
const THESIS = join(ROOT, 'src/lib/data/landing-thesis.json');
const ROADMAP_JSON = join(ROOT, 'src/lib/data/landing-roadmap.json');

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const problems: string[] = [];
let checked = 0;

// Read every project graph, not just the roadmap. A SHIPPED feature is moved out of the
// roadmap into reckons-shipped.ttl, so looking only at the roadmap reports "(none)" for
// precisely the items the landing page is right to call done — the check would then flag the
// honest claims and miss the dishonest ones.
const GRAPHS = ['static/reckons-roadmap.ttl', 'static/reckons-shipped.ttl', 'static/reckons-production.ttl']
  .map((g) => join(ROOT, g))
  .filter((g) => existsSync(g));
const quads = GRAPHS.flatMap((g) => new Parser().parse(readFileSync(g, 'utf8')));
const label = new Map<string, string>();
const body = new Map<string, string>();
const statuses = new Set<string>();
for (const q of quads) {
  const p = q.predicate.value;
  if (p.endsWith('rdf-schema#label')) label.set(q.subject.value, q.object.value);
  else if (p.endsWith('tenet-body')) body.set(q.subject.value, q.object.value);
  else if (p.endsWith('has-status')) statuses.add(q.object.value);
}

// ── Thesis: must match the graph exactly ─────────────────────────────────────

if (existsSync(THESIS)) {
  const json = JSON.parse(readFileSync(THESIS, 'utf8')) as Array<{ headline: string; body: string }>;
  const tenets = [...body.entries()].map(([iri, b]) => ({ headline: label.get(iri) ?? '', body: b }));
  for (const item of json) {
    checked++;
    const match = tenets.find((t) => norm(t.headline) === norm(item.headline));
    if (!match) {
      problems.push(`thesis: "${norm(item.headline).slice(0, 60)}" is in the JSON and NOT in the graph`);
    } else if (norm(match.body) !== norm(item.body)) {
      problems.push(`thesis: body differs from the graph for "${norm(item.headline).slice(0, 50)}"`);
    }
  }
  for (const t of tenets) {
    if (!json.some((j) => norm(j.headline) === norm(t.headline))) {
      // Not a failure: the graph may hold tenets the landing page does not show. Reported so
      // a deliberately-hidden tenet is a visible choice rather than an oversight.
      problems.push(`\x1b[2mthesis: graph tenet not on the landing page — "${norm(t.headline).slice(0, 50)}"\x1b[0m`);
    }
  }
}

// ── Roadmap: the DISPLAY status must not outrun the graph ────────────────────
//
// The landing page speaks a display vocabulary — done / building / planned — which is NOT the
// lifecycle. An early version of this check demanded lifecycle words and flagged "building" as
// invalid; it is the correct word for in-progress, and the check was wrong, not the copy.
//
// What matters is that the page cannot advertise more than the graph supports: "done" requires
// functional or production. An item with no kpred:landing-label cannot be checked at all, and
// that is reported as UNVERIFIABLE rather than passed, because an unlinked claim on a public
// page is exactly the thing that drifts unnoticed.

if (existsSync(ROADMAP_JSON)) {
  const json = JSON.parse(readFileSync(ROADMAP_JSON, 'utf8')) as Array<{ status: string; label: string }>;
  const landingLabel = new Map<string, string>();
  const statusOf = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value.endsWith('landing-label')) landingLabel.set(q.object.value, q.subject.value);
    else if (q.predicate.value.endsWith('has-status')) statusOf.set(q.subject.value, q.object.value);
  }
  /** What the graph must say for a given display word to be honest. */
  const SUPPORTS: Record<string, string[]> = {
    done: ['functional', 'production'],
    building: ['in-progress', 'scaffolded'],
    planned: ['planned', 'speculative'],
  };
  for (const item of json) {
    checked++;
    const iri = landingLabel.get(item.label);
    if (!iri) {
      problems.push(`roadmap: "${item.label}" claims "${item.status}" and has NO kpred:landing-label, so nothing can verify it`);
      continue;
    }
    const graphStatus = statusOf.get(iri) ?? '(none)';
    const allowed = SUPPORTS[item.status];
    if (!allowed) {
      problems.push(`roadmap: "${item.label}" uses display status "${item.status}", which has no defined mapping`);
    } else if (!allowed.includes(graphStatus)) {
      problems.push(
        `roadmap: "${item.label}" advertises "${item.status}" but the graph says "${graphStatus}" — the page is ahead of the work`,
      );
    }
  }
}

console.log(`\x1b[1mlanding data vs graph\x1b[0m \x1b[2m— ${checked} item(s) checked\x1b[0m\n`);

const hard = problems.filter((p) => !p.includes('\x1b[2m'));
if (problems.length === 0) {
  console.log('\x1b[32mAligned\x1b[0m — the landing thesis matches the graph exactly, and every advertised status is real.');
} else {
  for (const p of problems) console.log(`  ${p}`);
}

console.log(
  '\n\x1b[2mlanding-thesis.json duplicates ktype:Tenet/pred:tenet-body and should eventually be\n' +
    'GENERATED from the graph, as content/*.md already is. landing-roadmap.json is editorial\n' +
    'selection, so only its statuses are checked — matching it to the graph would be demanding\n' +
    'the marketing copy be the changelog.\x1b[0m',
);

process.exit(hard.length > 0 ? 1 : 0);
