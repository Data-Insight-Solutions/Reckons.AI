#!/usr/bin/env npx tsx
/**
 * PROMOTION GATE (script tier, BLOCKING in CI) — main is reached through staging, or not at all.
 *
 * WHY IT EXISTS. F33 has declared dev -> staging -> main since it was written, and nothing ever
 * checked it. Measured 2026-09-24: staging was 422 commits behind dev and 415 behind main, which
 * is what a declared step looks like when it is enforced by remembering. Two promotions in one
 * week went dev -> main directly; both were legitimate calls by Matt, and both were invisible to
 * CI, which is the part that stops being acceptable once other people are watching the repo.
 *
 * WHAT IT CHECKS. On a pull request into `main`, the head branch must be `staging`. That is the
 * whole rule. It is deterministic, it cannot be wrong by accident, and the failure message names
 * the path back — which matters more than the block itself, because a gate nobody can satisfy
 * gets deleted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not inspect commit contents, require staging to be
 * green (CI already does), or block anything outside a PR into main. A release engineer with a
 * genuine emergency can still merge with admin rights and the audit trail records that they did —
 * which is a better property than a rule that tempts people to switch the whole thing off.
 *
 * Usage:
 *   npx tsx scripts/offline/promotion-gate.ts                      # infers from CI env
 *   npx tsx scripts/offline/promotion-gate.ts --base=main --head=dev
 */
const raw = process.argv.slice(2);
const flag = (n: string) => raw.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const base = flag('base') ?? process.env.GITHUB_BASE_REF ?? '';
const head = flag('head') ?? process.env.GITHUB_HEAD_REF ?? '';
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

// Not a pull request, or not one into main — nothing to say.
if (!base) {
  console.log(`${C.d}Not a pull request (no base ref) — promotion gate does not apply.${C.x}`);
  process.exit(0);
}
if (base !== 'main') {
  console.log(`${C.d}PR targets ${base}, not main — promotion gate does not apply.${C.x}`);
  process.exit(0);
}

console.log(`\n${C.b}Promotion gate${C.x}${C.d} — ${head || '(unknown)'} → ${base}${C.x}\n`);

if (head === 'staging') {
  console.log(`  ${C.g}✓${C.x} main is being reached from staging, as F33 declares.\n`);
  process.exit(0);
}

console.error(
  `  ${C.r}✗ main may only be promoted from staging.${C.x}\n\n` +
    `  This PR is from ${C.y}${head || 'an unknown branch'}${C.x}. F33 declares dev → staging → main,\n` +
    `  and main deploys to production on every push, so a skipped step is an unreviewed deploy.\n\n` +
    `  ${C.b}The path from here:${C.x}\n` +
    `    1. merge your work into ${C.b}dev${C.x} (that is where feature PRs belong)\n` +
    `    2. open ${C.b}dev → staging${C.x}, let CI pass, and look at the staging deploy\n` +
    `    3. open ${C.b}staging → main${C.x} — this check passes and the promotion is reviewable\n`,
);
process.exit(1);
