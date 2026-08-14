#!/usr/bin/env npx tsx
/**
 * Secret scan (F107.5, SCRIPT tier) — deterministic, zero tokens.
 *
 * Two ways a real credential ends up in the PUBLIC client bundle, both decidable by a rule:
 *
 *  1. Build-time inlining. Vite replaces `import.meta.env.VITE_*` with the literal value at
 *     build. Several such references name secrets (VITE_*_API_KEY, VITE_HUME_SECRET_KEY): if
 *     that env var is set when a production bundle is built, the secret is compiled into a file
 *     anyone can download. This guard FAILS when any secret-named VITE_ var referenced in the
 *     source is actually set in the environment.
 *
 *  2. A leaked value already in a build. If a `build/` output exists, scan it for the values of
 *     those same env vars (when set) as a backstop.
 *
 * Usage:
 *   npx tsx scripts/offline/secret-scan.ts            report; exit 1 on a real leak
 *   npx tsx scripts/offline/secret-scan.ts --ci       same, intended for CI (blocking)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const BUILD_DIRS = ['build', '.svelte-kit/output/client'];

/** A VITE_ env var name is secret-shaped when it ends in a credential word. */
const SECRET_VITE = /VITE_[A-Z0-9_]*(API_KEY|SECRET|SECRET_KEY|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|svelte|js|mjs)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

// 1. Collect every secret-named VITE_ var the source reads (the inlining points).
const referenced = new Set<string>();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(SECRET_VITE)) referenced.add(m[0]);
}

const problems: string[] = [];

// 2. FAIL if any of them is set in the environment — a production build would inline it.
for (const name of referenced) {
  const val = process.env[name];
  if (val && val.trim() !== '') {
    problems.push(`${name} is SET in the environment — a production build would inline this secret into the public bundle. Provide it as a RUNTIME user setting, never a build-time VITE_ var.`);
  }
}

// 3. Backstop: if a build exists, scan it for any set secret value.
const setValues = [...referenced]
  .map((n) => process.env[n])
  .filter((v): v is string => !!v && v.trim().length >= 8);
for (const rel of BUILD_DIRS) {
  const dir = path.join(ROOT, rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const secret of setValues) {
      if (text.includes(secret)) problems.push(`A configured secret value appears verbatim in build output: ${path.relative(ROOT, file)}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Secret scan — ${referenced.size} secret-named VITE_ reference(s) in source:`);
for (const n of [...referenced].sort()) console.log(`  ${n}`);

if (problems.length === 0) {
  console.log('\n\x1b[32m✓ No provider secret is set to inline into the bundle.\x1b[0m');
  process.exit(0);
}

console.error(`\n\x1b[31m✗ ${problems.length} secret-exposure problem(s):\x1b[0m`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
