/**
 * A FILTER IS A LENS, NOT A DELETION.
 *
 * Filtering used to splice statements out of the array feeding buildGraphView, so the
 * filtered nodes never reached the force simulation: d3 re-solved a DIFFERENT graph, and
 * filtering to zero matches emptied the set entirely — which tripped the
 * `visible.length === 0` branch and drew the MARKETING LANDING PAGE over the user's graph.
 *
 * Now every node stays in the simulation and the unmatched ones render at GHOST_ALPHA.
 *
 * WHAT THIS TEST DOES NOT ASSERT, AND WHY:
 * The obvious test — "the surviving nodes do not move when you filter" — is not
 * measurable here. The force simulation never converges: nodes drift continuously, and a
 * control measurement (no filter touched, 2.5s apart) showed 234 of 336 nodes moving more
 * than 12px on their own. Any position-invariance assertion would be measuring simulation
 * noise, and would fail whether or not the code was correct. Asserting it anyway would be
 * a test that lies. What IS observable is node RETENTION and node GHOSTING, which is the
 * substance of the fix, so that is what is asserted.
 */
import { test, expect } from '@playwright/test';
import { clearAllKbs, importKbFromTtl } from '../kb-seed';

const APP = 'http://localhost:5174';

/** The import helper lands on /ingest and reloads there; the graph lives on `/`. */
async function openGraph(page: import('@playwright/test').Page) {
  await page.goto(APP);
  await page.waitForSelector('.node-label', { timeout: 20_000 });
  await page.waitForTimeout(6000); // let the layout spread out
}

async function graphState(page: import('@playwright/test').Page) {
  return page.evaluate(() => ({
    /** Nodes present in the graph at all. */
    nodes: document.querySelectorAll('.node-label-wrap').length,
    /** Nodes rendered as ghosts — filtered out, but still in the simulation. */
    ghosted: document.querySelectorAll('.node-label.dim-hidden').length,
    /** The landing page must never appear over a graph the user has loaded. */
    landing: document.querySelectorAll('.graph-landing, .landing').length,
  }));
}

test.describe('Graph filters ghost rather than delete', () => {
  test('a filter matching NOTHING ghosts every node instead of emptying the graph', async ({ page }) => {
    await clearAllKbs(page);
    await importKbFromTtl(page, 'roadmap', { switchTo: true });
    await openGraph(page);

    const before = await graphState(page);
    expect(before.nodes, 'the roadmap should render a populated graph').toBeGreaterThan(50);
    expect(before.ghosted, 'nothing should be ghosted before a filter is applied').toBe(0);
    expect(before.landing).toBe(0);

    // An imported TTL is entirely 'confirmed', so 'pending' matches ZERO statements. This is
    // the exact case that used to empty `visible` and replace the graph with the landing page.
    await page.locator('button.chip[title="Show pending facts awaiting your review"]').click();
    await page.waitForTimeout(2500);

    const after = await graphState(page);

    expect(
      after.landing,
      'a filter matching nothing must not replace the user graph with the marketing landing page',
    ).toBe(0);

    // The nodes are still THERE — a filter removes nothing from the simulation.
    expect(
      after.nodes,
      'filtered-out nodes must remain in the graph (ghosted), not be deleted from it',
    ).toBeGreaterThan(50);

    // ...and every one of them is a ghost, because none of them matched.
    expect(
      after.ghosted,
      'every node should be ghosted when the filter matches nothing',
    ).toBe(after.nodes);
  });

  test('a filter matching EVERYTHING ghosts nothing', async ({ page }) => {
    await clearAllKbs(page);
    await importKbFromTtl(page, 'roadmap', { switchTo: true });
    await openGraph(page);

    // The mirror case: the import is all-confirmed, so 'confirmed' matches every statement
    // and there is nothing to ghost. Guards against dimming the whole canvas indiscriminately
    // — the old code folded dimMode into baseAlpha and greyed out the matches too.
    await page.locator('button.chip[title="Show confirmed facts"]').click();
    await page.waitForTimeout(2500);

    const after = await graphState(page);
    expect(after.nodes, 'the graph should still be populated').toBeGreaterThan(50);
    expect(after.ghosted, 'a filter that matches everything should ghost nothing').toBe(0);
    expect(after.landing).toBe(0);
  });
});
