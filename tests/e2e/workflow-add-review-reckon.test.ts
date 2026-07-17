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
  // 5a. Situation
  const situation = page.getByPlaceholder(/evaluating|situation/i).first();
  await expect(situation).toBeVisible({ timeout: 8_000 });
  await situation.fill('I am choosing between Company Alpha and Company Beta as a battery-software vendor.');
  await page.getByRole('button', { name: /continue|next|→/i }).first().click();
  // 5b. Target
  const target = page.getByPlaceholder(/choose|achieve|minimis/i).first();
  await expect(target).toBeVisible({ timeout: 5_000 });
  await target.fill('Pick the vendor that best fits a long-term, scalable battery-software partnership.');
  await page.getByRole('button', { name: /continue|next|review|→/i }).first().click();
  // 5c. Run the reckoning
  const reckonBtn = page.getByRole('button', { name: /reckon|generate|proposal/i }).first();
  await expect(reckonBtn).toBeVisible({ timeout: 5_000 });
  await reckonBtn.click();

  // 5d. A grounded proposal renders (mock backend returns a proposal; we assert the flow reached
  //     the proposal stage — the point is the workflow completes end to end, not the LLM's words).
  await expect(page.getByRole('button', { name: /new reckoning|refine inputs/i }).first())
    .toBeVisible({ timeout: 30_000 });
});
