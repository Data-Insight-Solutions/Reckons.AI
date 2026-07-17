#!/usr/bin/env npx tsx
/**
 * Build guard (SCRIPT tier) — is this actually a PRODUCTION build?
 *
 * WHY THIS EXISTS (2026-07-14): `.env` carried `NODE_ENV=development`. Vite reads it, so
 * `vite build` emitted a DEV-mode build — SvelteKit injected `import('/@vite/client')` into
 * build/index.html. Under `vite preview` that module does not exist, so every page load threw,
 * and the deploy-gate smoke test had been failing on a bug that was never in the product.
 *
 * Worse than the broken test: a local `npm run build` was never a real production build. The
 * smoke test exists specifically to catch the black-graph crash, which ONLY reproduces once
 * the bundle is minified (PR #21). So the one gate guarding a minification-only bug was
 * itself running against an unminified build. It could not have worked.
 *
 * Every check here is a RULE — "does this string appear", "is this file hashed" — so it is
 * deterministic, costs zero tokens, runs in well under a second, and cannot hallucinate. It
 * belongs in front of every build, where a Playwright suite does not.
 *
 * This does NOT replace the smoke test. The smoke test drives a real browser and catches
 * behaviour; this catches the class of failure where the ARTIFACT is wrong before anyone
 * bothers to run a browser against it. Cheapest tier that can do it correctly (F74.3).
 *
 * Usage:
 *   npx tsx scripts/offline/build-guard.ts            check ./build; exit 1 on any error
 *   npx tsx scripts/offline/build-guard.ts --dir=out  check a different output dir
 *   npx tsx scripts/offline/build-guard.ts --json     machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const DIR = argv.find((a) => a.startsWith('--dir='))?.split('=')[1] ?? 'build';
const JSON_OUT = argv.includes('--json');

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';

interface Finding {
  level: 'error' | 'warn';
  check: string;
  msg: string;
}
const findings: Finding[] = [];
const err = (check: string, msg: string) => findings.push({ level: 'error', check, msg });
const warn = (check: string, msg: string) => findings.push({ level: 'warn', check, msg });

if (!existsSync(DIR)) {
  console.error(`${R}No build output at ./${DIR} — run \`npm run build\` first.${X}`);
  process.exit(1);
}

const indexPath = path.join(DIR, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`${R}${indexPath} does not exist. This is not a build.${X}`);
  process.exit(1);
}
const index = readFileSync(indexPath, 'utf8');

// ── 1. No dev-mode artifacts. This is the check that would have caught the 2026-07-14 bug. ──
//
// Vite/SvelteKit inject these ONLY in dev. Their presence in build output means the build ran
// in development mode — the artifact is a lie about what it is, and nothing downstream (smoke
// test, preview, deploy) is testing what will actually ship.
const DEV_ARTIFACTS = [
  { needle: '@vite/client', why: 'Vite dev client — the build ran in DEV mode. Check NODE_ENV (a stray NODE_ENV=development in .env does exactly this).' },
  { needle: '@vite/env', why: 'Vite dev env shim — the build ran in DEV mode.' },
  { needle: '@react-refresh', why: 'Dev-only HMR runtime in a production build.' },
  { needle: '__vite_plugin_react', why: 'Dev-only plugin runtime in a production build.' },
];
for (const { needle, why } of DEV_ARTIFACTS) {
  if (index.includes(needle)) err('dev-artifact', `${indexPath} contains "${needle}". ${why}`);
}

// ── 2. The bundle is minified + content-hashed. ──
//
// The black-graph crash (PR #21) reproduces ONLY under minification: Threlte resolved a THREE
// class by function name, and minification mangles names. An unminified "production" build is
// therefore not merely suboptimal — it is incapable of exhibiting the exact bug the smoke test
// was written to catch.
const appDir = path.join(DIR, '_app', 'immutable');
if (!existsSync(appDir)) {
  warn('bundle', `No ${appDir} — cannot verify hashing/minification. Adapter changed?`);
} else {
  const jsFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) jsFiles.push(p);
    }
  };
  walk(appDir);

  if (jsFiles.length === 0) err('bundle', 'No JS emitted under _app/immutable — the build produced nothing.');

  // Content-hashed filenames (e.g. start.CAS7DLBo.js) are what makes immutable caching safe.
  const hashed = jsFiles.filter((f) => /\.[A-Za-z0-9_-]{8,}\.js$/.test(path.basename(f)));
  if (jsFiles.length > 0 && hashed.length === 0) {
    err('bundle', 'No content-hashed filenames under _app/immutable — output is not production-shaped.');
  }

  // Minified code has very long lines. Dev output is pretty-printed and indented.
  const biggest = jsFiles.sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (biggest) {
    const src = readFileSync(biggest, 'utf8');
    const longest = src.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    if (longest < 500 && src.length > 5000) {
      err(
        'minify',
        `${path.basename(biggest)} looks UNMINIFIED (longest line ${longest} chars). ` +
          'The black-graph crash only reproduces when minified — an unminified build cannot catch it.',
      );
    }
  }
}

// ── 3. The security headers we claim to ship are actually in the artifact. ──
// kb:honest-status: a control we describe but do not ship is worse than no control.
if (!/http-equiv=["']Content-Security-Policy["']/i.test(index)) {
  err('csp', 'No Content-Security-Policy meta tag in build/index.html — the CSP we document is not shipping.');
}

// ── 4. PWA service worker present (the app claims offline-first). ──
if (!existsSync(path.join(DIR, 'sw.js'))) {
  warn('pwa', 'No sw.js in the build — the offline-first PWA service worker did not emit.');
}

// ── Report ──
const errors = findings.filter((f) => f.level === 'error');
if (JSON_OUT) {
  console.log(JSON.stringify({ dir: DIR, ok: errors.length === 0, findings }, null, 2));
} else {
  console.log(`${B}Build guard${X} ${D}— ./${DIR}${X}\n`);
  if (findings.length === 0) {
    console.log(`${G}✓ production build verified${X} ${D}(no dev artifacts · minified · hashed · CSP present)${X}`);
  } else {
    for (const f of findings) {
      const c = f.level === 'error' ? R : Y;
      console.log(`  ${c}${f.level === 'error' ? '✗' : '!'}${X} ${B}${f.check}${X}  ${f.msg}`);
    }
    console.log(`\n${errors.length ? R : G}${errors.length} error(s)${X}, ${findings.length - errors.length} warning(s).`);
  }
}

// A build that is not a production build must not reach a deploy. Fail loudly.
process.exit(errors.length > 0 ? 1 : 0);
