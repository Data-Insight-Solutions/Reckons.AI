#!/usr/bin/env npx tsx
/**
 * VITE secret guard (F107.5, SCRIPT tier) — refuse to build a bundle that would ship
 * a provider secret to every user.
 *
 * WHY: src/lib/storage/db.ts reads `import.meta.env.VITE_ANTHROPIC_API_KEY` and nine
 * siblings. Vite INLINES `import.meta.env.VITE_*` into the client bundle at build time,
 * so any such variable set in the build environment is compiled into build/*.js and
 * served publicly. A static client cannot keep an operator secret. Runtime keys belong
 * in the app Settings (persisted to IndexedDB by the user's explicit choice), never at
 * build time.
 *
 * This is a RULE — "is a VITE secret var set in the build env" — so it is deterministic,
 * costs zero tokens, and runs in front of every build. It complements build-guard.ts,
 * which checks the finished artifact; this stops the leak before the artifact exists.
 *
 * Usage:
 *   npx tsx scripts/offline/vite-secret-guard.ts     # exit 1 if a secret is present
 *   VITE_SECRET_GUARD_ALLOW=1 npm run build          # deliberate LOCAL build with a baked key
 */

// A VITE_ variable whose name ends in a secret-bearing suffix. Config vars like
// VITE_PREFERRED_BACKEND do not match, so they never trip the guard.
const SECRET_SUFFIX = /^VITE_.*(KEY|SECRET|TOKEN|PASSWORD)$/i;

export function findBakedSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => SECRET_SUFFIX.test(k) && (env[k] ?? '').trim() !== '')
    .sort();
}

function main(): void {
  const offenders = findBakedSecrets(process.env);
  const overridden = process.env.VITE_SECRET_GUARD_ALLOW === '1';

  if (offenders.length === 0) {
    console.log('✓ vite-secret-guard: no provider secrets in the build environment.');
    return;
  }

  if (overridden) {
    console.warn(`⚠ vite-secret-guard: ${offenders.length} secret(s) present but VITE_SECRET_GUARD_ALLOW=1 — ` +
      `building anyway. NEVER distribute this bundle: ${offenders.join(', ')}`);
    return;
  }

  console.error('✗ BUILD BLOCKED (F107.5): provider secret(s) in the build environment would be');
  console.error('  INLINED into the PUBLIC client bundle (Vite compiles import.meta.env.VITE_* into build/*.js):');
  for (const k of offenders) console.error(`    ${k}`);
  console.error('');
  console.error('  A static client cannot keep an operator secret — these would ship to every user.');
  console.error('  Provider keys belong in the app Settings (stored in IndexedDB), not the build env.');
  console.error('  For a deliberate LOCAL build with a baked key (never for distribution): VITE_SECRET_GUARD_ALLOW=1');
  process.exit(1);
}

// Run only when invoked directly, so the pure findBakedSecrets can be unit-tested.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
