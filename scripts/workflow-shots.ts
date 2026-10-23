#!/usr/bin/env npx tsx
/**
 * Capture the annotated screenshots of a test workflow (F34.2), compress them to WebP under
 * static/workflows/<id>/, and link each from its TestStep in static/docs-testing.ttl.
 *
 * DELIBERATE, NOT AUTOMATIC. This is an npm script run by a person, never part of the docs build or
 * CI: a screenshot is a reviewed artifact, committed like the diagram cache, so that the page a
 * reader sees is the page somebody looked at. Re-run it when a step or the UI it shows changes.
 *
 * SYNTHETIC DATA ONLY. The e2e test starts from an empty browser profile and types its own made-up
 * note, so nothing here can read real notes. Every pushed branch is public.
 *
 *   npm run workflow:shots                      capture every workflow
 *   npm run workflow:shots -- --workflow=readme-path
 *   WORKFLOW_BASE_URL=http://localhost:5174     reuse a running mock-backend dev server
 *   CHROME_PATH=/usr/bin/google-chrome          use an installed Chrome (needed if Playwright's
 *                                               own download is older than the installed version)
 *
 * What it does NOT do: judge whether a screenshot is good. Look at them before committing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ROOT, TESTING_TTL, loadWorkflowsFromFile, conventionalScreenshotPath, screenshotFile,
  setScreenshotLink, SHOT_WIDTH,
} from './lib/test-workflow.js';

const only = process.argv.find((a) => a.startsWith('--workflow='))?.split('=')[1];
const workflows = loadWorkflowsFromFile().filter((w) => !only || w.id === only);
if (!workflows.length) { console.error(`No workflow${only ? ` "${only}"` : ''} in the Testing graph.`); process.exit(1); }

/** The e2e test file that runs each workflow, relative to the repo (kpred:test-file). */
let ttl = readFileSync(TESTING_TTL, 'utf8');
let failed = false;

for (const w of workflows) {
  const dir = mkdtempSync(join(tmpdir(), `workflow-${w.id}-`));
  console.log(`\n${w.title}  (${w.steps.length} steps)`);
  try {
    execFileSync('npx', ['playwright', 'test', '--config=playwright.workflow-shots.config.ts', w.testFile], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, WORKFLOW_CAPTURE_DIR: dir },
    });
  } catch {
    console.error(`\n✗ ${w.testFile} failed, so no screenshots were written for "${w.id}".`);
    failed = true;
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  const have = new Set(readdirSync(dir));
  for (const s of w.steps) {
    const png = `${String(s.order).padStart(2, '0')}-${s.id}.png`;
    if (!have.has(png)) { console.error(`  ✗ step ${s.order} (${s.id}) produced no screenshot`); failed = true; continue; }
    const sitePath = conventionalScreenshotPath(w, s);
    const out = screenshotFile(sitePath);
    mkdirSync(join(out, '..'), { recursive: true });
    await sharp(join(dir, png)).resize({ width: SHOT_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80, effort: 6 }).toFile(out);
    ttl = setScreenshotLink(ttl, s.iri, sitePath);
    console.log(`  ✓ ${sitePath}  ${(statSync(out).size / 1024).toFixed(0)} KB`);
  }
  rmSync(dir, { recursive: true, force: true });
}

if (existsSync(TESTING_TTL)) writeFileSync(TESTING_TTL, ttl);
console.log('\nNext: npx tsx scripts/docs-pages.ts   (regenerates content/), then look at the pictures.');
process.exit(failed ? 1 : 0);
