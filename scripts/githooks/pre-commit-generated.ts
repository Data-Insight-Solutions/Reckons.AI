#!/usr/bin/env npx tsx
/**
 * pre-commit generated-file gate (F273 phase A, SCRIPT tier).
 *
 * A generated file is the output of a script. Editing it by hand, or changing its inputs without
 * regenerating, fails CI after the push (2026-10-28: a hand edit to static/reckons-ci.ttl failed
 * #535). So when a commit stages a generator's output OR its inputs, run that generator's own
 * --check mode here, before the commit exists. Only generators that are fast belong in
 * scripts/githooks/generated.json (measured under 3 s each); slow ones stay in CI.
 *
 * HONEST LIMIT: the check reads the WORKING TREE, not the staged blob, so a partially staged
 * generated file can pass here and still be wrong in the commit. CI remains the backstop.
 *
 * RECKONS_GENERATED_REGISTRY overrides the registry path (tests use a synthetic one).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Generated { name: string; triggers: string[]; check: string; fix: string }

/** A trigger ending in "/" or "-" or "." matches by prefix; anything else matches exactly or as a prefix. */
export const triggered = (g: Generated, staged: string[]) => staged.some((f) => g.triggers.some((t) => f === t || f.startsWith(t)));

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const reg: Generated[] = JSON.parse(readFileSync(process.env.RECKONS_GENERATED_REGISTRY ?? join(here, 'generated.json'), 'utf8'));
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const failed: Generated[] = [];
  for (const g of reg.filter((x) => triggered(x, staged))) {
    const r = spawnSync('bash', ['-c', g.check], { encoding: 'utf8' });
    if (r.status !== 0) failed.push(g);
  }
  if (!failed.length) return;
  for (const g of failed) {
    console.error(`pre-commit: generated output "${g.name}" is stale or hand-edited. Regenerate, re-stage, commit again:\n  ${g.fix}`);
  }
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('pre-commit-generated.ts')) main();
