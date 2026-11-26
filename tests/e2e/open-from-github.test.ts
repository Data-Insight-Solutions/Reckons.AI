import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

/**
 * F310 (Matt, 2026-11-25: "Can we make it so people could open a space from github?"). The GitHub API is
 * intercepted with a synthetic Turtle file, so the test proves the flow, not GitHub's availability: the link asks
 * first, Open stores the file as its own space and lands on it, Cancel stores nothing, a bad link says why.
 */
const TTL = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:test:gh/garden> rdfs:label "Garden plan" ; <urn:kbase:predicate/has> <urn:test:gh/bed> .
<urn:test:gh/bed> rdfs:label "Raised bed" .
`;
const LINK = '/about?gh=example-owner/example-repo/spaces/garden.ttl@main';

async function fakeGithub(page: Page) {
  const calls: string[] = [];
  await page.route('https://api.github.com/**', async (route) => {
    calls.push(route.request().url() + ' ' + (route.request().headers()['accept'] ?? ''));
    await route.fulfill({ status: 200, contentType: 'text/plain', body: TTL });
  });
  return calls;
}
const spaceNames = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('kbRegistry') ?? '[]').map((k: { name: string }) => k.name));

test('a GitHub link asks first, then opens the file as its own space', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  const calls = await fakeGithub(page);

  await page.goto(LINK);
  const dialog = page.getByRole('dialog', { name: 'Open a space from GitHub' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('example-owner/example-repo/spaces/garden.ttl @ main');
  expect(calls, 'nothing is fetched before the reader chooses Open').toHaveLength(0);

  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  expect(calls[0]).toContain('https://api.github.com/repos/example-owner/example-repo/contents/spaces/garden.ttl?ref=main');
  expect(calls[0]).toContain('application/vnd.github.raw');
  await expect.poll(() => spaceNames(page), { timeout: 15_000 }).toContain('example-repo: garden.ttl');
  // The space that opened holds the file's facts. Read from the open space's own rows, as the showcase walk does:
  // whether a label is drawn on the canvas depends on the renderer, and CI's draws it differently (CI on #693).
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ '/src/lib/storage/db.ts');
    const rows = (await db.statements.toArray()) as { p: { value: string }; o: { value: string } }[];
    return rows.filter((r) => r.p.value === 'http://www.w3.org/2000/01/rdf-schema#label').map((r) => r.o.value).sort();
  }).catch(() => []), { timeout: 20_000 }).toEqual(expect.arrayContaining(['Garden plan', 'Raised bed']));
});

test('Cancel stores nothing, and a link that names no .ttl file says so', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  const calls = await fakeGithub(page);

  await page.goto(LINK);
  await page.getByRole('dialog', { name: 'Open a space from GitHub' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Open a space from GitHub' })).toHaveCount(0);
  expect(calls).toHaveLength(0);
  expect(await spaceNames(page)).not.toContain('example-repo: garden.ttl');

  await page.goto('/about?gh=example-owner/example-repo/README.md');
  await expect(page.getByRole('alert')).toContainText('does not name a .ttl file');
});
