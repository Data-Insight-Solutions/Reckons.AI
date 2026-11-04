import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * RELEASE REVIEW SPACES (F34.5 / kb:release-review-spaces): About lists "Review 0.2.6" and "Review
 * 0.2.7" under example data; each opens as its own space whose nodes are that release's visual
 * tests; a step takes a pass / fail verdict from the node panel, written as a meta triple.
 *
 * What the 0.2.7 space holds is whatever static/review-0.2.7.ttl says, and that file is generated:
 * at the time of writing no 0.2.7 part has a TestWorkflow, so its first node is "No visual test
 * yet". This test therefore asserts the FIRST node the generated file puts in story order, not a
 * particular workflow, and the verdict flow runs on 0.2.6, which does have one.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
});

async function openReview(page: Page, version: string) {
  await page.goto('/about');
  const card = page.locator('.starter-card', { hasText: new RegExp(`review ${version.replace(/\./g, '\\.')}`, 'i') });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 15_000 });
}

/** Search finds an entity by the tail of its IRI (shown as "<version>/<slug>"); pick the row ending in exactly that slug. */
async function pickNode(page: Page, slug: string) {
  await page.getByPlaceholder('search nodes or facts…').fill(slug);
  const iri = page.locator('.sb-node-iri').filter({ hasText: new RegExp(`/${slug}$`) });
  await page.locator('.sb-node-row').filter({ has: iri }).first().click();
}

test('Review 0.2.7 opens as its own space and shows its first node', async ({ page }) => {
  test.setTimeout(90_000);
  await openReview(page, '0.2.7');
  await page.goto('/kb');
  await expect(page.locator('.kb-entry.current').first()).toContainText(/review 0\.2\.7/i, { timeout: 10_000 });
  await page.goto('/');
  // The first node in story order. With no workflow yet in 0.2.7 it is the visible gap.
  await pickNode(page, 'gap');
  await expect(page.getByText(/no visual test yet/i).first()).toBeVisible({ timeout: 10_000 });
});

test('a step of Review 0.2.6 takes a pass and a fail verdict from the node panel', async ({ page }) => {
  test.setTimeout(90_000);
  await openReview(page, '0.2.6');
  await pickNode(page, 'wf-readme-path-01-add-source');
  const verdict = page.getByTestId('review-verdict');
  await expect(verdict).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('verdict-state')).toHaveText('unreviewed');
  await page.getByTestId('verdict-pass').click();
  await expect(page.getByTestId('verdict-state')).toHaveText('pass');
  await page.getByTestId('verdict-fail').click();
  await expect(page.getByTestId('verdict-state')).toHaveText('fail');
  await page.getByTestId('verdict-note').fill('the Extract facts box is cut off');
  await page.getByTestId('verdict-note-save').click();
  await expect(page.getByTestId('verdict-note-save')).toBeDisabled();
  // It survives leaving the node and coming back: it is a triple in the space, not component state.
  await pickNode(page, 'wf-readme-path-02-review-claims');
  await expect(page.getByTestId('verdict-state')).toHaveText('unreviewed');
  await pickNode(page, 'wf-readme-path-01-add-source');
  await expect(page.getByTestId('verdict-state')).toHaveText('fail');
  await expect(page.getByTestId('verdict-note')).toHaveValue(/cut off/);
});
