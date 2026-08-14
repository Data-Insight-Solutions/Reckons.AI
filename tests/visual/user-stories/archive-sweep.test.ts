/**
 * VISUAL verification of the F97 archive sweep panel — the part no assertion catches.
 *
 * The functional behaviour is covered by `tests/e2e/archive-sweep.test.ts` (7 tests) and the
 * planner by unit tests. This file exists because of a measured pattern in this exact area of the
 * app: the two bugs found in the sibling gallery work — an orphan caution rendering in brand teal
 * because `var(--warn, var(--accent))` fell through to a colour that means "good", and an action
 * button spanning a whole mobile row and stranding its neighbour — BOTH passed every suite. They
 * were found by looking at a screenshot.
 *
 * So this checks the two properties that failed there, at the width they failed at:
 *   1. the destructive action does not span or strand on a 412px phone;
 *   2. the panel does not force the page to scroll sideways.
 * Plus the F36 touch-target minimum, because the button-crawler recorded 58 sub-44px controls at
 * Pixel width and adding more is how that number stays where it is.
 *
 * It writes screenshots to tests/visual/screenshots/archive-sweep/ deliberately — the artifact IS
 * the point, and the assertions below are only the parts a machine can settle.
 */
import { test, expect, type Page } from '@playwright/test';

const APP = 'http://localhost:5174';
const SHOTS = 'tests/visual/screenshots/archive-sweep';
/** The touch minimum. A DESKTOP measurement of this is advisory — see button-crawl.ts. */
const TOUCH_MIN = 44;

const SCHEDULED_AT = 'urn:kbase:predicate/scheduled-at';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** Seed a graph holding one aged-out event and one current one, so the panel has a real plan. */
async function seedDatedEvents(page: Page): Promise<void> {
  await page.goto(APP);
  await page.waitForFunction(() => {
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    return !!registry.find(
      (entry: { id: string; stableId?: string }) => entry.id === 'kbase' && entry.stableId,
    );
  }, undefined, { timeout: 20_000 });

  await page.evaluate(async ({ scheduledAt, label }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../../src/lib/storage/db');

    const DAY = 86_400_000;
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const fact = (id: string, s: string, p: string, o: string) => ({
      id,
      s: { kind: 'iri' as const, value: s },
      p: { kind: 'iri' as const, value: p },
      o: { kind: 'literal' as const, value: o },
      g: { kind: 'iri' as const, value: 'urn:kbase:source/sweep-visual' },
      sourceId: 'sweep-visual',
      confidence: 1,
      status: 'confirmed' as const,
      createdAt: 1,
      updatedAt: 1,
    });

    const db = new KBaseDB('kbase');
    await db.sources.put({
      id: 'sweep-visual',
      title: 'Sweep visual seed',
      uri: 'test://archive-sweep-visual',
      kind: 'note',
      ingestedAt: 1,
      trustLevel: 'review',
    });
    await db.statements.bulkPut([
      fact('vis-old-when', 'urn:kbase:concept/last-years-summit', scheduledAt, iso(400)),
      fact('vis-old-label', 'urn:kbase:concept/last-years-summit', label, "Last year's summit"),
      fact('vis-new-when', 'urn:kbase:concept/this-weeks-standup', scheduledAt, iso(2)),
      fact('vis-new-label', 'urn:kbase:concept/this-weeks-standup', label, "This week's standup"),
    ]);
    db.close();
  }, { scheduledAt: SCHEDULED_AT, label: LABEL });
}

/** Open /kb and expand the sweep panel with a threshold that produces a real, non-empty plan. */
async function openSweepPanel(page: Page): Promise<void> {
  await page.goto(`${APP}/kb`);
  await page.locator('.kb-list').waitFor({ timeout: 20_000 });
  await page.locator('.kb-sweep-toggle').click();
  await page.locator('.kb-sweep-field input').fill('90');
  await expect(page.getByTestId('sweep-plan')).toContainText('would move');
}

test.describe('Archive sweep panel — visual', () => {
  test('desktop: the panel reads as one block under its graph', async ({ page }) => {
    await seedDatedEvents(page);
    await openSweepPanel(page);

    await page.locator('.kb-sweep').screenshot({ path: `${SHOTS}/desktop-panel.png` });

    // The destructive action must not be the widest thing in the panel — it is one option among
    // the text explaining it, not the panel's headline.
    const panel = (await page.locator('.kb-sweep-body').boundingBox())!;
    const run = (await page.locator('.kb-sweep-run').boundingBox())!;
    expect(run.width).toBeLessThan(panel.width * 0.6);

    // The destructive control must LOOK like a button. `button.danger` is borderless by design
    // for dense "remove" links, and inheriting that made the one destructive action here read as
    // a hyperlink — visible in the first screenshot, invisible to every other assertion.
    const border = await page.locator('.kb-sweep-run').evaluate(
      (el) => getComputedStyle(el).borderTopColor,
    );
    expect(border, 'the destructive action has no visible border').not.toBe('rgba(0, 0, 0, 0)');
    expect(border).not.toBe('transparent');
  });

  test('phone: the destructive action neither spans the row nor strands a neighbour', async ({ page }) => {
    // 412×915 — the Pixel width the button-crawler measures and the width the gallery's
    // grid-column bug only appeared at.
    await page.setViewportSize({ width: 412, height: 915 });
    await seedDatedEvents(page);
    await openSweepPanel(page);

    await page.locator('.kb-sweep').screenshot({ path: `${SHOTS}/phone-panel.png` });

    const panel = (await page.locator('.kb-sweep-body').boundingBox())!;
    const run = (await page.locator('.kb-sweep-run').boundingBox())!;
    // The exact shape of the gallery bug: a control given the full grid width at phone size.
    expect(run.width).toBeLessThan(panel.width * 0.9);

    // Every interactive control in the panel meets the touch minimum.
    for (const selector of ['.kb-sweep-toggle', '.kb-sweep-field input', '.kb-sweep-run']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.height, `${selector} is under the ${TOUCH_MIN}px touch minimum`)
        .toBeGreaterThanOrEqual(TOUCH_MIN);
    }
  });

  test('phone: the panel does not make the page scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await seedDatedEvents(page);
    await openSweepPanel(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the sweep panel pushes the page wider than the viewport')
      .toBeLessThanOrEqual(1); // 1px of sub-pixel rounding is not a horizontal scrollbar
  });
});
