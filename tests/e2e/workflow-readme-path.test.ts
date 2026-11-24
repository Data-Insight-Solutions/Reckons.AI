import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { clearStorage, waitForApp, modelPromptsDismissed } from './helpers';
import { boxTarget } from '../visual/workflow-harness';
import { playStory, type StepException } from './story-runner';
import type { UnifiedStory } from '../../src/lib/rdf/story-steps';

/**
 * THE FLAGSHIP TEST WORKFLOW (F34.2) — the README's own path: add a source, review the proposed
 * claims, see them in a space, ask for a reckoning.
 *
 * F300.5: THE STEPS ARE THE STORY story:everyday-readme-path INSIDE the Getting started space
 * (hand-written in static/starter-everyday.ttl; scripts/starter/build-everyday.ts carries it into the served
 * static/starter-everyday-reviewed.ttl). static/docs-testing.ttl keeps a pointer to it, and this file plays it
 * (playStory), so the docs page, this test and the demo video are the same list. The reckoning step follows the
 * Reckoning flow (situation, target, generate a proposal written into the space), not the old single prompt.
 *
 * It is mock-backend only (no keys). EVERY STEP RUNS ON THE GETTING STARTED SPACE (synthetic: Alex and Jordan's
 * camping weekend), loaded the way a first-time visitor loads it. Two things are scripted stand-ins for a language
 * model and the page says so: the note typed in step 1 is read by the mock extractor (placeholder claims), and the
 * proposal in step 5 is a fixed reply (mockProposalReply, chosen by the situation sentence).
 *
 * CAPTURE MODE. With WORKFLOW_CAPTURE_DIR set (by `npm run workflow:shots`), each step also draws a labelled box
 * round its target with the F34 harness and saves a screenshot. Without it the boxes are never drawn.
 */

const WORKFLOW_ID = 'readme-path';
const CAPTURE_DIR = process.env.WORKFLOW_CAPTURE_DIR ?? '';

const story = JSON.parse(
  execFileSync('npx', ['tsx', 'scripts/workflow-steps.ts', `--story=${WORKFLOW_ID}`], { encoding: 'utf8' }),
) as UnifiedStory;

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

/**
 * NAMED EXCEPTIONS (F300.3). Step 1 declares its typing and pressing; the rest are code, each with its reason:
 *   - add-source: the app may offer to download its model once the note is read, which the test declines, and the
 *     page leaving the Add tab is a URL, not an element a test id names.
 *   - review-claims and confirm-claims: a claim card and its accept, refine and reject buttons are found by role and
 *     name (they carry no test id), and settling claims is a loop until none is left waiting.
 *   - see-in-space: the current space's card is found by class, and its fact count is compared with the count before
 *     any claim was confirmed, a number read at run time.
 *   - reckoning: the situation is typed and sent by the story; the target's kind ("Write the outcome") is a radio found
 *     by its label and the outcome sentence a textarea found by its placeholder, neither with a test id.
 */
const exceptions: Record<string, StepException> = {
  'add-source': {
    why: 'declining the model offer and the page leaving the Add tab are not expectation kinds',
    perform: async (page) => {
      const deadline = Date.now() + 30_000;
      while (new URL(page.url()).pathname.startsWith('/ingest') && Date.now() < deadline) {
        await declineModelDownload(page);
        await page.waitForTimeout(500);
      }
      expect(new URL(page.url()).pathname, 'reading finishes and leaves the Add page').not.toMatch(/^\/ingest/);
    },
  },

  'review-claims': {
    why: 'a claim card and its three buttons are found by role and name',
    perform: async (page, snap) => {
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
  },

  'confirm-claims': {
    why: 'the accept buttons are found by role and settled in a loop until none is left waiting',
    perform: async (page, snap) => {
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
  },

  'see-in-space': {
    why: 'the current space card is found by class and its fact count is compared with a number read earlier',
    perform: async (page, snap) => {
      // The card for the space you are in: it says "current" and how many facts it now holds.
      const space = page.locator('.kb-entry.current').first();
      await expect(space).toBeVisible({ timeout: 8_000 });
      await expect(space).toContainText(/[\d,]+ facts?/i, { timeout: 8_000 });
      await expect(space).toContainText(/current/i);
      const facts = Number(/([\d,]+) facts?/.exec((await space.textContent()) ?? '')?.[1]?.replace(/,/g, '') ?? 0);
      expect(facts, 'the confirmed claims should be facts added to the space').toBeGreaterThan(factsBefore);
      await snap(space);
    },
  },

  reckoning: {
    why: 'the target kind is a radio found by its label and the outcome a textarea found by its placeholder',
    perform: async (page) => {
      await page.getByLabel('Write the outcome').check();
      await page.getByPlaceholder(/choose|achieve|minimis/i).first().fill('Pick the campground that keeps two nights inside the $60 budget.');
      await expect(page.getByTestId('target-next')).toBeEnabled({ timeout: 5_000 });
      await page.getByTestId('target-next').click();
      await page.getByTestId('generate-proposal').click();
      await expect(page.getByTestId('proposal-written')).toBeVisible({ timeout: 20_000 });
    },
  },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
  // Every step runs on the Getting started space, loaded the way a first-time visitor loads it.
  await page.goto('/');
  await page.getByRole('button', { name: /getting started/i }).first().click();
  await page.waitForTimeout(4_000);
  factsBefore = await currentSpaceFacts(page);
});

test('every named exception belongs to a step of the story', () => {
  const inGraph = new Set(story.steps.map((st) => st.id));
  for (const id of Object.keys(exceptions)) expect(inGraph.has(id), `exception "${id}" names no step in the story`).toBe(true);
  for (const st of story.steps) expect(st.actions.length > 0 || exceptions[st.id], `step "${st.id}" declares nothing and has no named exception`).toBeTruthy();
});

test(`${story.label}`, async ({ page }) => {
  test.setTimeout(180_000);
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
  const outcomes = await playStory(page, story, {
    exceptions,
    onSnap: async (step, target) => {
      if (!CAPTURE_DIR) return;
      const shotPage = target.page();
      // Bring the target to the middle of the screen (clear of the floating nav bar) and let the
      // page's fade-in finish, or the box lands where the element WAS and the picture is dim.
      await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shotPage.waitForTimeout(900);
      const cleanup = await boxTarget(shotPage, target, step.target?.label ?? step.title);
      const png = await shotPage.screenshot({ fullPage: false });
      await cleanup();
      writeFileSync(join(CAPTURE_DIR, `${String(step.order).padStart(2, '0')}-${step.id}.png`), png);
    },
  });
  expect(outcomes.map((o) => o.id), 'the runner played every step of the story, in order').toEqual(story.steps.map((st) => st.id));
});
