/**
 * COMPARE LAYOUT (F306.2, kb:split-canvas) — the two-provenance comparison drawn as a venn
 * diagram on the main canvas.
 *
 * Seeded deterministically from tests/fixtures/compare-venn/comparison.json — the same file the
 * unit test (src/lib/rdf/__tests__/compare-venn.test.ts) maps with the deterministic test
 * embedder (src/lib/embed.ts testEmbedding, active here under the mock build and the
 * `reckons-test-embedder` flag). So the legend counts asserted here are the counts the unit
 * test proves, and "matched by meaning" runs on a model no test ever downloads.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

type Fx = {
  sources: { id: string; title: string }[];
  statements: { source: string; s: string; p: string; o: string; iri?: boolean }[];
  expected: { a: number; b: number; shared: number };
};
const fx: Fx = JSON.parse(readFileSync('tests/fixtures/compare-venn/comparison.json', 'utf8'));

/** `n` = how many of the fixture's two provenances to seed (2 = the comparison, 1 = the blocked case). */
async function seed(page: Page, n: 1 | 2) {
  await page.goto('/');
  await page.locator('nav').waitFor();
  await page.evaluate(async (env: { fx: Fx; n: number }) => {
    const { fx, n } = env;
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { iri, lit } = await runtimeImport('/src/lib/rdf/types.ts') as typeof import('../../src/lib/rdf/types');
    const at = Date.UTC(2026, 10, 20);
    const sources = fx.sources.slice(0, n).map((s, i) => ({
      id: s.id, title: s.title, kind: 'note' as const,
      uri: `https://example.test/${s.id}`, ingestedAt: at + i,
    }));
    const st = (id: string, r: (typeof fx.statements)[number]) => ({
      id, sourceId: r.source,
      s: iri(`urn:venn-fixture/${r.s}`), p: iri(`urn:kbase:predicate/${r.p}`),
      o: r.iri ? iri(`urn:venn-fixture/${r.o}`) : lit(r.o),
      g: iri(`urn:kbase:source/${r.source}`), confidence: 0.9, status: 'confirmed' as const,
      createdAt: at, updatedAt: at,
    });
    const facts = fx.statements
      .filter((r) => n === 2 || r.source === fx.sources[0].id)
      .map((r, i) => st(`cmp-${i}`, r));
    await db.sources.bulkPut(sources);
    await db.statements.bulkPut(facts);
    // Deterministic embedder (F264.1): "match by meaning" without a model download.
    localStorage.setItem('reckons-test-embedder', '1');
    const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts') as typeof import('../../src/lib/stores/settings.svelte');
    await updateSettings({ prefer2D: true });
  }, { fx, n });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Graph perspective' })).toBeVisible({ timeout: 20_000 });
}

/** How many pixels of the largest canvas sit within `tol` of the given colour (alpha counted). */
async function canvasPixelsNear(page: Page, hex: string, tol = 30): Promise<number> {
  return page.evaluate(([hex, tol]) => {
    const t = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    let canvas: HTMLCanvasElement | null = null;
    for (const c of Array.from(document.querySelectorAll('canvas'))) {
      if (c.width < 100 || c.height < 100) continue;
      if (!canvas || c.width * c.height > canvas.width * canvas.height) canvas = c;
    }
    if (!canvas) return 0;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 80) continue;
      if (Math.abs(data[i] - t[0]) <= tol && Math.abs(data[i + 1] - t[1]) <= tol && Math.abs(data[i + 2] - t[2]) <= tol) n++;
    }
    return n;
  }, [hex, tol] as const) as Promise<number>;
}

const DEFAULTS = { a: 'rgb(47, 128, 237)', b: 'rgb(229, 72, 77)', shared: 'rgb(168, 85, 247)' };

test('the URL contract opens the compare layout with the unit-tested counts', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page, 2);
  await page.goto('/?layout=compare&a=venn-a&b=venn-b');
  await expect(page.getByTestId('compare-panel')).toBeVisible({ timeout: 30_000 });
  const graph = page.getByRole('region', { name: 'Knowledge graph' });
  await expect(graph).toHaveAttribute('data-graph-renderer', '2d');
  await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 25_000 });

  // The legend counts are the mapping the unit test proves for this fixture: 2 / 3 / 2.
  await expect(page.getByTestId('compare-legend-a')).toHaveAttribute('data-count', String(fx.expected.a));
  await expect(page.getByTestId('compare-legend-shared')).toHaveAttribute('data-count', String(fx.expected.shared));
  await expect(page.getByTestId('compare-legend-b')).toHaveAttribute('data-count', String(fx.expected.b));

  // The three defaults, and the honest note that "shared" ran on meaning, not string identity.
  await expect(page.getByTestId('compare-legend-a').locator('.compare-swatch')).toHaveCSS('background-color', DEFAULTS.a);
  await expect(page.getByTestId('compare-legend-shared').locator('.compare-swatch')).toHaveCSS('background-color', DEFAULTS.shared);
  await expect(page.getByTestId('compare-legend-b').locator('.compare-swatch')).toHaveCSS('background-color', DEFAULTS.b);
  await expect(page.getByTestId('compare-matched-by')).toContainText('matched by meaning');
  // The near-duplicate is on the canvas: blue lobe rim drawn in the default colour.
  expect(await canvasPixelsNear(page, '#2f80ed')).toBeGreaterThan(0);
});

test('changing a colour changes the canvas, and reverting restores the defaults', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page, 2);
  await page.goto('/?layout=compare&a=venn-a&b=venn-b');
  await expect(page.getByTestId('compare-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Knowledge graph' })).toHaveAttribute('data-graph-settled', 'true', { timeout: 25_000 });
  await expect(page.getByTestId('compare-legend-a').locator('.compare-swatch')).toHaveCSS('background-color', DEFAULTS.a);

  const green = 'rgb(0, 192, 0)';
  await page.evaluate(async () => {
    const { updateSettings } = await (async (p: string) => import(/* @vite-ignore */ p))('/src/lib/stores/settings.svelte.ts');
    await updateSettings({ compareColors: { a: '#00c000' } });
  });
  await expect(page.getByTestId('compare-legend-a').locator('.compare-swatch')).toHaveCSS('background-color', green);
  await expect.poll(() => canvasPixelsNear(page, '#00c000'), { timeout: 15_000 }).toBeGreaterThan(0);

  // Revert: no colour saved, so the defaults apply again.
  await page.evaluate(async () => {
    const { updateSettings } = await (async (p: string) => import(/* @vite-ignore */ p))('/src/lib/stores/settings.svelte.ts');
    await updateSettings({ compareColors: undefined });
  });
  await expect(page.getByTestId('compare-legend-a').locator('.compare-swatch')).toHaveCSS('background-color', DEFAULTS.a);
  await expect.poll(() => canvasPixelsNear(page, '#2f80ed'), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await canvasPixelsNear(page, '#00c000')).toBe(0);
});

test('turning the layout off draws the space unchanged and writes nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page, 2);
  await page.goto('/?layout=compare&a=venn-a&b=venn-b');
  await expect(page.getByTestId('compare-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Knowledge graph' })).toHaveAttribute('data-graph-settled', 'true', { timeout: 25_000 });

  await page.goto('/');
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);
  const graph = page.getByRole('region', { name: 'Knowledge graph' });
  await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 25_000 });
  // The seven entities the fixture states are all still drawn.
  await expect(page.locator('.node-label-wrap[data-node-key^="i:urn:venn-fixture/"]')).toHaveCount(7);

  // Presentation only: the rows it drew are exactly the rows it was given, nothing added.
  const persisted = await page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db, getSettings } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    return {
      statements: await db.statements.count(),
      sources: await db.sources.count(),
      compareColors: (await getSettings()).compareColors,
    };
  });
  expect(persisted).toEqual({ statements: 10, sources: 2, compareColors: undefined });
});

test('with one provenance the layout says so instead of opening empty', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page, 1);

  // The menu item is offered but says what it needs.
  await page.getByTestId('layout-trigger').click();
  const item = page.getByTestId('layout-compare');
  await expect(item).toBeDisabled();
  await expect(item).toContainText('needs two provenances (only 1 here)');

  // Opening it from the URL still says so, and draws no empty comparison.
  await page.goto('/?layout=compare');
  await expect(page.getByTestId('compare-needs-sources')).toContainText(
    'The compare layout needs two provenances; only 1 here. Add another from ingest, then come back.',
  );
  await expect(page.getByTestId('compare-legend')).toHaveCount(0);
});
