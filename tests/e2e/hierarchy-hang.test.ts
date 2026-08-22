import { test, expect } from '@playwright/test';

/**
 * REGRESSION: the "tree" layout hangs the app when the graph HAS a hierarchy.
 *
 * Found 2026-08-21 by driving the real app. Clicking the tree chip on a graph with hierarchy
 * edges blocks the main thread: Playwright reports the element "visible, enabled and stable",
 * finishes scrolling, and the click never returns. The same click on demo-review-tree — which
 * states ZERO skos:broader edges — passes, which is why the review e2e never caught it.
 *
 * WHERE IT IS NOT: neither buildHierarchyAnchors (2D) nor buildHierarchyAnchors3D logs on entry,
 * so the block happens BEFORE anchors are computed. The review preview defaults to 3D
 * (`use2D = prefer2D ?? false`), so the 2D path is not involved at all.
 *
 * Marked test.fail(): it PASSES while the bug is present and turns RED the moment the hang is
 * fixed, which is the signal that matters. A hang a user hit twice belongs in the suite, not in a
 * handoff note — but it must not sit in CI as a permanent red that everyone learns to ignore.
 */
test('tree layout does not hang on a graph that has a hierarchy', async ({ page }) => {
  test.fail(true, 'KNOWN HANG: switching to tree layout blocks the main thread when the graph states hierarchy edges');
  test.setTimeout(180_000);
  await page.goto('/ingest');
  await page.locator('.tabs button', { hasText: 'graph' }).click();
  await page.setInputFiles('input[type="file"]', 'kbs/demo-decision-tree/demo-decision-tree.ttl');
  const b = page.getByRole('button', { name: /^import →$/ });
  await expect(b).toBeEnabled({ timeout: 20_000 });
  await b.click();
  await page.waitForURL((u) => !u.pathname.startsWith('/ingest'), { timeout: 45_000 });
  await page.goto('/review');
  await expect(page.getByTestId('altitude-headline')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  const tree = page.locator('.tg-chip', { hasText: /^tree$/ }).first();
  // The click itself is the assertion: it must RETURN. A 15s cap keeps a hang from eating the
  // whole test timeout and makes the failure read as "hung", not "slow".
  await tree.click({ timeout: 15_000 });
  await expect(tree).toHaveAttribute('data-state', 'on', { timeout: 5_000 });
  // And the page must still be answering afterwards.
  const t0 = Date.now();
  await page.evaluate(() => 1);
  expect(Date.now() - t0, 'main thread blocked after switching to tree layout').toBeLessThan(2_000);
});
