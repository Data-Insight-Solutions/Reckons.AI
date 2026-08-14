#!/usr/bin/env npx tsx
/**
 * SHACL VALIDATION (F128, SCRIPT tier) — W3C SHACL via rdf-validate-shacl. Zero tokens.
 *
 * WHY NOT JUST MORE graph-lint. graph-lint already enforces this repo's invariants, and every
 * one of its rules is hardcoded TypeScript about this repo's own vocabulary. That is correct
 * for invariants of THIS project and useless for anything else: a user's graph, a shared
 * package, or a grant-seeker profile cannot state what well-formed means for them, because
 * the rules live in our source rather than in the data. SHACL shapes are DATA — they travel
 * with a graph, can be authored without a code change, and can be checked by any conforming
 * tool rather than only by us.
 *
 * WHY THE REAL LIBRARY. Writing "a SHACL subset" and calling it SHACL would be the overclaim
 * this project forbids. rdf-validate-shacl is a conforming implementation and is a
 * devDependency used only here, in Node — so the browser bundle of a local-first app pays
 * NOTHING for it.
 *
 * HONEST SCOPE, 2026-08-13: this validates exported graphs at script tier. It is NOT wired
 * into the in-app review gate, so no fact is blocked by a shape in the product today. Adding
 * that is the next step and it is deliberately not claimed here.
 *
 * Usage:
 *   npx tsx scripts/offline/shacl-validate.ts              report; exit 1 on violations
 *   npx tsx scripts/offline/shacl-validate.ts --pending    also queue findings for review
 *   npx tsx scripts/offline/shacl-validate.ts --warn-only  never fail the build
 */

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Parser } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';

const ROOT = new URL('../..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const WARN_ONLY = argv.includes('--warn-only');
const PENDING = join(ROOT, 'reckons-workspace/knowledge.pending.jsonl');

const SHAPES_DIR = join(ROOT, 'static/shapes');
const DATA_ROOTS = ['static', 'reckons-workspace/kbs', 'mcp-workspace/kbs'];

/** Parse to quads. Two things the API requires and neither is obvious:
 *  the validator brings its own RDF environment (src/defaultEnv.js) and needs clownface, so
 *  handing it a foreign factory fails; and validate() needs a real Dataset with .match(), not
 *  a quad array — built via validator.factory.dataset(). validate() is also ASYNC here. */
function parseQuads(ttl: string, label: string) {
  try {
    return { quads: new Parser().parse(ttl), error: null, label };
  } catch (e) {
    return { quads: null, error: (e as Error).message.split('\n')[0].slice(0, 120), label };
  }
}

function ttlFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // Shapes are the rules, not the data — validating them against themselves proves nothing.
      if (p.startsWith(SHAPES_DIR)) continue;
      ttlFiles(p, out);
    } else if (name.endsWith('.ttl')) out.push(p);
  }
  return out;
}

// ── Load shapes ──────────────────────────────────────────────────────────────

if (!existsSync(SHAPES_DIR)) {
  console.error(`No shapes directory at ${relative(ROOT, SHAPES_DIR)} — nothing to validate against.`);
  process.exit(1);
}
const shapeFiles = readdirSync(SHAPES_DIR).filter((f) => f.endsWith('.ttl'));
const shapesTtl = shapeFiles.map((f) => readFileSync(join(SHAPES_DIR, f), 'utf8')).join('\n');
const shapesParsed = parseQuads(shapesTtl, 'shapes');
if (!shapesParsed.quads) {
  console.error(`Shapes do not parse: ${shapesParsed.error}`);
  process.exit(1);
}
const validator = new SHACLValidator(shapesParsed.quads);

// ── Validate every data graph ────────────────────────────────────────────────

type Violation = {
  file: string;
  focus: string;
  path: string;
  message: string;
  severity: string;
};

const violations: Violation[] = [];
let filesChecked = 0;
let unparseable = 0;

for (const root of DATA_ROOTS) {
  for (const file of ttlFiles(join(ROOT, root))) {
    const rel = relative(ROOT, file);
    const parsed = parseQuads(readFileSync(file, 'utf8'), rel);
    if (!parsed.quads) {
      unparseable++;
      continue; // an unparseable graph is graph-lint's finding, not a shape violation
    }
    filesChecked++;
    const report = await validator.validate(validator.factory.dataset(parsed.quads));
    if (report.conforms) continue;
    for (const r of report.results) {
      violations.push({
        file: rel,
        focus: String(r.focusNode?.value ?? '?').replace('urn:kbase:concept/', ''),
        path: String(r.path?.value ?? '').split('/').pop() ?? '',
        message: r.message?.map((m) => m.value).join(' ') || String(r.sourceConstraintComponent?.value ?? 'constraint violated'),
        severity: String(r.severity?.value ?? '').split('#').pop() || 'Violation',
      });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(
  `\x1b[1mSHACL\x1b[0m \x1b[2m— ${shapeFiles.length} shape file(s), ${filesChecked} graph(s) checked` +
    (unparseable ? `, ${unparseable} unparseable (see graph-lint)` : '') +
    '\x1b[0m',
);

if (violations.length === 0) {
  console.log('\n\x1b[32m0 violation(s)\x1b[0m — every targeted node conforms.');
  process.exit(0);
}

const byFile = new Map<string, Violation[]>();
for (const v of violations) byFile.set(v.file, [...(byFile.get(v.file) ?? []), v]);

for (const [file, vs] of byFile) {
  console.log(`\n\x1b[31m${vs.length}\x1b[0m \x1b[2m${file}\x1b[0m`);
  for (const v of vs.slice(0, 12)) {
    console.log(`  ${v.focus}${v.path ? ` \x1b[2m.${v.path}\x1b[0m` : ''}`);
    console.log(`    \x1b[2m${v.message}\x1b[0m`);
  }
  if (vs.length > 12) console.log(`  \x1b[2m… ${vs.length - 12} more\x1b[0m`);
}

if (PENDING_OUT) {
  const lines = violations.slice(0, 40).map((v) =>
    JSON.stringify({
      subject: `urn:kbase:concept/${v.focus}`,
      predicate: 'urn:kbase:predicate/shape-violation',
      object: v.message,
      note: `SHACL ${v.severity} in ${v.file}${v.path ? ` on ${v.path}` : ''}`,
      // FORM, not drift. A shape violation is decidable from the artifact alone — a missing
      // rdfs:label is a malformed node, not the graph disagreeing with reality. Typing these
      // as drift-warning (as this job did on its first day) buries the findings that DO
      // require a human to decide which side is wrong.
      findingClass: 'form',
      type: 'observation',
      agent: 'offline:shacl-validate',
      priority: 'normal',
    }),
  );
  appendFileSync(PENDING, lines.join('\n') + '\n');
  console.log(`\n\x1b[2mqueued ${lines.length} finding(s) for review\x1b[0m`);
}

console.log(`\n\x1b[31m${violations.length} violation(s)\x1b[0m`);
process.exit(WARN_ONLY ? 0 : 1);
