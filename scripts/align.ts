#!/usr/bin/env npx tsx
/**
 * `npm run align` — THE GATE (SCRIPT tier).
 *
 * The premise of Reckons.AI is: UPDATE THE GRAPH, AND THE CHANGES FOLLOW. Every generator
 * needed for that already existed — docs pages, landing features, landing principles — and
 * every one of them already had a --check mode. None of them gated anything.
 *
 * md-align ran in CI with `continue-on-error: true`, described in its own comment as "a
 * hygiene signal, not a gate". So "the page is generated from the graph" was true only for
 * as long as somebody remembered to run the generator. A page could drift from the graph and
 * CI would stay green — which means the claim "our site is generated from our graph" was
 * itself an unverified claim, made by the party it benefits. That is the exact thing this
 * product exists to refuse.
 *
 * This runs every SYNCHRONOUS check — the ones that are decidable by a rule, right now,
 * with no model and no judgment — and FAILS. It is the sync half of alignment.
 *
 * The other half is asynchronous: scripts/offline/claim-audit.ts sweeps the surfaces that
 * are NOT generated (README, SAFETY.md, hand-written copy) and emits PROPOSALS for review,
 * because "is this sentence claiming something untrue" is a judgment, not a rule.
 *
 * Usage:
 *   npm run align            check everything; exit 1 on any drift
 *   npm run align -- --fix   regenerate what can be regenerated, then re-check
 */
import { execSync } from 'child_process';

const FIX = process.argv.includes('--fix');
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m';

interface Gate {
  name: string;
  why: string;
  /** The check. Exits non-zero on drift. */
  check: string;
  /** How to make it true again (used by --fix, and printed on failure). */
  fix?: string;
}

const GATES: Gate[] = [
  {
    name: 'graph-lint',
    why: 'the graph itself must be internally consistent before anything is generated from it',
    check: 'npx tsx scripts/offline/graph-lint.ts',
  },
  {
    name: 'docs pages',
    why: 'content/*.md must match what the graph generates — a hand-edited page is a second source of truth',
    check: 'npx tsx scripts/md-align.ts',
    fix: 'npx tsx scripts/docs-pages.ts',
  },
  {
    name: 'landing features',
    why: 'the landing page advertised "16 MCP tools" while the graph said 20 — public copy drifting from the graph is a false public claim',
    check: 'npx tsx scripts/landing-features.ts --check',
    fix: 'npx tsx scripts/landing-features.ts',
  },
  {
    name: 'landing principles',
    why: 'the tenets on the front page are marked "enforced in code" or "what we believe" — that distinction must come from the graph, not from memory',
    check: 'npx tsx scripts/landing-principles.ts --check',
    fix: 'npx tsx scripts/landing-principles.ts',
  },
];

console.log(`${B}Alignment gate${X} ${D}— the graph is the source; everything else is downstream${X}\n`);

if (FIX) {
  console.log(`${D}--fix: regenerating everything that can be regenerated…${X}\n`);
  for (const g of GATES) {
    if (!g.fix) continue;
    process.stdout.write(`  regen ${g.name} … `);
    try {
      execSync(g.fix, { stdio: 'pipe' });
      console.log(`${G}done${X}`);
    } catch {
      console.log(`${R}FAILED${X}`);
    }
  }
  console.log('');
}

const failed: Gate[] = [];
for (const g of GATES) {
  process.stdout.write(`  ${g.name.padEnd(20)}`);
  try {
    execSync(g.check, { stdio: 'pipe' });
    console.log(`${G}✓ aligned${X}`);
  } catch {
    console.log(`${R}✗ DRIFTED${X}  ${D}${g.why}${X}`);
    failed.push(g);
  }
}

if (failed.length === 0) {
  console.log(`\n${G}✓ aligned — the site says exactly what the graph says.${X}`);
  process.exit(0);
}

console.log(`\n${R}${B}${failed.length} surface(s) drifted from the graph.${X}`);
for (const g of failed) {
  console.log(`\n  ${B}${g.name}${X}`);
  console.log(`    ${D}why it matters:${X} ${g.why}`);
  console.log(`    ${D}re-run the check:${X} ${g.check}`);
  if (g.fix) console.log(`    ${D}fix:${X} ${g.fix}   ${D}(or: npm run align -- --fix)${X}`);
}
console.log(
  `\n${D}Fix the GRAPH, then regenerate. Do not hand-edit the generated file — that is how the${X}\n` +
    `${D}graph stops being the source of truth, one small edit at a time.${X}`,
);
process.exit(1);
