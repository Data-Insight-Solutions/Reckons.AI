import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp, modelPromptsDismissed } from './helpers';
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
 * It also runs the checks the page promises ("What the test checks"), and each step boxes the same
 * control or result that its check asserts on, so the box, the words and the assertion all
 * describe one thing. It is mock-backend only (no keys), like workflow-add-review-reckon.test.ts,
 * which it complements by adding the Spaces step; that older test is left in place.
 *
 * EVERY STEP RUNS ON THE GETTING STARTED SPACE (synthetic: Alex and Jordan's camping weekend), loaded
 * the way a first-time visitor loads it, so the screenshots show real-looking content instead of a
 * throwaway test note. Two things are scripted stand-ins for a language model and the page says so:
 * the note typed in step 1 is read by the mock extractor (its claims are placeholders), and the
 * reckoning in step 5 is a fixed reply (SCRIPTED_RECKONING).
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

const SITUATION = 'Alex and Jordan are choosing between Lake George and Oh! Ridge for a camping weekend.';
const TARGET = 'Pick the campground that keeps two nights inside the $60 budget.';

/** Synthetic note text typed by the test; no real data is involved at any point. */
const NOTE_TITLE = 'Camping trip plan';
const NOTE_BODY =
  'Alex and Jordan are camping near Lake George for two nights. The budget is about 80 dollars.';

/**
 * A scripted reply for the mock chat backend (src/lib/integrations/llm/turtle-chat.ts reads
 * globalThis.__RECKONS_MOCK_REPLY__, and only when the provider is `mock`). It is written to read
 * like a real reckoning about the Getting started space's own sample notes, so the screenshot shows
 * what a reckoning looks like rather than the mock's placeholder line. It is a SCRIPTED response,
 * not a model's: the page that shows this screenshot says so.
 */
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

/**
 * Adding a note to a space that already holds facts makes the app offer to download its matching
 * model; the test declines (nothing is downloaded) and carries on. Safe to call when absent.
 */
async function declineModelDownload(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^not now$/i }).click({ timeout: 700 }).catch(() => {});
}

/**
 * Review works without a model: the person decides each claim. Entering it must not raise the
 * model-download prompt (MATT, 2026-10-13); the shared dismisser counts any it had to close.
 */
async function expectNoModelPrompt(page: Page): Promise<void> {
  // Relative to what the Add step already dismissed (ingest legitimately asks for a model).
  const before = modelPromptsDismissed(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.consent-dialog')).toHaveCount(0);
  expect(modelPromptsDismissed(page), 'entering Review must not prompt for a model download').toBe(before);
}

/** The first claim card on the Review page that is still waiting for a decision. */
const waitingCard = (page: Page) =>
  page.locator('.entry').filter({ has: page.getByRole('button', { name: /^accept$/i }) }).first();

/** How many facts the card for the current space says it holds, on the Spaces page. */
async function currentSpaceFacts(page: Page): Promise<number> {
  await page.goto('/kb');
  const space = page.locator('.kb-entry.current').first();
  await expect(space).toBeVisible({ timeout: 8_000 });
  await expect(space).toContainText(/[\d,]+ facts?/i, { timeout: 8_000 });
  return Number(/([\d,]+) facts?/.exec((await space.textContent()) ?? '')?.[1]?.replace(/,/g, '') ?? 0);
}

/** Facts in the space before any claim is confirmed (set once the Getting started space has loaded). */
let factsBefore = 0;

const impls: Record<string, StepImpl> = {
  'add-source': async (page, snap) => {
    await page.goto('/ingest');
    await page.getByPlaceholder(/what is this about/i).first().fill(NOTE_TITLE);
    await page.locator('textarea').first().fill(NOTE_BODY);
    const submit = page.getByRole('button', { name: /extract facts/i });
    await expect(submit).not.toBeDisabled({ timeout: 5_000 });
    await snap(submit);
    await submit.click();
    const deadline = Date.now() + 30_000;
    while (new URL(page.url()).pathname.startsWith('/ingest') && Date.now() < deadline) {
      await declineModelDownload(page);
      await page.waitForTimeout(500);
    }
    expect(new URL(page.url()).pathname, 'reading finishes and leaves the Add page').not.toMatch(/^\/ingest/);
  },

  'review-claims': async (page, snap) => {
    await page.goto('/review');
    await expectNoModelPrompt(page);
    const card = waitingCard(page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    // The card is the thing the step is about: it names its source, shows the passage the claim
    // came from, and offers all three decisions.
    for (const name of [/^accept$/i, /^refine$/i, /^reject$/i]) {
      await expect(card.getByRole('button', { name })).toBeVisible();
    }
    await snap(card);
  },

  'confirm-claims': async (page, snap) => {
    await page.goto('/review');
    await expectNoModelPrompt(page);
    const accept = () => page.getByRole('button', { name: /^accept$/i }).first();
    await expect(accept()).toBeVisible({ timeout: 10_000 });
    await snap(accept());
    for (let i = 0; i < 40; i++) {
      if (!(await accept().count()) || !(await accept().isVisible().catch(() => false))) break;
      await accept().click().catch(() => {});
      await page.waitForTimeout(250);
    }
    // Nothing is left waiting: the queue was settled by hand, one claim at a time.
    await expect(accept()).toHaveCount(0, { timeout: 8_000 });
  },

  'see-in-space': async (page, snap) => {
    // The card for the space you are in: it says "current" and how many facts it now holds.
    const facts = await currentSpaceFacts(page);
    const space = page.locator('.kb-entry.current').first();
    await expect(space).toContainText(/current/i);
    expect(facts, 'the confirmed claims should be facts added to the space').toBeGreaterThan(factsBefore);
    await snap(space);
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
    // The scripted reply comes back as a proposal card that says how many facts it rests on.
    const proposal = page.locator('.proposal-card');
    await expect(proposal).toBeVisible({ timeout: 20_000 });
    await expect(proposal).toContainText(/based on \d+ verified statements/i);
    await expect(proposal).toContainText(/oh! ridge/i);
    await snap(proposal);
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((reply) => {
    (globalThis as { __RECKONS_MOCK_REPLY__?: string }).__RECKONS_MOCK_REPLY__ = reply;
  }, SCRIPTED_RECKONING);
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
