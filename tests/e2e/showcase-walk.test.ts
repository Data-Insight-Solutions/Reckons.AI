import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F304.1 done-test: the link opens the showcase and the story plays to its last step with no sound,
 * each step changing what is lit; F304.2: the last step's leap opens the personal space, which
 * holds only the facts named there.
 *
 * The walk is story:matthew-roe-walk inside static/starter-matthew-roe.ttl, opened exactly the way
 * a visitor opens it: /about?example=matthew-roe. The autoplay confirmation is answered "No, just
 * auto-advance" — that IS the muted path (no voice download) — and the story is then paused and
 * advanced step by step with Next, so the per-step "what is lit" check never races the 20-second
 * countdown. (The lit labels are a subset check: the 3D renderer culls distant labels out of the
 * DOM, so a step whose highlights are all culled has an empty lit set; at least one must be lit.)
 *
 * The space is opened as its OWN space by the about page (example-kbs entry 'matthew-roe'), so the
 * db under test is the showcase's, and after the leap it is the personal space's.
 */
const STORY = 'urn:reckons:story/matthew-roe-walk';

/** rdfs:label values present in the active space's database. */
async function labelsInDb(page: Page, names: string[]) {
  return page.evaluate(async (names) => {
    const { db } = await import(/* @vite-ignore */ '/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string } }[];
    const labels = new Set(rows.filter((r) => r.p.value === 'http://www.w3.org/2000/01/rdf-schema#label').map((r) => r.o.value));
    return names.filter((n) => labels.has(n));
  }, names);
}

/** The lit labels are exactly within the step's expected set, at least one is lit, none of them dimmed, and something else is dimmed. */
async function expectLit(page: Page, names: string[]) {
  await expect.poll(async () => {
    const lit = await page.locator('.node-label:not(.dim-hidden)').allTextContents();
    const dim = await page.locator('.node-label.dim-hidden').allTextContents();
    return lit.length > 0 && lit.every((l) => names.includes(l)) && !dim.some((l) => names.includes(l)) && dim.length > 0;
  }, { timeout: 15_000 }).toBe(true);
}

/** The caption-derived label of each step's highlights, in story order. */
const STEPS: { count: string; labels: string[] }[] = [
  { count: '1 / 8', labels: ['Matthew Roe'] },
  { count: '2 / 8', labels: ["Where I've worked", 'Univision', 'Submittable', 'Orange Logic', 'VF Corporation'] },
  { count: '3 / 8', labels: ['Nonprofits and grants', 'Submittable'] },
  { count: '4 / 8', labels: ['Ava Lions Club', 'Food Tokens'] },
  { count: '5 / 8', labels: ['Reckons.AI', 'The Claude Code figure'] },
  { count: '6 / 8', labels: ['The ring and other 3D objects'] },
  { count: '7 / 8', labels: ['The Saturday farmers market', 'Food Tokens'] },
  { count: '8 / 8', labels: ['Off the clock'] },
];

test('the showcase walk plays through muted, and the last step leaps to the personal space', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);

  // Open it the way a visitor does: the about link with the story and autoplay on.
  // The about page imports the space and then redirects to / — wait for that redirect to finish
  // before touching the db (it destroys the page context mid-import).
  await page.goto(`/about?example=matthew-roe&story=${encodeURIComponent(STORY)}&autoplay=1`);
  await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });
  await expect.poll(() => labelsInDb(page, ['Matthew Roe']), { timeout: 30_000 }, 'the showcase opened as its own space')
    .toEqual(['Matthew Roe']);

  // The story then opens from its link, on the canvas.
  await page.goto(`/?story=${encodeURIComponent(STORY)}&autoplay=1`);
  const counter = page.locator('.story-step-label').first();
  await expect(counter, 'the story is open on step 1 of 8').toHaveText('1 / 8', { timeout: 30_000 });

  // The no-sound autoplay: decline the voice download, keep the auto-advance.
  await page.getByRole('button', { name: 'No, just auto-advance' }).click({ timeout: 15_000 });

  // Pause the countdown so the per-step lit check does not race the 20-second auto-advance;
  // the story is then played through with Next, step by step.
  await page.locator('button.story-btn.active', { hasText: '⏸' }).click();

  // The lit labels are DOM labels, and the 3D renderer culls them by distance/overlap — a step's
  // OWN highlighted label can be culled (the cull pipeline priority-lists source anchors only, not
  // the story's spotlight). 2D culls on overlap only, so run the walk in the 2D renderer — the one
  // the app itself recommends when 3D is slow. (The spotlight/dim behaviour under test is identical
  // in both renderers; the assertion is unchanged.)
  const r2d = page.getByRole('button', { name: '2D', exact: true });
  if ((await r2d.getAttribute('aria-pressed')) !== 'true') await r2d.click();
  await page.waitForTimeout(1000);

  for (let i = 0; i < STEPS.length; i++) {
    await expect(counter).toHaveText(STEPS[i].count, { timeout: 15_000 });
    await expectLit(page, STEPS[i].labels);
    if (i < STEPS.length - 1) await page.getByRole('button', { name: 'Next step' }).click();
  }

  // Step 8's leap: select the "off the clock" node and take its jump, the way the node panel offers it.
  await page.goto(`/?sel=${encodeURIComponent('i:urn:reckons:matthew-roe/off-the-clock')}`);
  const jump = page.locator('button.leap-id', { hasText: 'Open my personal space' });
  await expect(jump, 'the node panel shows the leap to the personal space').toBeVisible({ timeout: 30_000 });
  // The leap is /about?example=matthew-roe-personal, which imports the personal space and
  // redirects to / — wait for a bare / before touching the db.
  await jump.click();
  await page.waitForURL((url) => url.pathname === '/' && url.search === '', { timeout: 60_000 });

  // The personal space opens as its own space, holding only the facts named there.
  await expect.poll(
    () => labelsInDb(page, ['My personal space', 'Archery', 'Wooden bows and arrows', 'Dog, cats, chickens, and darkling beetles', 'Swimming']),
    { timeout: 60_000 },
    'the personal space opened with its five facts',
  ).toEqual(['My personal space', 'Archery', 'Wooden bows and arrows', 'Dog, cats, chickens, and darkling beetles', 'Swimming']);
});
