#!/usr/bin/env npx tsx
/**
 * Test-workflow check (F34.2, SCRIPT tier) — every step of every test workflow has a screenshot,
 * and every screenshot a step links is a real file. No model, no browser, zero tokens.
 *
 * Findings, each of which fails the run:
 *   no-screenshot    a TestStep with no kpred:screenshot (the docs page says "not yet captured")
 *   missing-file     a step links a screenshot path that is not under static/
 *   not-webp         the linked file is not a .webp (the committed format, for size)
 *   no-test-file     the workflow's kpred:test-file does not exist
 *   step-not-in-test the test file never names a step's kpred:step-id, so the step is likely not run
 *                    (the e2e test itself fails on a mismatch in both directions; this is the cheap
 *                    static version that runs without a browser)
 *
 * `--pending-ok` turns no-screenshot from a failure into a loud warning. It exists for the window
 * before the first capture and is not meant to stay: the sweep passes it only until the flagship
 * screenshots are committed (see the job in static/reckons-jobs.ttl).
 *
 * Usage:
 *   npx tsx scripts/offline/test-workflow-check.ts
 *   npx tsx scripts/offline/test-workflow-check.ts --pending-ok
 *   npx tsx scripts/offline/test-workflow-check.ts --json
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT, loadWorkflowsFromFile, screenshotFile, type Workflow } from '../lib/test-workflow.js';

export interface Finding {
  rule: 'no-screenshot' | 'missing-file' | 'not-webp' | 'no-test-file' | 'step-not-in-test';
  workflow: string;
  step?: string;
  message: string;
}

/** Pure, so a test can run it on synthetic workflows with an injected file-exists and file reader. */
export function checkWorkflows(
  workflows: Workflow[],
  fileExists: (sitePath: string) => boolean,
  testExists: (repoPath: string) => boolean,
  readTest: (repoPath: string) => string,
): Finding[] {
  const out: Finding[] = [];
  for (const w of workflows) {
    const testOk = testExists(w.testFile);
    if (!testOk) {
      out.push({ rule: 'no-test-file', workflow: w.id, message: `${w.testFile} does not exist` });
    }
    const testText = testOk ? readTest(w.testFile) : '';
    for (const s of w.steps) {
      if (testOk && !testText.includes(`'${s.id}'`) && !new RegExp(`\\b${s.id}\\s*:`).test(testText)) {
        out.push({ rule: 'step-not-in-test', workflow: w.id, step: s.id,
          message: `${w.testFile} never names step "${s.id}"` });
      }
      if (!s.screenshot) {
        out.push({ rule: 'no-screenshot', workflow: w.id, step: s.id,
          message: `step ${s.order} "${s.title}" has no screenshot (npm run workflow:shots)` });
        continue;
      }
      if (!s.screenshot.endsWith('.webp')) {
        out.push({ rule: 'not-webp', workflow: w.id, step: s.id, message: `${s.screenshot} is not a .webp` });
      }
      if (!fileExists(s.screenshot)) {
        out.push({ rule: 'missing-file', workflow: w.id, step: s.id,
          message: `${s.screenshot} is linked but static${s.screenshot} does not exist` });
      }
    }
  }
  return out;
}

function main(): void {
  const pendingOk = process.argv.includes('--pending-ok');
  const asJson = process.argv.includes('--json');
  const workflows = loadWorkflowsFromFile();
  const findings = checkWorkflows(
    workflows,
    (p) => existsSync(screenshotFile(p)),
    (p) => existsSync(join(ROOT, p)),
    (p) => readFileSync(join(ROOT, p), 'utf8'),
  );
  const failing = findings.filter((f) => !(pendingOk && f.rule === 'no-screenshot'));
  const steps = workflows.reduce((n, w) => n + w.steps.length, 0);

  if (asJson) {
    console.log(JSON.stringify({ workflows: workflows.length, steps, findings, failing: failing.length }, null, 2));
  } else {
    console.log(`Test workflows: ${workflows.length} workflow(s), ${steps} step(s).`);
    for (const f of findings) {
      const soft = pendingOk && f.rule === 'no-screenshot';
      console.log(`  ${soft ? 'pending' : 'FAIL   '} [${f.rule}] ${f.workflow}${f.step ? '/' + f.step : ''}: ${f.message}`);
    }
    if (!findings.length) console.log('  every step has a screenshot and every linked file exists.');
    else if (!failing.length) console.log(`  ${findings.length} step(s) still have no screenshot (--pending-ok): this is NOT a pass for the screenshots, only for everything else.`);
  }
  process.exit(failing.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
