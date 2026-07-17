#!/usr/bin/env npx tsx
/**
 * Capture an idea (F89 / kb:loop-idea-inbox) — the WIP surface.
 *
 * Matt has ideas in waves and wants to let them flow: jot it, keep moving, let the
 * orchestrator ask for detail later. The one rule that makes this work:
 *
 *   CAPTURE MUST COST NOTHING, OR IT WILL NOT HAPPEN.
 *
 * No required type, no parent, no status ceremony. One line in, and it lands in the ideas
 * graph as a speculative entity with verifiable-by `user` — because a raw idea is attested,
 * not verified, and the graph must never launder one into the other. The orchestrator triages
 * it later; where it cannot proceed it emits a partial fact (object '?') naming exactly what
 * it needs, rather than making Matt fill in a form at the moment of the thought.
 *
 * This is also THE DESIGNATED REVIEW SURFACE. reckons-workspace/ideas.ttl is a real graph:
 * import it into Reckons.AI and review it like any other, or read it here. New ideas, and the
 * orchestrator's drafts, accumulate in it so Matt reviews ONE place occasionally instead of
 * being interrupted.
 *
 * Usage:
 *   npm run idea -- "let sub-agents negotiate merge conflicts before surfacing them"
 *   npm run idea -- --list
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { Parser } from 'n3';

const IDEAS = 'reckons-workspace/ideas.ttl';
const NS = 'urn:reckons:idea/';
const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', X = '\x1b[0m';
const argv = process.argv.slice(2);

function slug(text: string): string {
  return (
    'i' +
    text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) +
    '-' +
    Date.now().toString(36).slice(-4)
  );
}

function ensureHeader() {
  if (existsSync(IDEAS)) return;
  mkdirSync(path.dirname(IDEAS), { recursive: true });
  writeFileSync(
    IDEAS,
    `@prefix kpred: <${KPRED}> .\n@prefix ktype: <${KTYPE}> .\n@prefix idea: <${NS}> .\n` +
      `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\n` +
      `# Ideas — the WIP capture surface (F89 / kb:loop-idea-inbox).\n` +
      `# Jot with: npm run idea -- "…". Zero friction on purpose. The orchestrator triages these;\n` +
      `# it asks for detail via partial facts rather than demanding a form at the moment of the idea.\n` +
      `# A real graph: import it into Reckons.AI to review, or read it here.\n\n`,
  );
}

if (argv.includes('--list') || argv.length === 0) {
  if (!existsSync(IDEAS)) {
    console.log('No ideas yet. Jot one: npm run idea -- "your idea"');
    process.exit(0);
  }
  const quads = new Parser().parse(readFileSync(IDEAS, 'utf8'));
  const ideas = quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${KTYPE}Idea`).map((q) => q.subject.value);
  console.log(`${B}Ideas${X} ${D}(${ideas.length}) — reckons-workspace/ideas.ttl${X}\n`);
  for (const iri of ideas) {
    const label = quads.find((q) => q.subject.value === iri && q.predicate.value.endsWith('#label'))?.object.value;
    const at = quads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}captured-at`)?.object.value ?? '';
    console.log(`  ${D}${at.slice(0, 10)}${X}  ${label}`);
  }
  process.exit(0);
}

const text = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!text) {
  console.error('Usage: npm run idea -- "your idea"   (or --list)');
  process.exit(2);
}

ensureHeader();
const id = slug(text);
const block =
  `idea:${id.replace(/^i/, '')} rdf:type ktype:Idea ;\n` +
  `    rdfs:label ${JSON.stringify(text)} ;\n` +
  `    kpred:has-status "speculative" ;\n` +
  `    kpred:verifiable-by "user" ;\n` +
  `    kpred:captured-at ${JSON.stringify(new Date().toISOString())} .\n\n`;
writeFileSync(IDEAS, readFileSync(IDEAS, 'utf8').trimEnd() + '\n\n' + block);

console.log(`${G}✓ captured${X} ${D}→ ${IDEAS}${X}`);
console.log(`  ${text}`);
console.log(`  ${D}speculative · verifiable-by user · the orchestrator will triage it and ask if it needs detail.${X}`);
