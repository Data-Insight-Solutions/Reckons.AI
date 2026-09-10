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
    // Ordered BEFORE 'docs pages' on purpose: a missing diagram makes docs-pages.ts throw, so
    // without this gate the failure surfaces as a stack trace from the generator rather than as
    // the one-line instruction that actually fixes it.
    name: 'docs diagrams',
    why: 'every mermaid diagram declared in a graph must be in the committed render cache — CI never renders, because mermaid lays text out with the fonts of whatever machine runs it and a re-render in CI would produce a diff nobody wrote',
    check: 'npx tsx scripts/docs-diagrams.ts --check',
    fix: 'npx tsx scripts/docs-diagrams.ts',
  },
  {
    // Ordered with the diagrams gate and for the same reason: a scene missing from the cache makes
    // docs-pages.ts throw, and a stack trace is a worse message than the command that fixes it.
    name: 'docs scenes',
    why: 'every three.js scene declared in a graph must be in the committed render cache — CI never renders, because a GPU and a software rasteriser do not produce identical pixels and a re-render would show a diff nobody wrote',
    check: 'npx tsx scripts/docs-scenes.ts --check',
    fix: 'npx tsx scripts/docs-scenes.ts',
  },
  {
    // Not a generated surface, so it cannot drift the way the others do — but a docs graph
    // registered in some lists and not others publishes inconsistently AND blinds the orphan gate
    // in the same place, which is how docs-user-paths.ttl nearly lost 21 published pages.
    name: 'graph registration',
    why: 'every publishable docs graph must appear in all four registries, with a unique stable id — a partially registered graph publishes inconsistently and the gate that would catch it goes blind in the same place',
    check: 'npx tsx scripts/offline/docs-graph-registration.ts --quiet',
  },
  {
    name: 'docs pages',
    why: 'content/*.md must match what the graph generates — a hand-edited page is a second source of truth',
    check: 'npx tsx scripts/md-align.ts',
    fix: 'npx tsx scripts/docs-pages.ts',
  },
  {
    // AFTER 'docs pages': the index is built FROM content/, so checking it before the pages are
    // known to be current would report a stale index that is really a stale build.
    name: 'docs search',
    why: 'the search index is built from content/ and is fetched by every reader who opens search — a stale index silently returns yesterday\'s pages',
    check: 'npx tsx scripts/docs-search-index.ts --check',
    fix: 'npx tsx scripts/docs-search-index.ts',
  },
  {
    name: 'landing features',
    why: 'the landing page advertised "16 MCP tools" while the graph said 20 — public copy drifting from the graph is a false public claim',
    check: 'npx tsx scripts/landing-features.ts --check',
    fix: 'npx tsx scripts/landing-features.ts',
  },
  {
    name: 'digest',
    why: 'DIGEST.md is GENERATED from reckons-workspace/digest.ttl — the digest records our own failures, and keeping THAT as a second source of truth was the sharpest hypocrisy in the repo',
    check: 'npx tsx scripts/agent/digest-graph.ts --check',
    fix: 'npx tsx scripts/agent/digest-graph.ts --render',
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
