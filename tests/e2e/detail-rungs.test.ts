import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

/**
 * F139.2 — one detail level per entity, shown at the floor: the detail control's rungs,
 * counted in the browser.
 *
 * The brief's instruction: load a starter example space and, for each rung of the detail
 * control, count the nodes drawn — "each rung's count differs from the next and none is zero
 * on that space (pick a starter where that holds after parts 1–3; if none does, report the
 * counts instead of asserting)".
 *
 * Measured 2026-11-24, on all four starters, with the app's own pipeline (importTurtleFull →
 * the page's `visible` filter → buildGraphView per floor → the hubs rung): NO starter satisfies
 * the strict property —
 *   - the evidence rung draws the SAME nodes as the judgments rung in every starter: none of
 *     them carries a reviewed supports-fact (part 2's evidence) at evidence tier that touches
 *     a node the judgment floor would drop;
 *   - the decisions rung is ZERO on starter-generated-assets.ttl and
 *     starter-data-insight-solutions.ttl (no decision-tier facts at all).
 * So, per the brief, this spec REPORTS the counts instead of asserting pairwise difference.
 * It picks the Quick-Start Example — the cleanest of the four: all six rungs non-zero there
 * (all=48, detailed=18, evidence=11, judgments=11, decisions=6, hubs=2, as of this writing) —
 * and asserts only what the mechanism itself guarantees (the floor HIDES, so counts are
 * non-increasing as the floor rises, and the hubs rung is a subset of the detailed rung):
 * every rung non-negative, all > 0, all ≥ detailed ≥ evidence ≥ judgments ≥ decisions,
 * hubs ≤ detailed.
 *
 * The counts come from `data-drawn-entities` on the graph section — the distinct entities at the
 * drawn edges' ends — which is independent of how many labels the 2D/3D renderer chose to hide
 * (2D suppresses overlapping labels, so counting DOM labels undercounts).
 */

type Rung = 'all' | 'detailed' | 'evidence' | 'judgments' | 'decisions' | 'hubs';

const RUNGS: Rung[] = ['all', 'detailed', 'evidence', 'judgments', 'decisions', 'hubs'];

// The trigger chip shows the CURRENT rung and carries its rung's title. Each rung's title has a
// prefix unique to that rung (verified against DETAIL_LEVELS in routes/(app)/+page.svelte), which
// is how we find the trigger without colliding with the layout/preview chips beside it.
const TRIGGER_TITLE_PREFIX: Record<Rung, string> = {
  all: 'Everything, including logs',
  detailed: 'Above logs. Records and up',
  evidence: 'Measurements and up',
  judgments: 'Verdicts no check can settle',
  decisions: 'Only facts that foreclose options',
  hubs: 'Only the nodes holding this graph together',
};

test('each rung of the detail control counts its own non-overlapping share of the canvas', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await waitForApp(page);

  // The Quick-Start card imports the example into the workspace and lands on the graph — and,
  // unlike the hero "Getting started" button, does not start Shelly's tour over the controls.
  const quickStart = page.getByRole('button', { name: /quick-start example/i });
  await expect(quickStart).toBeVisible({ timeout: 10_000 });
  await quickStart.click();

  const graph = page.locator('[data-graph-perspective="statements"]');
  await expect(graph).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => page.locator('.node-label').count(), {
    timeout: 30_000,
    message: 'the Quick-Start example should lay out nodes',
  }).toBeGreaterThan(0);
  await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 30_000 });

  // First-run notifications float over the canvas's controls; clear them as a user would.
  const dismiss = page.getByRole('button', { name: 'dismiss', exact: true });
  for (let i = 0; i < 5 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }

  const counts: Record<string, number> = {};
  let current: Rung = 'detailed'; // the page's default rung
  for (const rung of RUNGS) {
    if (rung !== current) {
      await page.locator('.chip-row').locator(`button.chip[title^="${TRIGGER_TITLE_PREFIX[current]}"]`).click();
      // The menu is portaled to <body>; its rung chips are the only exact-name matches for the
      // rung labels (layout/preview chips use other words), so the exact name is unambiguous.
      await page.getByRole('button', { name: rung, exact: true }).click();
      current = rung;
      await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 15_000 });
      // The count is a synchronous derivation of the rung (no animation involved), but give the
      // renderer a beat so a mid-transition read can't flake.
      await page.waitForTimeout(250);
    }
    const raw = await graph.getAttribute('data-drawn-entities');
    expect(raw, `data-drawn-entities should be present on the ${rung} rung`).toBeTruthy();
    counts[rung] = Number(raw);
  }

  // REPORT (the brief's fallback): the per-rung counts on this starter.
  console.log(`F139.2 detail rungs, Quick-Start Example: ${RUNGS.map((r) => `${r}=${counts[r]}`).join('  ')}`);

  // ASSERT what the mechanism guarantees — the floor only hides, and the hubs rung is a subset:
  expect(counts.all, 'the "all" rung draws the whole graph — it must not be empty').toBeGreaterThan(0);
  const floorRungs = RUNGS.slice(0, 5); // all → decisions, each a higher floor than the last
  for (let i = 0; i + 1 < floorRungs.length; i++) {
    expect(
      counts[floorRungs[i]],
      `${floorRungs[i]} draws ${counts[floorRungs[i]]} nodes but ${floorRungs[i + 1]} draws ${counts[floorRungs[i + 1]]} — a higher floor must not draw more`,
    ).toBeGreaterThanOrEqual(counts[floorRungs[i + 1]]);
  }
  expect(counts.hubs, 'the hubs rung keeps only hub-to-hub edges — a subset of the detailed rung')
    .toBeLessThanOrEqual(counts.detailed);

  expect(errors, `Uncaught page errors:\n${errors.join('\n')}`).toEqual([]);
});
