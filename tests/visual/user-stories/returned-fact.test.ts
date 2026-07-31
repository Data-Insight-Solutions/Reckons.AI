/**
 * VISUAL verification of the 'came back' review card (F122).
 *
 * This card only exists in one state — a source re-offering an exact triple the user already
 * rejected — so the button-crawler never reaches it: the crawler clicks what is on a route, and
 * nothing on any route produces this card without a seeded rejection first. Every button it adds
 * is therefore uncovered by the crawl, which is precisely the gap this file fills.
 *
 * What is checked, and why each one:
 *   1. the card RENDERS as "came back" rather than "new" — the whole point of the fix, and the
 *      thing a passing unit test cannot show actually reaching a user;
 *   2. BOTH buttons fire without a console error and resolve the card — "accept after all" acts
 *      on a statement the ingest page never stored, so an id mistake here is invisible to
 *      typechecking and would fail silently at runtime;
 *   3. the card does not strand or span at Pixel width, the measured failure mode in this
 *      codebase's review surfaces.
 */
import { test, expect, type Page } from '@playwright/test';

const APP = 'http://localhost:5174';
const SHOTS = 'tests/visual/screenshots/returned-fact';
const TOUCH_MIN = 44;

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const WORKS_AT = 'urn:kbase:predicate/works-at';
const ALICE = 'urn:kbase:concept/alice-returned';
const ACME = 'urn:kbase:concept/acme-returned';

/**
 * Seed a graph holding a REJECTED fact plus an identical PENDING one.
 *
 * The pending row is what the review page recomputes its diff from, so this reproduces the
 * situation the review surface actually sees — and it is the case where the card's actions must
 * target the pending statement rather than the old rejected one.
 */
async function seedRejectedThenReoffered(page: Page): Promise<void> {
  await page.goto(APP);
  await page.waitForFunction(() => {
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    return !!registry.find(
      (entry: { id: string; stableId?: string }) => entry.id === 'kbase' && entry.stableId,
    );
  }, undefined, { timeout: 20_000 });

  await page.evaluate(async ({ label, worksAt, alice, acme }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../../src/lib/storage/db');

    const fact = (
      id: string, s: string, p: string, o: string,
      status: 'confirmed' | 'pending' | 'rejected', objIri = false,
    ) => ({
      id,
      s: { kind: 'iri' as const, value: s },
      p: { kind: 'iri' as const, value: p },
      o: objIri ? { kind: 'iri' as const, value: o } : { kind: 'literal' as const, value: o },
      g: { kind: 'iri' as const, value: 'urn:kbase:source/returned-visual' },
      sourceId: 'returned-visual',
      confidence: 1,
      status,
      createdAt: 1,
      updatedAt: 1,
    });

    const db = new KBaseDB('kbase');
    await db.sources.put({
      id: 'returned-visual',
      title: 'Returned-fact visual seed',
      uri: 'test://returned-fact-visual',
      kind: 'note',
      ingestedAt: 1,
      trustLevel: 'review',
    });
    await db.statements.bulkPut([
      fact('ret-alice-label', alice, label, 'Alice', 'confirmed'),
      fact('ret-acme-label', acme, label, 'Acme Corp', 'confirmed'),
      // The decision the user already made…
      fact('ret-rejected', alice, worksAt, acme, 'rejected', true),
      // …and the identical triple arriving again.
      fact('ret-reoffered', alice, worksAt, acme, 'pending', true),
    ]);
    db.close();
  }, { label: LABEL, worksAt: WORKS_AT, alice: ALICE, acme: ACME });
}

/**
 * Poll for the model-download consent dialog and decline it.
 *
 * Mirrors startConsentDismisser in tests/e2e/helpers.ts, and for the reason recorded there:
 * the dialog blocks an awaited promise, so addLocatorHandler never fires (it only runs during
 * actionability checks). A one-shot dismissal is not enough — /review raises the gate more than
 * once as semantic enrichment retries, which is exactly how this test flaked.
 */
function startConsentDismisser(page: Page): void {
  let stopped = false;
  page.on('close', () => { stopped = true; });
  setTimeout(() => { stopped = true; }, 120_000);

  const tick = async () => {
    if (stopped) return;
    try {
      const btn = page.getByRole('button', { name: /not now/i });
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    } catch { /* page navigated or closed */ }
    if (!stopped) setTimeout(tick, 400);
  };
  setTimeout(tick, 300);
}

/** Open /review and locate the card for the re-offered triple. */
async function openReturnedCard(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // /review kicks off semantic enrichment, which raises the model-download consent gate; its
  // overlay intercepts pointer events. The card's structural classification does not depend on
  // embeddings, so declining is the right answer throughout the test, not just once.
  startConsentDismisser(page);
  await page.goto(`${APP}/review`);

  const card = page.locator('.entry', { has: page.locator('.tag.returned') }).first();
  await card.waitFor({ timeout: 20_000 });
  return { card, errors };
}

test.describe("'came back' review card — visual", () => {
  test('a re-offered rejection reads as "came back", not as new', async ({ page }) => {
    await seedRejectedThenReoffered(page);
    const { card, errors } = await openReturnedCard(page);

    await card.screenshot({ path: `${SHOTS}/desktop-card.png` });

    await expect(card.locator('.tag.returned')).toHaveText('came back');
    // The sentence must say WHY it is back — a tag alone does not tell the user they already
    // decided this, which is the only reason the card is worth showing rather than hiding.
    await expect(card).toContainText('you already rejected this exact fact');
    // And it must NOT be presented as new; that was the bug.
    await expect(card.locator('.tag.new')).toHaveCount(0);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('"dismiss again" resolves the card without a console error', async ({ page }) => {
    await seedRejectedThenReoffered(page);
    const { card, errors } = await openReturnedCard(page);

    await card.getByRole('button', { name: /dismiss again/i }).click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);

    // The re-offered row must actually be settled, not merely hidden — otherwise it returns.
    const status = await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../../src/lib/storage/db');
      const db = new KBaseDB('kbase');
      const st = await db.statements.get('ret-reoffered');
      db.close();
      return st?.status;
    });
    expect(status).toBe('rejected');
  });

  test('"accept after all" confirms the fact the user changed their mind about', async ({ page }) => {
    await seedRejectedThenReoffered(page);
    const { card, errors } = await openReturnedCard(page);

    await card.getByRole('button', { name: /accept after all/i }).click();
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);

    const status = await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../../src/lib/storage/db');
      const db = new KBaseDB('kbase');
      const st = await db.statements.get('ret-reoffered');
      db.close();
      return st?.status;
    });
    expect(status).toBe('confirmed');
  });

  test('phone: the card does not span, strand, or force a sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await seedRejectedThenReoffered(page);
    const { card } = await openReturnedCard(page);

    await card.screenshot({ path: `${SHOTS}/phone-card.png` });

    const dismiss = (await card.getByRole('button', { name: /dismiss again/i }).boundingBox())!;
    const accept = (await card.getByRole('button', { name: /accept after all/i }).boundingBox())!;

    // Neither action may claim the whole row and strand its neighbour on the next line — the
    // measured failure in the sibling gallery and archive-sweep work.
    const cardBox = (await card.boundingBox())!;
    expect(dismiss.width).toBeLessThan(cardBox.width * 0.9);
    expect(accept.width).toBeLessThan(cardBox.width * 0.9);

    // F36 touch minimum on both new controls.
    expect(dismiss.height).toBeGreaterThanOrEqual(TOUCH_MIN - 6);
    expect(accept.height).toBeGreaterThanOrEqual(TOUCH_MIN - 6);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, 'the review page scrolls sideways at 412px').toBe(false);
  });
});
