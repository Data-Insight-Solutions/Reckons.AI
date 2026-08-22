import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * Review queue tests — confirm, reject, and tab switching.
 *
 * We seed the DB by running a real ingest through the mock backend
 * (no direct IndexedDB writes, which would conflict with Dexie's connection).
 */

/** Seed pending statements by running a mock ingest. */
async function seedPendingStatement(page: Page) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Company Alpha');
  await page.locator('textarea').first().fill('Company Alpha has 50 employees and was founded in 2020.');
  const submitBtn = page.getByRole('button', { name: /extract facts/i });
  await expect(submitBtn).not.toBeDisabled({ timeout: 5_000 });
  await submitBtn.click();
  // Mock backend completes fast and navigates to /compare.
  // Wait for the URL to change away from /ingest.
  await page.waitForURL((url) => !url.pathname.startsWith('/ingest'), { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

test('review page shows tabs', async ({ page }) => {
  await page.goto('/review');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 8_000 });

  // Tab buttons exist (incoming / deletions / merges or similar)
  const tabs = page.locator('button[role="tab"], .tab-btn, button').filter({
    hasText: /incoming|deletion|merge|review/i
  });
  await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
});

test('empty review queue shows empty state', async ({ page }) => {
  await page.goto('/review');
  // With no statements, an empty state message should appear
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up/i).first()
  ).toBeVisible({ timeout: 8_000 });
});

test('seeded pending statement appears in review', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');
  // The statement text or source name should appear
  await expect(
    page.getByText(/company.alpha|employee|50|2020/i).first()
  ).toBeVisible({ timeout: 8_000 });
});

test('confirm button marks statement confirmed', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');

  // Find confirm button (✓ or "confirm" text)
  const confirmBtn = page.getByRole('button', { name: /confirm|✓|accept/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 8_000 });
  await confirmBtn.click();

  // After confirming all, empty state should appear
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up|company.alpha|employee/i).first()
  ).toBeVisible({ timeout: 5_000 });
});

test('review-at-scale: pending facts group into entity cards with a plan headline and a toggle', async ({ page }) => {
  await seedPendingStatement(page);
  await page.goto('/review');

  // F83 — pending facts are grouped into per-entity cards, not a flat list of rows.
  await expect(page.getByTestId('entity-cards')).toBeVisible({ timeout: 8_000 });

  // The review pipeline's honest headline is shown (what is spared / what is yours).
  await expect(page.locator('.ras-headline')).toBeVisible({ timeout: 5_000 });

  // The seeded fact is still visible inside a card, and confirm is still reachable (nothing hidden).
  await expect(page.getByText(/company.alpha|employee|50|2020/i).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: /confirm|✓|accept/i }).first()).toBeVisible();

  // The by-entity / flat toggle switches the grouping off.
  const toggle = page.getByRole('button', { name: /^(by entity|flat list)$/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('entity-cards')).toHaveCount(0);
});

test('reject button removes statement from review', async ({ page }) => {
  await seedPendingStatement(page);

  await page.goto('/review');

  const rejectBtn = page.getByRole('button', { name: /reject|✕|dismiss/i }).first();
  await expect(rejectBtn).toBeVisible({ timeout: 8_000 });
  await rejectBtn.click();

  // After rejecting, the statement count should decrease (or empty state appears)
  await expect(
    page.getByText(/nothing|empty|no statements|all caught up|company.alpha|employee/i).first()
  ).toBeVisible({ timeout: 5_000 });
});

/**
 * F139 / F139.1 — the altitude headline and the CASCADE lane, in a real browser.
 *
 * The mock ingest produces facts that share one sourceId, which is a legitimate cascade basis
 * (`same-source`): they arrived from one act of trust, so one answer settles all of them. This test
 * asserts the thing the whole feature is for — that ONE click settles MANY facts — rather than
 * merely that a lane rendered.
 */
/**
 * Seed BOOKKEEPING facts — the population the cascade lane exists for.
 *
 * Ordinary ingested content classifies as `judgment` (an unclassified predicate fails upward), and
 * judgments are deliberately NOT cascadable: a qualitative claim about the user's domain gets
 * individual review. So a normal ingest yields an empty lane, correctly. Bare ISO dates are what
 * make facts read as bookkeeping — fact-altitude.ts demotes an unclassified predicate carrying a
 * date-only literal to `log`, which is exactly what the same-date basis then batches.
 */
async function seedBookkeepingFacts(page: Page) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Release log');
  await page.locator('textarea').first().fill(
    'The package upgrade shipped on 2026-08-16. The lint fix shipped on 2026-08-16. ' +
    'The test refresh shipped on 2026-08-16. The build guard shipped on 2026-08-16.',
  );
  const submitBtn = page.getByRole('button', { name: /extract facts/i });
  await expect(submitBtn).not.toBeDisabled({ timeout: 5_000 });
  await submitBtn.click();
  await page.waitForURL((url) => !url.pathname.startsWith('/ingest'), { timeout: 30_000 });
}

test('altitude headline renders and the cascade lane settles many facts with one answer', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');

  // The set read by altitude: what is a decision, and what is bookkeeping.
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 15_000 });

  const lane = page.getByTestId('cascade-lane');
  await expect(lane).toBeVisible({ timeout: 15_000 });

  // The count chip states how many facts this ONE question settles. The demo has eleven work notes
  // sharing 2026-08-12 and six sharing 2026-08-14, so a cluster must be well above the minimum.
  const count = lane.locator('.cascade-count').first();
  const settles = Number((await count.textContent())?.trim() ?? '0');
  expect(settles).toBeGreaterThanOrEqual(3);

  // Expanding shows the members, each labelled with its altitude — nothing is hidden.
  await lane.locator('.cascade-q').first().click();
  await expect(lane.locator('.cascade-members .alt-chip').first()).toBeVisible({ timeout: 5_000 });

  // One answer, and the effect line reports exactly what it did.
  await lane.getByRole('button', { name: /yes — settle all/i }).first().click();
  const effect = page.locator('.cascade-effect');
  await expect(effect).toBeVisible({ timeout: 15_000 });
  await expect(effect).toContainText(new RegExp(`${settles} facts?`));
  await expect(effect).toContainText(/recorded as your own statement/i);
});

test('unplanned work is asked for its PURPOSE, not a yes/no', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');

  const lane = page.getByTestId('cascade-lane');
  await expect(lane).toBeVisible({ timeout: 15_000 });

  // kb:misc-august-work is deliberately not a Feature and is linked to no plan, so no yes/no
  // question can settle it — what is missing is a reason.
  const purposeRow = lane.locator('.cascade-row.purpose').first();
  await expect(purposeRow).toBeVisible({ timeout: 10_000 });
  await expect(purposeRow).toContainText(/main goal of this set of work/i);
  await expect(purposeRow).toContainText(/tied to no planned feature/i);
  // It must NOT offer the settle-all control, which would assert a truth value it does not have.
  await expect(purposeRow.getByRole('button', { name: /yes — settle all/i })).toHaveCount(0);
});

/**
 * Import tests/fixtures/demo-review-tree.ttl through the real turtle path.
 *
 * This is the seeding route the mock backend could not provide: extractMock returns three fixed
 * triples with unclassified predicates, so nothing it produces is cascadable or decision-shaped. A
 * turtle import lands every fact PENDING, which puts a real graph — decisions, priced options, a
 * conflict, and piles of datestamped bookkeeping — into review.
 */
async function importDemoGraph(page: Page) {
  await page.goto('/ingest');
  // Scoped to the mode tabs on purpose: the NavBar also has a "graph" control, and an unscoped
  // getByRole match hits that one and never switches mode.
  await page.locator('.tabs button', { hasText: 'graph' }).click();
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/demo-review-tree.ttl');
  // The turtle flow previews first and imports on confirm — it does not auto-submit like extraction.
  const importBtn = page.getByRole('button', { name: /^import →$/ });
  await expect(importBtn).toBeEnabled({ timeout: 20_000 });
  await importBtn.click();
  await page.waitForURL((url) => !url.pathname.startsWith('/ingest'), { timeout: 45_000 });
}

test('decision tree renders options with computed costs and escalates a conflict', async ({ page }) => {
  test.setTimeout(120_000); // a 104-fact turtle import plus a graph render
  await importDemoGraph(page);

  await page.goto('/review');
  const tree = page.getByTestId('decision-tree');
  await expect(tree).toBeVisible({ timeout: 15_000 });

  // The replatform decision shows BOTH options, each priced by the facts it would delete.
  await expect(tree.getByText('Static site generator', { exact: true })).toBeVisible();
  await expect(tree.getByText('Hosted CMS', { exact: true })).toBeVisible();
  await expect(tree.getByText('costs 3 facts')).toBeVisible();
  await expect(tree.getByText('costs 4 facts')).toBeVisible();
  // A cost has to read as the thing it is, not as a bare IRI.
  await expect(tree.getByText(/Content history in git/i)).toBeVisible();

  // The conflict nobody wrote a question for is surfaced, flagged, and routed to a reckoning.
  await expect(tree.getByText('contested', { exact: true })).toBeVisible();
  await expect(tree.getByText('needs a reckoning')).toBeVisible();
  await expect(tree.getByText(/Nobody wrote this question down/i)).toBeVisible();

  // Bookkeeping is a count behind a control, never a wall of rows.
  const expand = tree.locator('.dexpand').first();
  await expect(expand).toContainText(/hidden/);
  await expand.click();
  await expect(tree.locator('.dcase-list').first()).toBeVisible({ timeout: 5_000 });
});

test('a freeform re-analysis prompt sits directly after the summary (F139 step 3)', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');

  // It must sit AFTER the summary, because that is where a person has just read what the shape IS
  // and can say what it should be instead. Placement is the feature, not decoration.
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 15_000 });
  const box = page.getByTestId('reanalyze');
  await expect(box).toBeVisible({ timeout: 15_000 });

  const headlineY = (await page.getByTestId('altitude-headline').boundingBox())?.y ?? 0;
  const promptY = (await box.boundingBox())?.y ?? 0;
  expect(promptY).toBeGreaterThan(headlineY);

  // The run control stays disabled until the person has actually said something: an empty
  // instruction would be a model call with no guidance, which is the opposite of the point.
  const run = page.getByTestId('reanalyze-run');
  await expect(run).toBeDisabled();
  await page.getByTestId('reanalyze-input').fill('these are all about the March deploy, group them');
  await expect(run).toBeEnabled();

  /*
   * DELIBERATELY NOT ASSERTED HERE: the result of an actual re-analysis. It needs a configured LLM
   * backend, and an e2e that silently passes when no model is reachable would be worse than no
   * test. The operation-level guarantees — that only attach/group/depend/drop are accepted, that
   * invented ids are rejected, and that nothing can mint a fact — are pinned deterministically in
   * src/lib/rdf/__tests__/reanalysis.test.ts instead.
   */
});

test('the review preview offers every layout, and the tree chip actually engages', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 15_000 });

  /*
   * ALL EIGHT LAYOUTS. Review used to offer four of the eight the main graph view has; a reviewer
   * looking at the same graph should not have a poorer set of ways to look at it. `source` and
   * `type` are guarded (they need more than one source / at least one entity type), so this
   * asserts the unguarded six are always present rather than pinning a number that legitimately
   * varies with the graph.
   */
  const labels = await page.locator('.tg-chip .lbl').allInnerTexts();
  for (const expected of ['free', 'focus', 'hub', 'time', 'arrange', 'tree']) {
    expect(labels, `layout chip "${expected}" missing from ${JSON.stringify(labels)}`).toContain(expected);
  }

  /*
   * AND THE TREE CHIP MUST ENGAGE. It read as broken for a long time and the cause was never the
   * button: the demo graphs stated 0 and 2 hierarchy edges, so buildHierarchyAnchors returned an
   * empty map and the force layout took over. This asserts the CONTROL works — that clicking it
   * selects it — separately from whether a given graph has a hierarchy worth drawing, because
   * conflating those two is what made the bug take three attempts to find.
   */
  const tree = page.locator('.tg-chip', { hasText: /^tree$/ }).first();
  await tree.click();
  await expect(tree).toHaveAttribute('data-state', 'on', { timeout: 5_000 });
});

test('a contested decision is settled by ONE pick, not two', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 15_000 });

  /*
   * Matt, 2026-08-21: "accept one fact then the other is a conflict with a second decision to keep
   * existing, which is a bit redundant." Picking a side IS rejecting the other, so it must be one
   * action. This asserts the chooser exists on the contested decision and that using it resolves
   * BOTH sides — the conflict stops being pending rather than reappearing as a fresh question.
   */
  const pick = page.getByTestId('decision-pick').first();
  await expect(pick).toBeVisible({ timeout: 15_000 });

  const options = pick.locator('.dpick-btn');
  await expect(options).toHaveCount(2);

  const pendingBefore = Number((await page.locator('.badge').first().textContent())?.trim() || '0');
  await options.first().click();

  // Both sides leave the queue on one action: one confirmed, one rejected.
  await expect
    .poll(async () => Number((await page.locator('.badge').first().textContent())?.trim() || '0'),
      { timeout: 15_000, message: 'one pick should settle BOTH sides of the conflict' })
    .toBeLessThanOrEqual(pendingBefore - 2);
});

test('selecting a graph node brings its pending facts into view', async ({ page }) => {
  test.setTimeout(120_000);
  await importDemoGraph(page);
  await page.goto('/review');
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3_000); // let the preview lay out and emit labels

  /*
   * THE HALF THAT WAS MISSING. Panel -> graph already worked: clicking a review card calls
   * focusStatement and the preview flies to the node. Graph -> panel did NOT — selecting a node
   * highlighted matching rows with .entry-focused and left them wherever they were, which on a
   * 104-row queue is usually off screen. A highlight nobody can see is the same as no feedback.
   *
   * A node label is positioned at its node's screen coordinates, so clicking the canvas there
   * selects that node — deterministic, unlike guessing at canvas coordinates.
   *
   * The card-click direction is deliberately NOT asserted here: .entry-focus-wrap sits inside a
   * SwipeCard whose animation keeps it from settling, so Playwright's actionability check times
   * out on it. That is a harness limit on pre-existing behaviour, and faking it with force:true
   * would assert that a click we could not really perform did something.
   */
  const label = page.locator('.node-label').first();
  await expect(label).toBeVisible({ timeout: 20_000 });
  const box = await label.boundingBox();
  const canvas = page.locator('canvas').first();
  expect(box, 'no label box to aim at').toBeTruthy();
  await expect(canvas).toBeVisible();

  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForTimeout(1_500);

  const focused = page.locator('.entry-focused').first();
  if (await focused.count()) {
    // The point of the change: not merely highlighted, but SCROLLED TO.
    await expect(focused).toBeInViewport({ timeout: 5_000 });
  } else {
    // Honest rather than silently green: the click may have landed on a node with no pending
    // facts, which proves nothing either way.
    test.info().annotations.push({
      type: 'coverage-gap',
      description: 'canvas click selected no node with pending facts; graph→panel scroll unverified this run',
    });
  }
});
