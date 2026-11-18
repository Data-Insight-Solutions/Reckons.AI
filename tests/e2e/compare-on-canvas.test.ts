import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { clearStorage, waitForApp } from './helpers';

/**
 * COMPARE ON THE CANVAS (F264.2). With the synthetic four-label note read against the first, the
 * incoming source is drawn over the person's own canvas: one ghost, one repeat folded, one
 * reinforcement thickening, one contradiction pair with both sources, and nothing is written
 * until a choice is made. The legend and cards come from the same mapping the canvas draws; the
 * canvas itself is checked only for amber ghost pixels, not for where they sit.
 */
const demo = JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  seed: { title: string; text: string };
  change: { title: string; text: string };
};

async function addNote(page: Page, title: string, text: string) {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill(title);
  await page.locator('textarea').first().fill(text);
  const submit = page.getByRole('button', { name: /extract statements/i });
  await expect(submit).not.toBeDisabled({ timeout: 5_000 });
  await submit.click();
  await page.waitForURL((url) => url.pathname === '/review' && url.searchParams.get('view') === 'compare', { timeout: 30_000 });
}

async function statusCounts(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { status: string }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  });
}

test('the incoming note is drawn over the canvas by what it would do, and nothing is written until a choice', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await page.evaluate(() => localStorage.setItem('reckons-test-embedder', '1'));

  await addNote(page, demo.seed.title, demo.seed.text);
  const flow = page.getByTestId('compare-flow');
  await flow.getByRole('button', { name: /^accept all/ }).click();
  await expect(flow.locator('.diff-entry')).toHaveCount(0, { timeout: 8_000 });

  await addNote(page, demo.change.title, demo.change.text);
  await expect(flow.locator('.diff-entry')).toHaveCount(4, { timeout: 10_000 });
  await expect(flow.locator('.diff-entry[data-kind="near-duplicate"]')).toHaveCount(1, { timeout: 15_000 });

  const legend = page.getByTestId('overlay-legend');
  await expect(legend).toContainText('1 new, drawn as ghosts');
  await expect(legend).toContainText('1 repeat, folded onto what you hold');
  await expect(legend).toContainText('1 reinforcing, thickening what you hold');
  await expect(legend).toContainText('1 contradiction');

  const pair = page.getByTestId('contradiction-pair');
  await expect(pair).toHaveCount(1);
  await expect(pair).toContainText('members · 40');
  await expect(pair).toContainText('members · 52');
  await expect(pair).toContainText(`from ${demo.seed.title}`);
  await expect(pair).toContainText(`from ${demo.change.title}`);

  // The canvas really carries the amber ghosts (any amber pixel), once the layout has had a moment.
  await expect
    .poll(async () =>
      page.getByTestId('compare-canvas').locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
        const g = c.getContext('2d');
        if (!g) return 0;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 190 && d[i + 2] < 70 && d[i + 3] > 100) n++;
        return n;
      }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);

  // Nothing changed: the first note's three are confirmed, the second's four are still pending.
  expect(await statusCounts(page)).toEqual({ confirmed: 3, pending: 4 });

  // A choice changes it, and then the overlay lets go of that statement.
  await flow.getByRole('button', { name: /accept new only/ }).click();
  await expect(legend).toContainText('0 new, drawn as ghosts', { timeout: 8_000 });
  expect(await statusCounts(page)).toEqual({ confirmed: 4, pending: 3 });
});
