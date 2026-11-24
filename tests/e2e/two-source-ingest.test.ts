import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { clearStorage, waitForApp } from './helpers';

/**
 * TWO-SOURCE INGEST (F306.1). The Ingest page's "compare two" entry reads two sources through the
 * ordinary pipeline and records one named comparison. The two sources are the synthetic compare-demo
 * notes (tests/fixtures/compare-demo) served as fake web pages, so no network and no model are used:
 * the mock extractor returns each note's statements.
 *
 * What this proves: the wiring, the record, the source on every statement, the link's form, and the
 * failure case. What it does NOT prove: the minutes bound on a real machine. The wall clock per source
 * is printed below; on the mock reader it is milliseconds and says nothing about a real model.
 */
const demo = JSON.parse(readFileSync('tests/fixtures/compare-demo/notes.json', 'utf8')) as {
  seed: { title: string; text: string };
  change: { title: string; text: string };
};

const PAGE_A = 'http://fixture.test/orchard-seed';
const PAGE_B = 'http://fixture.test/orchard-meeting';

async function servePages(page: Page, opts: { failB?: boolean } = {}) {
  const body = (url: string) => {
    const note = url.includes('seed') ? demo.seed : demo.change;
    return `Title: ${note.title}\n\n${note.text}`;
  };
  // The page itself (the Turtle probe) and the reader proxy the app actually fetches through.
  await page.route('http://fixture.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>${route.request().url()}</body></html>` }));
  await page.route('https://r.jina.ai/**', (route) => {
    const url = route.request().url().replace('https://r.jina.ai/', '');
    if (opts.failB && url === PAGE_B) return route.fulfill({ status: 404, body: 'gone' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: body(url) });
  });
}

async function dbSnapshot(page: Page) {
  return page.evaluate(async () => {
    const runtimeImport = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await runtimeImport('/src/lib/storage/db.ts');
    const sources = (await db.sources.toArray()) as { id: string; uri: string }[];
    const stmts = (await db.statements.toArray()) as { s: { value: string }; p: { value: string }; o: { value: string }; sourceId: string }[];
    return {
      sources: sources.map((s) => ({ id: s.id, uri: s.uri })),
      stmts: stmts.map((s) => ({ s: s.s.value, p: s.p.value.split('/').pop(), o: s.o.value, sourceId: s.sourceId })),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
});

async function openEntry(page: Page) {
  await page.goto('/ingest');
  await page.getByTestId('tab-compare').click();
  await expect(page.getByTestId('two-source')).toBeVisible();
  await expect(page.getByTestId('cmp-start')).toBeDisabled();
}

test('two web pages become one named comparison, each statement keeps its source, the link has the contract form', async ({ page }) => {
  await servePages(page);
  await openEntry(page);
  await page.getByTestId('cmp-name').fill('Orchard seed vs meeting');
  await page.getByTestId('cmp-url-a').fill(PAGE_A);
  await page.getByTestId('cmp-url-b').fill(PAGE_B);
  const t0 = Date.now();
  await page.getByTestId('cmp-start').click();
  await expect(page.getByTestId('cmp-done')).toBeVisible({ timeout: 60_000 });
  const wall = Date.now() - t0;

  await expect(page.getByTestId('cmp-side-a')).toContainText('added');
  await expect(page.getByTestId('cmp-side-b')).toContainText('added');
  await expect(page.getByTestId('cmp-total')).toContainText('measured on this device');

  const snap = await dbSnapshot(page);
  const a = snap.sources.find((s) => s.uri === PAGE_A)!;
  const b = snap.sources.find((s) => s.uri === PAGE_B)!;
  expect(a && b).toBeTruthy();
  const perSource = (id: string) => snap.stmts.filter((s) => s.sourceId === id);
  expect(perSource(a.id).length).toBe(3);
  expect(perSource(b.id).length).toBe(4);
  // Every statement is attributable: it carries the id of a source that exists, or the comparison record's own tag.
  const known = new Set(snap.sources.map((s) => s.id));
  for (const st of snap.stmts) expect(known.has(st.sourceId) || st.sourceId === 'comparison', st.p ?? '').toBe(true);

  // The comparison is recorded: label, both source ids, when.
  const rec = snap.stmts.filter((s) => s.s.startsWith('urn:reckons:comparison/'));
  expect(rec.find((s) => s.p === 'rdf-schema#label' && s.o === 'Orchard seed vs meeting')).toBeTruthy();
  expect(rec.find((s) => s.p === 'comparison-source-a')?.o).toBe(a.id);
  expect(rec.find((s) => s.p === 'comparison-source-b')?.o).toBe(b.id);
  expect(rec.find((s) => s.p === 'comparison-made-at')).toBeTruthy();

  const href = await page.getByTestId('cmp-link').getAttribute('href');
  expect(href).toBe(`/?layout=compare&a=${a.id}&b=${b.id}`);
  console.log(`[two-source e2e] both pages, mock reader: whole run ${wall} ms wall clock (mock only; not a real-model measurement)`);
});

test('a file and a page work together, and the comparison survives a reload', async ({ page }) => {
  await servePages(page);
  await openEntry(page);
  await page.getByTestId('cmp-name').fill('File vs page');
  await page.getByTestId('cmp-file-a').setInputFiles({ name: 'orchard-seed.txt', mimeType: 'text/plain', buffer: Buffer.from(demo.seed.text) });
  await page.getByTestId('cmp-url-b').fill(PAGE_B);
  await page.getByTestId('cmp-start').click();
  await expect(page.getByTestId('cmp-done')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('cmp-side-a')).toContainText('added');
  await expect(page.getByTestId('cmp-link')).toHaveAttribute('href', /^\/\?layout=compare&a=[^&]+&b=[^&]+$/);
  await page.reload();
  await waitForApp(page);
  const snap = await dbSnapshot(page);
  expect(snap.stmts.filter((s) => s.p === 'comparison-source-a' && s.o).length).toBe(1);
});

test('a failed source is named, the other still completes, and the link opens with the source that worked', async ({ page }) => {
  await servePages(page, { failB: true });
  await openEntry(page);
  await page.getByTestId('cmp-name').fill('One gone');
  await page.getByTestId('cmp-url-a').fill(PAGE_A);
  await page.getByTestId('cmp-url-b').fill(PAGE_B);
  await page.getByTestId('cmp-start').click();
  await expect(page.getByTestId('cmp-done')).toBeVisible({ timeout: 60_000 });

  const sideB = page.getByTestId('cmp-side-b');
  await expect(sideB).toContainText('failed');
  await expect(sideB).toContainText('Reader failed: 404');
  await expect(page.getByTestId('cmp-side-a')).toContainText('added');

  const snap = await dbSnapshot(page);
  const a = snap.sources.find((s) => s.uri === PAGE_A)!;
  expect(snap.sources.find((s) => s.uri === PAGE_B)).toBeUndefined();
  await expect(page.getByTestId('cmp-link')).toHaveAttribute('href', `/?layout=compare&a=${a.id}`);
  const rec = snap.stmts.filter((s) => s.s.startsWith('urn:reckons:comparison/'));
  expect(rec.find((s) => s.p === 'comparison-failed-b')?.o).toBe('Reader failed: 404');
  expect(rec.find((s) => s.p === 'comparison-source-b')).toBeUndefined();
});
