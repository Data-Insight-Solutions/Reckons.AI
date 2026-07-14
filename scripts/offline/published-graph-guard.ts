#!/usr/bin/env npx tsx
/**
 * Guard the PUBLISHED graph (SCRIPT tier).
 *
 * `static/knowledge.ttl` is not a scratch file. It is served at `/knowledge.ttl` (see
 * src/routes/docs/+layout.svelte) and is `PUBLISHED_TTL_PATH` in src/lib/publish/site-export.ts:
 * it IS the public, machine-readable Reckons.AI graph. For a product whose thesis is that an
 * unverifiable claim is not evidence, the graph we publish about ourselves is the receipt.
 *
 * WHY THIS EXISTS (2026-07-13): it was found gutted in the working tree — 1032 statements
 * replaced by 45, the remains of a visual-test run, full of `urn:reckons:test/` story nodes.
 * One `git add .` away from publishing test debris to the world as "the Reckons.AI graph".
 * Nothing caught it: graph-lint deliberately SKIPS this file because it is generated, and a
 * derived artifact with no guard is a derived artifact nobody is watching.
 *
 * graph-lint is right not to lint it for *content* (fix the source, regenerate the snapshot).
 * This checks the things that are true of the snapshot REGARDLESS of the source: that it
 * parses, that it is not suddenly empty, that it is what it says it is, and that no test
 * harness has written its scratch data into it.
 *
 * Deterministic. Zero tokens. Right by construction.
 *
 * Usage:
 *   npx tsx scripts/offline/published-graph-guard.ts          report; exit 1 on error
 *   npx tsx scripts/offline/published-graph-guard.ts --json   machine-readable
 */
import { readFileSync, existsSync } from 'fs';
import { Parser } from 'n3';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

const FILE = 'static/knowledge.ttl';

/**
 * The floor, not the target. A real graph of the product is in the high hundreds; this only
 * catches a CATASTROPHIC truncation (an empty or debris-filled export), not slow erosion.
 * Deliberately well under the true count so pruning statements never trips it — a guard that
 * cries wolf on ordinary edits gets deleted, and then it guards nothing.
 */
const MIN_STATEMENTS = 400;

/**
 * Namespaces that belong to the TEST HARNESS, not to the product. Their presence in the
 * published graph means a test run wrote over it. The debris found in the 45-statement
 * version looked like: `urn:reckons:test/VR-Step2  rdf:type  urn:reckons:story/Step`.
 *
 * CORRECTED 2026-07-14 — this check was a FALSE POSITIVE and it cost real time.
 *
 * It used to ban `urn:reckons:story/` as well, and so reported 166 "test-harness terms" in
 * the published graph. Those terms are not debris: `urn:reckons:story/` is the PRODUCT'S OWN
 * guided-story vocabulary (src/lib/rdf/story.ts, used by the landing page, the about page,
 * and TurtleChatPanel's step walkthrough, and declared in reckons-production.ttl itself).
 *
 * Read the incident line again and the mistake is visible in it: the debris was
 * `urn:reckons:test/VR-Step2` — a TEST SUBJECT — that happened to be *typed* with
 * `story:Step`. The test harness borrowed the product's vocabulary, as it should. Banning the
 * vocabulary instead of the test subjects condemned the feature along with the debris.
 *
 * The lesson is the product's own: a finding is a CLAIM, and a claim you cannot verify is not
 * evidence. This one was believed and repeated — it was used to justify keeping the CI script
 * tier advisory rather than blocking — for as long as nobody checked whether
 * `urn:reckons:story/` was ours. It was.
 */
// The rule lives in lib/namespaces.ts, WITH TESTS — see that file for why.
import { TEST_NAMESPACES } from './lib/namespaces';

interface Finding {
  level: 'error' | 'warn';
  check: string;
  msg: string;
}
const findings: Finding[] = [];
const err = (check: string, msg: string) => findings.push({ level: 'error', check, msg });
const warn = (check: string, msg: string) => findings.push({ level: 'warn', check, msg });

let statements = 0;
let declared: number | null = null;

if (!existsSync(FILE)) {
  err('exists', `${FILE} is missing — the published graph is what the docs site serves at /knowledge.ttl.`);
} else {
  const text = readFileSync(FILE, 'utf8');

  // The header the exporter writes: `# generated <iso>` / `# <n> statements`.
  const declaredMatch = text.match(/^#\s*(\d+)\s+statements/im);
  declared = declaredMatch ? parseInt(declaredMatch[1], 10) : null;

  let quads: ReturnType<Parser['parse']> = [];
  try {
    // Every .ttl is legal TriG (F75), so this tolerates a named graph if one appears.
    quads = new Parser({ format: 'TriG' }).parse(text);
    statements = quads.length;
  } catch (e) {
    err('parse', `${FILE} does not parse: ${e instanceof Error ? e.message : e}`);
  }

  if (statements > 0) {
    // 1. Not gutted. This is the check that would have caught the clobber.
    if (statements < MIN_STATEMENTS) {
      err(
        'not-truncated',
        `${FILE} has only ${statements} statements (floor is ${MIN_STATEMENTS}). ` +
          `The published graph looks GUTTED — most likely a test run or a dev-server export ` +
          `wrote over it. Restore it (git checkout -- ${FILE}) before committing.`,
      );
    }

    // 2. No test-harness debris. The published graph describes the PRODUCT, not the suite.
    const debris = new Map<string, number>();
    for (const q of quads) {
      for (const term of [q.subject, q.predicate, q.object]) {
        const ns = TEST_NAMESPACES.find((n) => term.value.startsWith(n));
        if (ns) debris.set(ns, (debris.get(ns) ?? 0) + 1);
      }
    }
    for (const [ns, count] of debris) {
      err(
        'no-test-debris',
        `${FILE} contains ${count} term(s) in the test-harness namespace <${ns}>. ` +
          `A test run has written its scratch data into the PUBLISHED graph. This would ship ` +
          `to /knowledge.ttl as though it described the product.`,
      );
    }

    // 3. The header must not lie. It is the first thing a reader trusts, and it is cheap to
    //    check, so an untrue one is inexcusable — kb:honest-status applies to our own exports.
    if (declared !== null && declared !== statements) {
      warn(
        'honest-header',
        `${FILE} says "${declared} statements" but parses to ${statements}. ` +
          `The header was not regenerated with the body.`,
      );
    }
  }
}

const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({ file: FILE, statements, declared, findings }, null, 2));
} else {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

  console.log(`\n${bold('Published graph guard')} ${dim(`— ${FILE} (served at /knowledge.ttl)`)}\n`);

  for (const f of errors) console.log(`  ${red('✗')} ${bold(f.check)}  ${f.msg}\n`);
  for (const f of warns) console.log(`  ${yellow('!')} ${bold(f.check)}  ${f.msg}\n`);

  if (findings.length === 0) {
    console.log(`  ${green('✓')} ${statements} statements, parses, no test debris, header honest.\n`);
  }

  const summary = `${errors.length} error(s), ${warns.length} warning(s).`;
  console.log(errors.length ? red(summary) : green(summary));
}

process.exit(errors.length ? 1 : 0);
