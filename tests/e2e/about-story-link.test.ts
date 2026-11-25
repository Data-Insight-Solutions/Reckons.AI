import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F292.4 (kb:site-story-improved) — start from the link.
 *
 * A link a site drops in — /about?example=<id>&story=<iri|n>&autoplay=1 — must open the
 * example space AND start its story at step 1, with no click on the "has a guided story"
 * notice. This is the browser half of the part: exampleLanding's parameter handling is unit
 * tested in src/lib/storage/__tests__/example-space.test.ts; here the journey runs for real
 * (link → about page → space opens → main page → startStoryFromLink).
 */
test('a link opens the site space and starts its story at step 1, without touching the story notice', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);

  await page.goto('/about?example=data-insight-solutions&story=1&autoplay=1');

  // The about page resolves the example, opens the space and moves to the main page.
  // No card, no notice, no click.
  await page.waitForURL(url => url.pathname === '/');
  await expect(page.locator('main canvas').first()).toBeVisible();

  // The story is open on its own, at step 1:
  await expect(page.locator('.story-step-label').first()).toBeVisible();
  await expect(page.locator('.story-step-label').first()).toHaveText('1 / 7');
  // ...and step 1 is what is showing:
  await expect(page.getByText('Where the content came from').first()).toBeVisible();
  // Story mode is on (there is an exit affordance):
  await expect(page.getByRole('button', { name: 'Exit story mode', exact: true })).toBeVisible();
  // And autoplay=1 was honoured: the request reached the voice gate. Voice is off by default,
  // so the app asks before an ~87 MB download rather than assuming consent — the gate is the
  // honest end state of an autoplay request made by a link:
  await expect(page.getByText('Enable voice narration?')).toBeVisible();
  // Choosing "No, just auto-advance" is the human half of that gate (not a story-start click):
  await page.getByRole('button', { name: 'No, just auto-advance' }).click();
  // ...and now the step countdown is running (pace defaults to 40s):
  await expect(page.locator('.story-timer').first()).toBeVisible({ timeout: 5000 });
});
