#!/usr/bin/env npx tsx
/**
 * Visual Test Review Graph generator (F42).
 *
 * Scans the visual-workflow harness output (screenshots/<workflow>/<device>/<step>.png,
 * or <workflow>/<step>.png) and emits a Turtle graph you can load in Reckons.AI
 * to walk every test visually:
 *   - each step  -> a ktype:TestStep node
 *   - screenshot -> urn:kbase:meta/gif data URL (the app's hover-preview slot)
 *   - sequence   -> hnav:order + hnav:next/hnav:prev (camera tour along the chain)
 *   - grouping   -> skos:broader to a per-(workflow,device) ktype:TestWorkflow node
 *
 * The ordered layout + hover previews + story tour are all existing app features
 * (F39 nav ordering, preview assets, story playback) — this just feeds them.
 *
 * Usage:
 *   npx tsx scripts/visual-graph.ts [screenshotsDir] [outFile] [flags]
 *   flags: --no-preview            structure only (no base64) — tiny
 *          --workflow=<name>       only this workflow
 *          --device=<name>         only this device
 *   defaults: tests/visual/screenshots  ->  tests/visual/visual-tests.ttl
 *
 * Embedded previews are the raw screenshots; the full matrix is large (~40 MB),
 * so scope with --workflow/--device (a single device is a couple MB) or use
 * --no-preview. Thumbnailing the previews (to shrink the full graph) would need
 * an image lib — flagged as a follow-up.
 */
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import sharp from 'sharp';

const raw = process.argv.slice(2);
const flag = (name: string) => raw.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const NO_PREVIEW = raw.includes('--no-preview');
const WF = flag('workflow');
const DEV = flag('device');
const THUMB_W = Number(flag('thumb-width') ?? 480);
const pos = raw.filter((a) => !a.startsWith('--'));
const SRC = pos[0] ?? 'tests/visual/screenshots';
const OUT = pos[1] ?? 'tests/visual/visual-tests.ttl';

/** Downscaled PNG data (base64) for a hover preview — keeps the graph light. */
async function thumbB64(file: string): Promise<string> {
  const buf = await sharp(file)
    .resize({ width: THUMB_W, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
  return buf.toString('base64');
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

interface Shot {
  workflow: string;
  device: string; // '' when the workflow has no device subdir
  step: string;
  file: string;
}

/** Recursively collect PNGs and classify by <workflow>/<device?>/<step>. */
function collect(root: string): Shot[] {
  const shots: Shot[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.png')) {
        const rel = path.relative(root, full).split(path.sep);
        const step = rel[rel.length - 1].replace(/\.png$/, '');
        const workflow = rel[0] ?? 'misc';
        const device = rel.length >= 3 ? rel[rel.length - 2] : '';
        shots.push({ workflow, device, step, file: full });
      }
    }
  };
  walk(root);
  return shots;
}

let shots = collect(SRC);
if (WF) shots = shots.filter((s) => s.workflow === WF);
if (DEV) shots = shots.filter((s) => s.device === DEV);
if (shots.length === 0) {
  console.error(`No screenshots under ${SRC}${WF ? ` for workflow "${WF}"` : ''}${DEV ? ` device "${DEV}"` : ''}. Run a workflow first (e.g. navigation-sweep).`);
  process.exit(1);
}

// Group by workflow+device, natural-sort steps within each group.
const groups = new Map<string, Shot[]>();
for (const s of shots) {
  const key = `${s.workflow}${s.device}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
}
for (const list of groups.values()) {
  // Prefer the capture-order manifest (true workflow order); fall back to a
  // natural-sort of filenames when no manifest is present.
  const manifestFile = path.join(path.dirname(list[0].file), '_manifest.jsonl');
  let order: Map<string, number> | null = null;
  if (existsSync(manifestFile)) {
    const steps = readFileSync(manifestFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).step as string;
        } catch {
          return null;
        }
      })
      .filter((s): s is string => !!s);
    order = new Map(steps.map((s, i) => [s, i]));
  }
  const rank = (s: Shot) => order?.get(s.step) ?? Number.MAX_SAFE_INTEGER;
  list.sort((a, b) => rank(a) - rank(b) || a.step.localeCompare(b.step, undefined, { numeric: true }));
}

const lines: string[] = [
  '@prefix kb:    <urn:kbase:concept/> .',
  '@prefix kpred: <urn:kbase:predicate/> .',
  '@prefix kmeta: <urn:kbase:meta/> .',
  '@prefix ktype: <urn:kbase:type/> .',
  '@prefix hnav:  <urn:reckons:nav/> .',
  '@prefix story: <urn:reckons:story/> .',
  '@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .',
  '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .',
  '',
  '# Generated by scripts/visual-graph.ts (F42) — do not hand-edit; regenerate.',
  '',
];

let stepCount = 0;
let storyCount = 0;
for (const [key, list] of groups) {
  const [workflow, device] = key.split('');
  const gid = `kb:vt-${slug(workflow)}${device ? '-' + slug(device) : ''}`;
  const gLabel = device ? `${workflow} · ${device}` : workflow;
  lines.push(`${gid} rdf:type ktype:TestWorkflow ;`);
  lines.push(`    rdfs:label "${esc(gLabel)}" ;`);
  lines.push(`    kpred:device "${esc(device || 'all')}" .`);
  lines.push('');

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const nid = `kb:vt-${slug(workflow)}${device ? '-' + slug(device) : ''}-${slug(s.step)}`;
    const prev = i > 0 ? list[i - 1] : null;
    const next = i < list.length - 1 ? list[i + 1] : null;
    const nidOf = (x: Shot) => `kb:vt-${slug(workflow)}${device ? '-' + slug(device) : ''}-${slug(x.step)}`;
    lines.push(`${nid} rdf:type ktype:TestStep ;`);
    lines.push(`    rdfs:label "${esc(s.step)}" ;`);
    lines.push(`    skos:broader ${gid} ;`);
    lines.push(`    hnav:order "${i}"^^xsd:integer ;`);
    lines.push(`    hnav:layer "2"^^xsd:integer ;`);
    if (prev) lines.push(`    hnav:prev ${nidOf(prev)} ;`);
    if (next) lines.push(`    hnav:next ${nidOf(next)} ;`);
    if (!NO_PREVIEW) {
      lines.push(`    kmeta:gif "data:image/png;base64,${await thumbB64(s.file)}" ;`);
    }
    lines.push(`    kpred:step-of "${esc(gLabel)}" .`);
    lines.push('');
    stepCount++;
  }

  // A story that tours this group's steps in order: each step highlights its
  // screenshot node, so the camera moves to it and the preview shows — the F42
  // automated review progression, playable from the app's explore tab.
  const sid = `story:vt-${slug(workflow)}${device ? '-' + slug(device) : ''}`;
  lines.push(`${sid} rdf:type story:Story ;`);
  lines.push(`    rdfs:label "${esc(gLabel)} — visual review" ;`);
  lines.push(`    story:description "Walk each captured step of ${esc(gLabel)} in order." ;`);
  lines.push(`    story:autoplay "true" ;`);
  lines.push(`    story:pace "6" .`);
  lines.push('');
  list.forEach((s, i) => {
    const nid = `kb:vt-${slug(workflow)}${device ? '-' + slug(device) : ''}-${slug(s.step)}`;
    lines.push(`${sid}-step${i} rdf:type story:Step ;`);
    lines.push(`    story:partOf ${sid} ;`);
    lines.push(`    story:order "${i}"^^xsd:integer ;`);
    lines.push(`    story:title "${esc(s.step)}" ;`);
    lines.push(`    story:content "Step ${i + 1} of ${list.length}: ${esc(s.step)}" ;`);
    lines.push(`    story:highlight ${nid} .`);
    lines.push('');
  });
  storyCount++;
}

writeFileSync(OUT, lines.join('\n'));
const mb = (Buffer.byteLength(lines.join('\n')) / 1e6).toFixed(2);
console.log(
  `Wrote ${OUT} — ${groups.size} workflow/device group(s), ${stepCount} step node(s), ` +
    `${storyCount} tour story(ies)${NO_PREVIEW ? ' (no previews)' : `, ${mb} MB with previews`}.`,
);
console.log('Import it in Reckons.AI (ingest → TTL), then play the "… — visual review" story to walk the tests.');
