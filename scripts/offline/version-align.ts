#!/usr/bin/env npx tsx
/**
 * VERSION ALIGNMENT (script tier) — the number, the build and the graph cannot disagree.
 *
 * WHY IT EXISTS. The landing badge read "alpha · v0.2.0" as a hardcoded literal while
 * package.json declared the version separately, so the two were free to drift — and did. By
 * 2026-09-24 main carried 68 commits merged after 0.2.0 was set and the badge went on claiming
 * it, because nothing connected them. kb:honest-status does not exempt a claim because it is
 * short: a version string that no longer describes the build is a stale claim like any other.
 *
 * WHAT IT CHECKS, all deterministically and for free:
 *   1. package.json's version has a matching ktype:Release entity in the graph.
 *   2. That entity's kpred:version matches package.json exactly.
 *   3. No source file hardcodes a version literal again — the badge must read __APP_VERSION__.
 *
 * Rule 3 is the one that keeps the other two honest. Without it the next person to want a
 * version on screen types one, and the drift starts over somewhere new.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Parser } from 'n3';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const problems: string[] = [];

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
console.log(`\n${C.b}Version alignment${C.x}${C.d} — package.json declares ${pkgVersion}${C.x}\n`);

// 1 + 2. the graph must carry a release entity for exactly this version
const quads = new Parser().parse(readFileSync('static/reckons-roadmap.ttl', 'utf8'));
const VERSION_P = 'urn:kbase:predicate/version';
const releases = quads.filter((q) => q.predicate.value === VERSION_P).map((q) => ({ subject: q.subject.value, version: q.object.value }));

if (releases.length === 0) {
  problems.push('no ktype:Release entity carries kpred:version — the graph does not record any version');
} else if (!releases.some((r) => r.version === pkgVersion)) {
  problems.push(
    `package.json says ${pkgVersion} but the graph records only ${releases.map((r) => r.version).join(', ')} — ` +
      'a promotion bumped the package without recording what the version contains',
  );
} else {
  console.log(`  ${C.g}✓${C.x} graph records a release for ${pkgVersion}`);
}

// 3. nothing may hardcode a version literal in the app source
let hardcoded = '';
try {
  hardcoded = execSync(
    `git grep -nE "v[0-9]+\\.[0-9]+\\.[0-9]+" -- 'src/**/*.svelte' 'src/**/*.ts' || true`,
    { encoding: 'utf8' },
  );
} catch { /* git grep exits non-zero when nothing matches */ }
const offenders = hardcoded
  .split('\n')
  .filter(Boolean)
  // A comment explaining history may name an old version; only LIVE markup is a claim.
  .filter((l) => !/^\S+:\s*(\/\/|\*|<!--)/.test(l.replace(/^[^:]+:\d+:/, (m) => m)))
  .filter((l) => !l.includes('__APP_VERSION__'))
  .filter((l) => /alpha|badge|version/i.test(l));

if (offenders.length) {
  for (const o of offenders) problems.push(`hardcoded version literal: ${o.trim().slice(0, 140)}`);
} else {
  console.log(`  ${C.g}✓${C.x} no hardcoded version literal in app source`);
}

if (problems.length) {
  console.error(`\n${C.r}${problems.length} problem(s):${C.x}`);
  for (const p of problems) console.error(`  ${C.y}•${C.x} ${p}`);
  process.exit(1);
}
console.log(`\n${C.g}Version, build and graph agree.${C.x}\n`);
