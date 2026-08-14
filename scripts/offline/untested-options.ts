#!/usr/bin/env npx tsx
/**
 * UNTESTED OPTIONAL INPUTS (SCRIPT tier) — the shape green coverage keeps hiding.
 *
 * WHY THIS EXISTS. The same failure landed three times in one session, each time behind a
 * passing suite:
 *
 *   F55        indico-verify was 6/6 green from Node, where neither CSP nor CORS is enforced,
 *              while no browser had ever reached the server.
 *   toTriG     fully covered and broken for its FIRST real caller, because every test called
 *              toTriG(facts) and the caller passed { header }, which was emitted uncommented.
 *   describePrompt  tests supplied a real label or none; the real detector supplies the ENTITY
 *              IRI as the label, so the prompt read "urn:kbase:concept/old-supplier".
 *
 * The common shape is not "untested function" — coverage tools already find those. It is an
 * OPTIONAL INPUT WHOSE NON-DEFAULT VALUE NOTHING EXERCISES. The function is called, the line
 * is covered, and the branch that only opens when someone passes the option never runs.
 *
 * WHAT IT FOUND ON ITS FIRST RUN, which is the argument for keeping it: 32 of 106 optional
 * option-fields were never passed by any test, and among them was
 * TurtleChatOptions.publishedMode — the flag gating PUBLISHED_ETHICS_WRAPPER, the ethics text
 * shown to anyone opening a SHARED graph. A safety control with no coverage.
 *
 * DELIBERATELY NARROW. It looks only at optional fields on exported *Options/*Opts/*Input/
 * *Config types, and asks whether the field name is ever passed as a key in a test file. That
 * is a coarse question with a low false-negative rate and a real false-positive rate — a field
 * passed via spread, or named the same as an unrelated key, will be judged wrongly. It reports
 * and never fails a build, because a check whose noise costs more than it saves is the exact
 * trap CLAUDE.md warns about with agent-tier jobs.
 *
 * Usage: npx tsx scripts/offline/untested-options.ts [--all]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHOW_ALL = process.argv.includes('--all');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.svelte-kit/.test(p)) walk(p, out);
    } else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const all = walk(join(ROOT, 'src/lib'));
const sources = all.filter((f) => !/__tests__/.test(f));
const testText = all
  .filter((f) => /__tests__/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** Fields whose name is generic enough that a test mentioning it proves nothing. */
const TOO_GENERIC = new Set(['id', 'name', 'value', 'type', 'label', 'key', 'data', 'text']);

type Finding = { file: string; typeName: string; field: string; safety: boolean };
const findings: Finding[] = [];
let total = 0;

// Fields whose untested state is worth shouting about rather than listing.
// `token` alone was too loose — it matched maxTokens on the first run, which is a budget,
// not a credential. Narrowed to the words that actually name a control.
const SAFETY_HINT = /ethic|safety|publish|redact|secret|apiKey|accessToken|authToken|\bauth\b|gate|policy|consent|share/i;

for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(
    /export (?:interface|type) (\w*(?:Options|Opts|Input|Config))\s*=?\s*\{([\s\S]*?)\n\}/g,
  )) {
    const [, typeName, body] = m;
    for (const fm of body.matchAll(/^\s*(\w+)\?:/gm)) {
      const field = fm[1];
      if (TOO_GENERIC.has(field)) continue;
      total++;
      // Passed as an object key anywhere in a test?
      if (new RegExp(`\\b${field}\\s*:`).test(testText)) continue;
      findings.push({
        file: relative(ROOT, file),
        typeName,
        field,
        safety: SAFETY_HINT.test(field) || SAFETY_HINT.test(typeName),
      });
    }
  }
}

const safety = findings.filter((f) => f.safety);
const rest = findings.filter((f) => !f.safety);

console.log(
  `\x1b[1muntested optional inputs\x1b[0m \x1b[2m— ${total} optional option-field(s); ` +
    `${findings.length} never passed in any test\x1b[0m\n`,
);

if (safety.length > 0) {
  console.log('\x1b[31m\x1b[1mSAFETY-ADJACENT\x1b[0m \x1b[2m(name suggests a control; untested)\x1b[0m');
  for (const f of safety) console.log(`  \x1b[31m!\x1b[0m ${f.typeName}.${f.field}  \x1b[2m${f.file}\x1b[0m`);
  console.log('');
}

const show = SHOW_ALL ? rest : rest.slice(0, 12);
for (const f of show) console.log(`    ${f.typeName}.${f.field}  \x1b[2m${f.file}\x1b[0m`);
if (!SHOW_ALL && rest.length > show.length) {
  console.log(`  \x1b[2m… ${rest.length - show.length} more (--all)\x1b[0m`);
}

console.log(
  '\n\x1b[2mAn optional input nothing passes is a branch nothing runs — the function is\n' +
    'covered, the option is not. Coarse by design: a field passed via spread, or sharing a\n' +
    'name with an unrelated key, will be judged wrongly. Reports only; never fails a build.\x1b[0m',
);
process.exit(0);
