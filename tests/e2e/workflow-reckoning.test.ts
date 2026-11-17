import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { demoRecorder, isDemoRender } from './demo-recorder';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * TEST WORKFLOW: RECKONING (F275.22.3) — ask for a reckoning on a space: situation, target, check
 * what it will use, read the proposal. It documents the Learn page "A reckoning".
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are the ktype:TestStep triples of test:Workflow-Reckoning in
 * static/docs-testing.ttl; this file supplies what each step does, keyed by step id, and fails if the
 * two lists differ (the F34.2 pattern, as in workflow-readme-path.test.ts).
 *
 * Mock-backend only, on the synthetic Getting started space (Alex and Jordan's camping weekend).
 * The reply is SCRIPTED (a stand-in for a model), and the page says so. The proposal card shows how
 * many facts it is based on; it does not list the facts behind each option, so this test does not
 * claim that it does.
 */

const WORKFLOW_ID = 'reckoning';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

const SITUATION = 'Alex and Jordan are choosing between Lake George and Oh! Ridge for a camping weekend.';
const TARGET = 'Pick the campground that keeps two nights inside the $60 budget.';

/** A scripted reply for the mock chat backend (read only when the provider is mock). */
const SCRIPTED_RECKONING = [
  'OVERVIEW',
  'Oh! Ridge fits the weekend best. It is open both nights, while Lake George now has only Saturday, and it costs less per night.',
  'Option 1: Book Oh! Ridge for Friday and Saturday',
  'Basis: Oh! Ridge costs $23 a night this season and has the full weekend open.',
  'Consideration: Two nights comes to $46, inside the $60 budget.',
  'Action: Book by Wednesday July 8.',
  'Option 2: Lake George for Saturday only',
  'Basis: Lake George is $28 a night but now has only Saturday night open.',
  'Consideration: One night leaves Friday without a campsite.',
  'Recommendation: Book Oh! Ridge, and keep Lake George as the backup if it opens up.',
  'Confidence: Moderate. The notes may be out of date, so check availability before booking.',
].join('\n');

const impls: Record<string, StepImpl> = {
  'open-reckon': async (page, snap) => {
    await page.goto('/reckoning');
    const situation = page.getByPlaceholder(/evaluating|situation/i).first();
    await expect(situation).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('.empty-kb')).toHaveCount(0);
    await snap(page.locator('section.card').first());
  },

  situation: async (page, snap) => {
    const situation = page.getByPlaceholder(/evaluating|situation/i).first();
    await expect(page.locator('.btn-next')).toBeDisabled();
    await situation.fill(SITUATION);
    await expect(page.locator('.btn-next')).toBeEnabled({ timeout: 5_000 });
    await snap(page.locator('section.card').first());
  },

  target: async (page, snap) => {
    await page.locator('.btn-next').click();
    const target = page.getByPlaceholder(/choose|achieve|minimis/i).first();
    await expect(target).toBeVisible({ timeout: 5_000 });
    await target.fill(TARGET);
    await expect(page.locator('.btn-next')).toBeEnabled({ timeout: 5_000 });
    await snap(page.locator('section.card').nth(1));
  },

  'check-inputs': async (page, snap) => {
    await page.locator('.btn-next').click();
    const confirm = page.locator('.confirm-card');
    await expect(confirm).toBeVisible({ timeout: 5_000 });
    await expect(confirm).toContainText(SITUATION);
    await expect(confirm).toContainText(TARGET);
    await expect(confirm).toContainText(/\d+ facts?/i);
    await expect(page.locator('.btn-reckon')).toBeEnabled();
    await snap(confirm);
  },

  proposal: async (page, snap) => {
    await page.locator('.btn-reckon').click();
    const proposal = page.locator('.proposal-card');
    await expect(proposal).toBeVisible({ timeout: 20_000 });
    await expect(proposal).toContainText(/based on \d+ verified statements/i);
    await expect(proposal).toContainText(/oh! ridge/i);
    await snap(proposal);
  },
};

test.beforeEach(async ({ page }) => {
  if (!isDemoRender()) await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((reply) => {
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
  }, SCRIPTED_RECKONING);
  await clearStorage(page);
  await waitForApp(page);
  // Every step runs on the Getting started space, loaded the way a first-time visitor loads it.
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).first().click();
  await page.waitForTimeout(4_000);
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  const inGraph = workflow.steps.map((s) => s.id).sort();
  const implemented = Object.keys(impls).sort();
  expect(implemented, 'every TestStep needs an implementation here, and every implementation a TestStep').toEqual(inGraph);
});

test(`${workflow.title}`, async ({ page }) => {
  const demo = demoRecorder(page); // F275.3: a no-op unless npm run demo:render is recording
  test.setTimeout(demo.active ? 600_000 : 180_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const step of workflow.steps) {
    await test.step(`${step.order}. ${step.title} (${step.page})`, async () => {
      const snap: Snap = async (target) => {
        await demo.hold(target);
        if (!CAPTURE_DIR) return;
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(900);
        const cleanup = await boxTarget(page, target, step.boxLabel);
        const png = await page.screenshot({ fullPage: false });
        await cleanup();
        writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
      };
      await demo.step(step.id, () => impls[step.id](page, snap));
    });
  }
  demo.finish();
});
