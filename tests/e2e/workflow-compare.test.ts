import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { demoRecorder, isDemoRender } from './demo-recorder';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * TEST WORKFLOW: COMPARE (F275.22.3) — a new note's claims are laid against the facts a space already
 * holds, labelled, and kept only as the person chooses. It documents the Features page "Compare".
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are the ktype:TestStep triples of test:Workflow-Compare in
 * static/docs-testing.ttl; this file supplies what each step does, keyed by step id, and fails if the
 * two lists differ (the F34.2 pattern, as in workflow-readme-path.test.ts).
 *
 * Mock-backend only, on the synthetic Getting started space. The note is read by the mock extractor,
 * so its claims are placeholders; what is checked is how Compare presents and settles them. Not shown
 * and not claimed: comparing two whole spaces, and the model-written summary (needs a model).
 */

const WORKFLOW_ID = 'compare';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

const NOTE_TITLE = 'Camping trip plan';
const NOTE_BODY =
  'Alex and Jordan are camping near Lake George for two nights. The budget is about 80 dollars.';

/** Adding a note to a space that already holds facts may offer a model download; decline it. */
async function declineModelDownload(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^not now$/i }).click({ timeout: 700 }).catch(() => {});
}

/** How many facts the card for the current space says it holds, on the Spaces page. */
async function currentSpaceFacts(page: Page): Promise<number> {
  await page.goto('/kb');
  const space = page.locator('.kb-entry.current').first();
  await expect(space).toBeVisible({ timeout: 8_000 });
  await expect(space).toContainText(/[\d,]+ facts?/i, { timeout: 8_000 });
  return Number(/([\d,]+) facts?/.exec((await space.textContent()) ?? '')?.[1]?.replace(/,/g, '') ?? 0);
}

let factsBefore = 0;

const impls: Record<string, StepImpl> = {
  'add-note': async (page, snap) => {
    await page.goto('/ingest');
    await page.getByPlaceholder(/what is this about/i).first().fill(NOTE_TITLE);
    await page.locator('textarea').first().fill(NOTE_BODY);
    const submit = page.getByRole('button', { name: /extract facts/i });
    await expect(submit).not.toBeDisabled({ timeout: 5_000 });
    await snap(submit);
    await submit.click();
    const deadline = Date.now() + 30_000;
    while (!new URL(page.url()).pathname.startsWith('/compare') && Date.now() < deadline) {
      await declineModelDownload(page);
      await page.waitForTimeout(500);
    }
    expect(new URL(page.url()).pathname, 'reading finishes and opens Compare').toMatch(/^\/compare/);
  },

  'see-comparison': async (page, snap) => {
    await expect(page.getByRole('heading', { name: /incoming vs\. graph/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.src-label')).toContainText(NOTE_TITLE);
    await expect(page.locator('.summary-row .pill').first()).toBeVisible({ timeout: 10_000 });
    await snap(page.locator('.summary-row'));
  },

  'read-labels': async (page, snap) => {
    const entries = page.locator('.diff-entry');
    await expect(entries.first()).toBeVisible({ timeout: 10_000 });
    expect(await entries.count()).toBeGreaterThan(0);
    await expect(entries.first().locator('.badge')).toContainText(/new|duplicate|reinforces|conflicts|refines/);
    await expect(entries.first().getByRole('button')).toHaveCount(2);
    await snap(page.locator('.diff-list'));
  },

  choose: async (page, snap) => {
    const acceptAll = page.getByRole('button', { name: /^accept all/i });
    await expect(acceptAll).toBeEnabled();
    await snap(page.locator('.actions-row'));
    await acceptAll.click();
    await expect(page.locator('.diff-list .empty')).toContainText(/no pending statements/i, { timeout: 10_000 });
  },

  'see-in-space': async (page, snap) => {
    const facts = await currentSpaceFacts(page);
    const space = page.locator('.kb-entry.current').first();
    await expect(space).toContainText(/current/i);
    expect(facts, 'the accepted claims should be facts added to the space').toBeGreaterThan(factsBefore);
    await snap(space);
  },
};

test.beforeEach(async ({ page }) => {
  if (!isDemoRender()) await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  // Every step runs on the Getting started space, loaded the way a first-time visitor loads it.
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).first().click();
  await page.waitForTimeout(4_000);
  factsBefore = await currentSpaceFacts(page);
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
