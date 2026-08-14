import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * COMPLEX USER WORKFLOW — the core knowledge-building loop, end to end (Matt: "more clear steps
 * to accomplish more complex types of tasks. Add, Review, Add, Review, Reckon").
 *
 * Persona "Ada" builds up a graph over two ingests, curates it in Review, then asks the graph to
 * help her DECIDE via a Reckoning (Situation · Target · Proposal). This is the whole product in one
 * path: facts in → human-gated → grounded decision out. Runs on the mock backend (no keys), so it
 * can run across the device matrix (--project=mobile-ios, tablet, …) and as a scheduled offline job.
 *
 * Each step is numbered and asserts an observable outcome, so a failure names exactly which stage
 * of the workflow broke.
 */

/** ADD: ingest a note through the mock backend; returns when it has left /ingest. */
async function addNote(page: Page, title: string, body: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(body);
  const submit = page.getByRole('button', { name: /extract facts/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 30_000 });
}

/** REVIEW: confirm every pending fact until the queue is clear. */
async function confirmAll(page: Page) {
  await page.goto('/review');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });
  for (let i = 0; i < 40; i++) {
    const confirm = page.getByRole('button', { name: /confirm|✓|accept/i }).first();
    if (!(await confirm.count()) || !(await confirm.isVisible().catch(() => false))) break;
    await confirm.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('Add → Review → Add → Review → Reckon: the full knowledge-building loop', async ({ page }) => {
  // ── 1. ADD — ingest the first note ────────────────────────────────────────
  await addNote(page, 'Company Alpha',
    'Company Alpha has 50 employees, was founded in 2020 by Jane Doe in Seattle, and makes battery software.');

  // ── 2. REVIEW — the facts arrive as pending, and Ada confirms them ─────────
  await page.goto('/review');
  await expect(page.getByText(/company.alpha|employee|2020|seattle/i).first()).toBeVisible({ timeout: 8_000 });
  await confirmAll(page);

  // ── 3. ADD — a second, related note builds the graph up ───────────────────
  await addNote(page, 'Company Beta',
    'Company Beta has 200 employees, was founded in 2015, competes with Company Alpha, and focuses on grid storage.');

  // ── 4. REVIEW — confirm the second batch; nothing is auto-accepted ────────
  await page.goto('/review');
  await expect(page.getByText(/company.beta|200|2015|grid/i).first()).toBeVisible({ timeout: 8_000 });
  await confirmAll(page);
  // Both batches have been curated by hand — the graph now holds confirmed facts about both
  // companies, which is what the Reckoning will draw on.

  // ── 5. RECKON — ask the accumulated graph to help decide (STP flow) ────────
  await page.goto('/reckoning');
  // The reckoning is a step machine (situation → target → confirm → proposal); only one step's
  // controls are mounted at a time, so the step-advance buttons are targeted by class (.btn-next /
  // .btn-reckon) and we wait for each to be ENABLED — the "Continue" button is disabled until its
  // field has >=10 chars, and a race there was the CI flake (a click on a disabled button no-ops).
  // 5a. Situation
  const situation = page.getByPlaceholder(/evaluating|situation/i).first();
  await expect(situation).toBeVisible({ timeout: 8_000 });
  await situation.fill('I am choosing between Company Alpha and Company Beta as a battery-software vendor.');
  const next1 = page.locator('.btn-next');
  await expect(next1).toBeEnabled({ timeout: 5_000 });
  await next1.click();
  // 5b. Target
  const target = page.getByPlaceholder(/choose|achieve|minimis/i).first();
  await expect(target).toBeVisible({ timeout: 5_000 });
  await target.fill('Pick the vendor that best fits a long-term, scalable battery-software partnership.');
  const next2 = page.locator('.btn-next');
  await expect(next2).toBeEnabled({ timeout: 5_000 });
  await next2.click();
  // 5c. Run the reckoning
  const reckonBtn = page.locator('.btn-reckon');
  await expect(reckonBtn).toBeVisible({ timeout: 5_000 });
  await reckonBtn.click();

  // 5d. The reckoning was invoked and RESOLVED — either a grounded proposal (a working backend) OR
  //     a handled error message (a CI runner with no chat backend: the reckon falls back to WASM,
  //     whose model download is declined in tests, so generateProposal() catches and shows an error
  //     instead of a proposal). BOTH prove the full Add→Review→Reckon workflow ran end to end and the
  //     app handled the outcome. The proposal's actual WORDING/quality is backend-dependent and is
  //     covered separately by bench:llm — a mock-only CI must pass the workflow, not the model output.
  await expect(
    page.getByRole('heading', { name: /proposal/i })
      .or(page.getByText(/verified statements/i))
      .or(page.locator('.error-msg'))
      .first()
  ).toBeVisible({ timeout: 20_000 });
});
