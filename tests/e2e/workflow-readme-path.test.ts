import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import type { Workflow } from '../../scripts/lib/test-workflow';

/**
 * THE FLAGSHIP TEST WORKFLOW (F34.2) — the README's own path: add a source, review the proposed
 * claims, see them in a space, ask for a reckoning.
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are read from the ktype:TestStep triples in
 * static/docs-testing.ttl, the same list that draws the diagram and the step sections of the
 * /docs/testing/workflow-readme-path page. This file only supplies what each step DOES, keyed by
 * the step's kpred:step-id, and the test fails in both directions: a step in the graph with no
 * implementation here, or an implementation here with no step in the graph. So the page cannot show
 * a step this test does not run, and this test cannot run a step the page does not show.
 *
 * It also runs the checks the page promises ("What the test checks"). It is mock-backend only
 * (no keys), like workflow-add-review-reckon.test.ts, which it complements by adding the Spaces
 * step; that older test is left in place.
 *
 * CAPTURE MODE. With WORKFLOW_CAPTURE_DIR set (by `npm run workflow:shots`, which then compresses
 * the PNGs to WebP and links them from the steps), each step also draws a labelled box round its
 * target with the F34 harness and saves a screenshot. Without it the boxes are never drawn, so a
 * normal CI run costs nothing extra.
 */

const WORKFLOW_ID = 'readme-path';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

// Read through tsx, not imported: Playwright's loader cannot load the n3 parser (see
// scripts/workflow-steps.ts), and this keeps the graph the only place the steps are written.
const workflows = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts'], { encoding: 'utf8' }),
) as Workflow[];
const workflow = workflows.find((w) => w.id === WORKFLOW_ID);
if (!workflow) throw new Error(`No TestWorkflow with kpred:workflow-id "${WORKFLOW_ID}" in static/docs-testing.ttl`);

/** Draws the labelled box and saves a PNG when capturing; does nothing otherwise. */
type Snap = (target: Locator) => Promise<void>;
type StepImpl = (page: Page, snap: Snap) => Promise<void>;

const SITUATION = 'I am choosing between Company Alpha and Company Beta as a battery-software vendor.';
const TARGET = 'Pick the vendor that best fits a long-term, scalable battery-software partnership.';

/** Synthetic note text typed by the test; no real data is involved at any point. */
const NOTE_TITLE = 'Company Alpha';
const NOTE_BODY =
  'Company Alpha has 50 employees, was founded in 2020 by Jane Doe in Seattle, and makes battery software.';

const impls: Record<string, StepImpl> = {
  'add-source': async (page, snap) => {
    await page.goto('/ingest');
    await page.getByPlaceholder(/what is this about/i).first().fill(NOTE_TITLE);
    await page.locator('textarea').first().fill(NOTE_BODY);
    const submit = page.getByRole('button', { name: /extract facts/i });
    await expect(submit).not.toBeDisabled({ timeout: 5_000 });
    await snap(submit);
    await submit.click();
    await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 30_000 });
  },

  'review-claims': async (page, snap) => {
    await page.goto('/review');
    const claim = page.getByText(/company.alpha|employee|2020|seattle/i).first();
    await expect(claim).toBeVisible({ timeout: 8_000 });
    // For the picture, box the claim as the review card shows it (the mock backend's claims read
    // "<source> contains-text ..."); the first text match can be a node label in the graph behind.
    const card = page.getByText(/contains-text/).first();
    await snap((await card.count()) ? card : claim);
  },

  'confirm-claims': async (page, snap) => {
    await page.goto('/review');
    const confirm = () => page.getByRole('button', { name: /confirm|✓|accept/i }).first();
    await expect(confirm()).toBeVisible({ timeout: 8_000 });
    await snap(confirm());
    for (let i = 0; i < 40; i++) {
      if (!(await confirm().count()) || !(await confirm().isVisible().catch(() => false))) break;
      await confirm().click().catch(() => {});
      await page.waitForTimeout(250);
    }
    // Nothing is left waiting: the queue was settled by hand, one claim at a time.
    await expect(confirm()).toHaveCount(0, { timeout: 8_000 });
  },

  'see-in-space': async (page, snap) => {
    await page.goto('/kb');
    // The space holding the confirmed claims reports how many facts it now contains.
    const summary = page.getByText(/\d+ entities · \d+ facts/).first();
    await expect(summary).toBeVisible({ timeout: 8_000 });
    const facts = Number(/(\d+) facts/.exec((await summary.textContent()) ?? '')?.[1] ?? 0);
    expect(facts, 'the confirmed claims should be facts in the space').toBeGreaterThan(0);
    await snap(summary);
  },

  reckoning: async (page, snap) => {
    await page.goto('/reckoning');
    const situation = page.getByPlaceholder(/evaluating|situation/i).first();
    await expect(situation).toBeVisible({ timeout: 8_000 });
    await situation.fill(SITUATION);
    await expect(page.locator('.btn-next')).toBeEnabled({ timeout: 5_000 });
    await page.locator('.btn-next').click();
    const target = page.getByPlaceholder(/choose|achieve|minimis/i).first();
    await expect(target).toBeVisible({ timeout: 5_000 });
    await target.fill(TARGET);
    await expect(page.locator('.btn-next')).toBeEnabled({ timeout: 5_000 });
    await page.locator('.btn-next').click();
    const reckon = page.locator('.btn-reckon');
    await expect(reckon).toBeVisible({ timeout: 5_000 });
    await reckon.click();
    // A proposal (a working model) OR a handled error (CI has no chat model): both prove the
    // request was accepted and the page resolved. The wording of a proposal is not judged here.
    const outcome = page.getByRole('heading', { name: /proposal/i })
      .or(page.getByText(/verified statements/i))
      .or(page.locator('.error-msg'))
      .first();
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await snap(outcome);
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
});

test('the steps in the graph and the steps this test runs are the same list', () => {
  const inGraph = workflow.steps.map((s) => s.id).sort();
  const implemented = Object.keys(impls).sort();
  expect(implemented, 'every TestStep needs an implementation here, and every implementation a TestStep')
    .toEqual(inGraph);
});

test(`${workflow.title}`, async ({ page }) => {
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const step of workflow.steps) {
    await test.step(`${step.order}. ${step.title} (${step.page})`, async () => {
      const snap: Snap = async (target) => {
        if (!CAPTURE_DIR) return;
        // Bring the target to the middle of the screen (clear of the floating nav bar) and let the
        // page's fade-in finish, or the box lands where the element WAS and the picture is dim.
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(900);
        const cleanup = await boxTarget(page, target, step.boxLabel);
        const png = await page.screenshot({ fullPage: false });
        await cleanup();
        writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
      };
      await impls[step.id](page, snap);
    });
  }
});
