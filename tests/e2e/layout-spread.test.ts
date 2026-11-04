import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { clearStorage, waitForApp } from './helpers';

/**
 * HOW SPREAD OUT THE FREE AND FOCUS LAYOUTS ARE (F58.9.16 / kb:layout-math), as numbers.
 *
 * KnowledgeGraph writes `data-spread="n=.. nn=.. overlap=.."` to the canvas once the layout has
 * settled: nn is the mean centre-to-centre distance to the nearest other node, overlap the count of
 * node pairs whose drawn circles intersect. This opens the examples, settles each layout and reads
 * them back. Set SPREAD_OUT=/path/file.json to keep the numbers (the before/after in the PR).
 *
 * Headless SwiftShader renders slowly; the settle can take a while, hence the long timeouts.
 */

const EXAMPLES = [
  { card: /quick-start example/i, file: 'static/starter-quickstart.ttl' },
  { card: /generated assets/i, file: 'static/starter-generated-assets.ttl' },
];

/**
 * The most-mentioned entity of a Turtle file: what a person would click to focus on. A prefixed-name
 * count (the n3 parser cannot be loaded inside Playwright's test loader).
 */
function hubIri(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/^\s*#.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const prefixes = new Map<string, string>();
  for (const m of text.matchAll(/@prefix\s+(\w*):\s*<([^>]+)>/g)) prefixes.set(m[1], m[2]);
  const skip = new Set(['rdf', 'rdfs', 'xsd', 'skos', 'foaf', 'ktype', 'p', 'kpred', 'kmeta', 'schema', 'owl', 'dcterms', 'prov', 'hnav']);
  const count = new Map<string, number>();
  for (const m of text.matchAll(/\b(\w+):([\w-]+)/g)) {
    if (skip.has(m[1]) || !prefixes.has(m[1])) continue;
    const iri = prefixes.get(m[1]) + m[2];
    count.set(iri, (count.get(iri) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

type Spread = { n: number; nn: number; overlap: number };
const mean = (runs: Spread[]): Spread => ({
  n: runs[0].n,
  nn: Math.round((runs.reduce((a, r) => a + r.nn, 0) / runs.length) * 1000) / 1000,
  overlap: Math.round((runs.reduce((a, r) => a + r.overlap, 0) / runs.length) * 100) / 100,
});

async function spread(page: Page): Promise<Spread> {
  const canvas = page.locator('main canvas').first();
  await expect.poll(async () => (await canvas.getAttribute('data-spread')) ?? '', { timeout: 90_000, intervals: [1000] }).toMatch(/n=\d+ nn=/);
  const t = (await canvas.getAttribute('data-spread'))!;
  const m = /n=(\d+) nn=([\d.]+) overlap=(\d+)/.exec(t)!;
  return { n: Number(m[1]), nn: Number(m[2]), overlap: Number(m[3]) };
}

test('free and focus layouts: mean nearest-neighbour distance and overlap count', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const out: Record<string, unknown> = {};
  for (const ex of EXAMPLES) {
    await clearStorage(page);
    await waitForApp(page);
    await page.goto('/about');
    const card = page.locator('.starter-card', { hasText: ex.card });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 15_000 });
    const name = ex.file.replace(/^static\/starter-|\.ttl$/g, '');
    // New nodes start at random positions, so one settle is noisy (about +-10% on nn): the mean of
    // REPEATS fresh loads of each layout is reported. Focus is opened through the URL (layout=, sel=).
    const REPEATS = Number(process.env.SPREAD_REPEATS ?? 3);
    const freeRuns: Spread[] = [], focusRuns: Spread[] = [];
    for (let i = 0; i < REPEATS; i++) {
      await page.goto('/');
      await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 15_000 });
      freeRuns.push(await spread(page));
      await page.goto(`/?layout=focus&sel=${encodeURIComponent('i:' + hubIri(ex.file))}`);
      await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 15_000 });
      focusRuns.push(await spread(page));
    }
    out[`${name}/free`] = mean(freeRuns);
    out[`${name}/focus`] = mean(focusRuns);
  }
  console.log('SPREAD ' + JSON.stringify(out));
  if (process.env.SPREAD_OUT) { mkdirSync(dirname(process.env.SPREAD_OUT), { recursive: true }); writeFileSync(process.env.SPREAD_OUT, JSON.stringify(out, null, 2)); }
  for (const v of Object.values(out) as { n: number; nn: number }[]) { expect(v.n).toBeGreaterThan(2); expect(v.nn).toBeGreaterThan(0); }
});
