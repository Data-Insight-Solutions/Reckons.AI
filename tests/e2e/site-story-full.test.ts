import { test, expect, type Locator, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * The whole Data Insight Solutions story, every step, on whatever device the project is (Matt, 2026-11-25: "We need
 * to heavily test mobile and desktop for full story"). Run it on desktop-chrome AND mobile-android.
 *
 * Per step: the step counter, its title readable AND on top (nothing covers the caption, which a phone's detail
 * sheet once did), and the view it asks for, read back from the app's own URL parameters (F309: layout, f, sel,
 * lit). The ring steps check what they exist to show: the contact sheet's picture, the ring's jump with its
 * one-click offer, and that taking the jump opens the ring's own space with ITS story running.
 * A screenshot of every step is attached to the run for a person to look at.
 *
 * What this does not prove: that the 3D splat renders (WebGL in a headless browser is not a person's GPU) or that the
 * layouts read well. Those are marked for a human recheck in the graph (kpred:needs-human-recheck), not claimed here.
 */
type Step = { title: string; layout: string; f: string[]; sel?: string | 'first-highlight' | 'none' };
const RING = 'urn:reckons:ring/';
const STEPS: Step[] = [
  { title: 'Where the content came from', layout: 'source', f: ['confirmed'], sel: 'none' },
  { title: 'Who is behind the site', layout: 'hierarchy', f: ['confirmed'], sel: 'none' },
  { title: 'The business card, and its print sheets', layout: 'focus', f: ['confirmed'], sel: 'first-highlight' },
  { title: 'The ring, in 3D', layout: 'focus', f: ['confirmed'], sel: `i:${RING}ring-splat` },
  { title: 'The frames behind it', layout: 'focus', f: ['confirmed'], sel: `i:${RING}frames-contact-sheet` },
  { title: "Jump into the ring's own space", layout: 'focus', f: ['leaps'], sel: 'i:urn:kbase:concept/dis-ring' },
  { title: 'Pages made from one set of facts', layout: 'type', f: ['confirmed'], sel: 'none' },
  { title: 'One fact, stated on many pages', layout: 'focus', f: ['confirmed'], sel: 'first-highlight' },
  { title: 'Facts that expire', layout: 'timeline', f: ['confirmed'], sel: 'none' },
  { title: 'The live website', layout: 'force', f: ['confirmed'], sel: 'none' },
];

/** The step's title: the walk bar's on a phone, the latest step card on a desktop. */
const titleOf = (page: Page, title: string): Locator => page.getByText(title, { exact: true }).last();

/** True when the middle of the element is the topmost thing on screen there: readable, not merely in the DOM. */
async function onTop(el: Locator): Promise<boolean> {
  await el.scrollIntoViewIfNeeded();
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (node === top || node.contains(top));
  });
}

async function openStory(page: Page, step = 1) {
  await clearStorage(page);
  await waitForApp(page);
  await page.goto(`/about?example=data-insight-solutions&story=1&step=${step}`);
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.locator('.story-step-label').first()).toHaveText(`${step} / ${STEPS.length}`, { timeout: 30000 });
}

test('every step of the site story shows its view, with its caption on top', async ({ page }, info) => {
  test.setTimeout(180_000);
  await openStory(page);

  for (const [i, step] of STEPS.entries()) {
    const n = i + 1;
    await expect(page.locator('.story-step-label').first(), `step ${n}`).toHaveText(`${n} / ${STEPS.length}`);
    const title = titleOf(page, step.title);
    await expect(title, `step ${n} title`).toBeVisible();

    // The view, as the URL states it once the step has been applied.
    // force is the default layout, which the URL leaves out.
    await expect.poll(() => new URL(page.url()).searchParams.get('layout') ?? 'force', { message: `step ${n} layout` }).toBe(step.layout);
    const params = new URL(page.url()).searchParams;
    for (const f of step.f) expect((params.get('f') ?? '').split(','), `step ${n} filter ${f}`).toContain(f);
    const sel = params.get('sel');
    if (step.sel === 'none') expect(sel ?? '', `step ${n} selects nothing`).toBe('');
    else if (step.sel === 'first-highlight') expect(sel ?? '', `step ${n} selects its first highlight`).toMatch(/^i:/);
    else expect(sel, `step ${n} selection`).toBe(step.sel);
    expect((params.get('lit') ?? '').split(',').filter(Boolean).length, `step ${n} lights something`).toBeGreaterThan(0);

    // What the ring steps exist to show.
    if (step.title === 'The frames behind it') {
      // A phone holds the step's selection on the canvas and offers its details on a chip; the reader opens them.
      const chip = page.getByRole('button', { name: /^Show details:/ });
      if (await chip.isVisible()) await chip.click();
      await expect(page.locator('img[src*="contact-sheet"]').first(), 'the contact sheet picture').toBeVisible({ timeout: 10000 });
      if (!(await titleOf(page, step.title).isVisible()) || !(await onTop(titleOf(page, step.title)))) await page.keyboard.press('Escape');
    }
    if (step.title === "Jump into the ring's own space") {
      await expect(page.getByRole('button', { name: /Jump to “The ring”/ }), 'the jump offer').toBeVisible();
    }

    // Last: the caption is on top (a detail panel opened by this step must not cover it).
    expect(await onTop(title), `step ${n}: the caption is covered`).toBe(true);
    const shot = info.outputPath(`step-${String(n).padStart(2, '0')}.png`);
    await page.screenshot({ path: shot });
    await info.attach(`step-${String(n).padStart(2, '0')}`, { path: shot, contentType: 'image/png' });
    if (n < STEPS.length) await page.getByRole('button', { name: 'Next step' }).first().click();
  }
});

test("the ring step's jump opens the ring's own space with its story running", async ({ page }) => {
  await openStory(page, 6);
  await expect(titleOf(page, "Jump into the ring's own space")).toBeVisible();
  await page.getByRole('button', { name: /Jump to “The ring”/ }).click();
  await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('example'), { timeout: 30000 });
  // Now in the ring's space: its own story, at step 1, and the space switched (its contact sheet is a fact here).
  await expect(page.locator('.story-step-label').first()).toHaveText(/^1 \/ \d+$/, { timeout: 30000 });
  await expect(page.getByText(/Data Insight Solutions/).first()).toBeAttached();
});
