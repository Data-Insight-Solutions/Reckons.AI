#!/usr/bin/env npx tsx
/**
 * SEE THE APP ON YOUR OWN DATA — a local visual check (SCRIPT tier).
 *
 * Matt, 2026-09-29: "So its a test data issue? why are you not visual testing?" Every check of the
 * Spaces map had drawn 2-5 invented spaces; his real 18-space registry showed clipped and
 * overlapping labels, a 9px drawing, a shared stable id and four missing ones — none of which the
 * invented data could produce. This script makes the honest check routine:
 *
 *   1. find the Chromium-family profile that holds the app's data for --origin (default :5173)
 *   2. COPY only that origin's IndexedDB, plus the Local Storage database, into a scratch profile
 *   3. open the copy headless, in the SAME browser build that wrote it (an older build may not read it)
 *   4. optionally serve different code (--serve, e.g. a branch on :5178) under the origin, so a branch
 *      can be tested against real data; the origin's dev-server websocket is blocked
 *   5. screenshot each --paths entry and record console and page errors
 *   6. DELETE the copy (unless --keep), always, even on failure
 *
 * PRIVACY, BY CONSTRUCTION: the running browser and its profile are only ever read, never written.
 * Screenshots and the report go to a private, owner-only directory outside any git checkout
 * (~/.local/state/reckons/local-visual/<time>/), because they show personal data. Only local origins
 * are accepted. Nothing is uploaded anywhere.
 *
 *   npx tsx scripts/offline/local-data-visual.ts --paths=/kb,/
 *   npx tsx scripts/offline/local-data-visual.ts --serve=http://localhost:5178 --paths=/kb --width=390
 *   options: --origin=http://localhost:5173  --wait-for=<css selector>  --height=1000  --keep
 *            --eval=<js expression>  evaluated in the page after it settles; the result goes to the private report
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { findProfiles, isHarnessNoise, originDirName, parseArgs, privateVisualDirectory } from './lib/local-data-visual.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [profile] = findProfiles(args.origin);
  if (!profile) {
    console.error(`No Chromium-family profile on this machine has data for ${args.origin}. Open the app there once, then retry.`);
    process.exit(2);
  }
  if (!existsSync(profile.executable)) {
    console.error(`Found data in ${profile.label}, but its browser (${profile.executable}) is missing — the same build must read it.`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(privateVisualDirectory(), stamp);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(out), 0o700);
  const scratch = path.join(profile.scratchParent, `reckons-local-visual-${stamp}`);

  const origin = originDirName(args.origin);
  const report: Record<string, unknown> = { at: new Date().toISOString(), profile: profile.label, origin: args.origin, serve: args.serve, pages: [] as unknown[] };
  try {
    // Copy ONLY this origin's databases (and Local Storage, where the app keeps its registry).
    const idb = path.join(profile.dir, 'IndexedDB');
    mkdirSync(path.join(scratch, 'Default', 'IndexedDB'), { recursive: true });
    for (const entry of readdirSync(idb)) {
      if (entry.startsWith(`${origin}.indexeddb.`)) cpSync(path.join(idb, entry), path.join(scratch, 'Default', 'IndexedDB', entry), { recursive: true });
    }
    cpSync(path.join(profile.dir, 'Local Storage', 'leveldb'), path.join(scratch, 'Default', 'Local Storage', 'leveldb'), { recursive: true });
    for (const lock of [path.join(scratch, 'Default', 'Local Storage', 'leveldb', 'LOCK'), ...readdirSync(path.join(scratch, 'Default', 'IndexedDB')).map((d) => path.join(scratch, 'Default', 'IndexedDB', d, 'LOCK'))]) {
      rmSync(lock, { force: true });
    }

    const ctx = await chromium.launchPersistentContext(scratch, {
      executablePath: profile.executable, headless: true, viewport: { width: args.width, height: args.height },
    });
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      if (args.serve !== args.origin) {
        const from = new URL(args.origin).host, to = new URL(args.serve).host;
        await page.routeWebSocket(new RegExp(from.replace('.', '\\.')), (ws) => ws.close());
        await page.route(`${args.origin}/**`, async (route) => {
          const response = await route.fetch({ url: route.request().url().replace(from, to) });
          await route.fulfill({ response });
        });
      }
      for (const p of args.paths) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text().slice(0, 400)}`); };
        const onError = (e: Error) => pageErrors.push(e.message.slice(0, 400));
        page.on('console', onConsole);
        page.on('pageerror', onError);
        await page.goto(`${args.origin}${p}`, { waitUntil: 'networkidle', timeout: 60_000 });
        if (args.waitFor) await page.locator(args.waitFor).first().waitFor({ timeout: 60_000 });
        await page.waitForTimeout(1500);
        const file = `page${p.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '') || '-root'}.png`;
        await page.screenshot({ path: path.join(out, file), fullPage: true });
        chmodSync(path.join(out, file), 0o600);
        const evaluated = args.evalExpr ? await page.evaluate(`(async () => (${args.evalExpr}))()`).catch((e: Error) => `eval failed: ${e.message}`) : undefined;
        page.off('console', onConsole);
        page.off('pageerror', onError);
        const harness = args.serve !== args.origin ? consoleErrors.filter(isHarnessNoise) : [];
        const appConsole = consoleErrors.filter((m) => !harness.includes(m));
        (report.pages as unknown[]).push({ path: p, screenshot: file, pageErrors, consoleErrors: appConsole, harnessNoise: harness, evaluated });
        console.log(`${p}: ${pageErrors.length} page error(s), ${appConsole.length} app console warning(s)/error(s), ${harness.length} harness message(s) → ${file}`);
      }
    } finally {
      await ctx.close();
    }
  } finally {
    if (!args.keep) rmSync(scratch, { recursive: true, force: true });
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(`\nPrivate output (screenshots show your data): ${out}`);
  console.log(args.keep ? `Scratch copy KEPT at ${scratch} — delete it when done.` : 'Scratch copy of your data deleted.');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
