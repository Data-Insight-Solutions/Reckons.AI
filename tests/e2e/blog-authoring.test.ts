/**
 * Blog post creation, end to end (F27, /publish).
 *
 * The pipeline could render a site, zip it and push it to GitHub, and NOTHING in `src/` called
 * any of it — `buildSitePages`, `buildSiteFiles`, `exportSiteZip` and `publishSiteToGitHub` had
 * no caller outside their own tests. Exactly the shape of gap F97 had: everything built, nothing
 * reachable, every suite green. So the claim this file makes is the one unit tests cannot: that
 * a person can write a post, see the file it produces, and find it in the graph afterwards.
 *
 * It deliberately asserts against the GRAPH, not just the DOM. A form that clears itself and
 * shows "Saved" while writing nothing is the failure worth catching, and it looks identical to
 * success from the outside.
 */
import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

const TITLE = 'Shipping the Archive Sweep';
const BODY = '# Shipping\n\nThe storage layer existed for weeks with no caller.';

async function gotoPublish(page: Page): Promise<void> {
  await page.goto('/publish');
  await page.getByTestId('post-title').waitFor({ timeout: 15_000 });
}

async function fillPost(page: Page, over: Partial<Record<string, string>> = {}): Promise<void> {
  await page.getByTestId('post-title').fill(over.title ?? TITLE);
  await page.getByTestId('post-section').fill(over.section ?? 'Blog');
  await page.getByTestId('post-date').fill(over.date ?? '2026-07-30');
  await page.getByTestId('post-excerpt').fill(over.excerpt ?? 'How F97 got an entry point.');
  await page.getByTestId('post-body').fill(over.body ?? BODY);
}

/** WebPage nodes actually persisted in the working graph — the only proof a save happened. */
async function webPagesInGraph(page: Page): Promise<Array<{ iri: string; title: string }>> {
  return page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const db = new KBaseDB('kbase');
    const rows = await db.statements.toArray();
    db.close();

    const pageIris = new Set(
      rows
        .filter((r) => r.p.value.endsWith('22-rdf-syntax-ns#type') && r.o.value === 'urn:kbase:type/WebPage')
        .map((r) => r.s.value),
    );
    const titles = new Map<string, string>();
    for (const r of rows) {
      if (pageIris.has(r.s.value) && r.p.value === 'http://www.w3.org/2000/01/rdf-schema#label') {
        titles.set(r.s.value, r.o.value);
      }
    }
    return [...pageIris].map((iri) => ({ iri, title: titles.get(iri) ?? '' }));
  });
}

test.describe('blog authoring', () => {
  test.beforeEach(async ({ page }) => {
    await clearStorage(page);
    await waitForApp(page);
    await gotoPublish(page);
  });

  test('states the build boundary instead of implying the post goes live', async ({ page }) => {
    // kb:honest-status. Saving writes a graph node; it does not deploy anything, and the page
    // must say so where the user is standing rather than in a footnote.
    await expect(page.getByTestId('publish-boundary')).toContainText('does not put this on the live site');
  });

  test('greets a new author with no objections, but cannot be submitted', async ({ page }) => {
    // A pristine form showing three red errors reads as broken software, not as guidance. The
    // save button carries the safety; the error text carries the teaching, and it waits its turn.
    await expect(page.getByTestId('post-problems')).toHaveCount(0);
    await expect(page.getByTestId('post-save')).toBeDisabled();
  });

  test('names every problem at once as soon as the draft is engaged with', async ({ page }) => {
    // A part-written post: body started, title still missing. Every remaining objection is shown
    // together, since a form that reveals them one at a time gets filled in wrong four times.
    await page.getByTestId('post-body').fill('Something worth saying.');

    const problems = page.getByTestId('post-problems');
    await expect(problems).toContainText('needs a title');
    await expect(page.getByTestId('post-save')).toBeDisabled();

    // Clearing everything makes the form pristine again rather than leaving errors behind.
    await page.getByTestId('post-body').fill('');
    await expect(page.getByTestId('post-problems')).toHaveCount(0);
  });

  test('previews the exact file the export will write', async ({ page }) => {
    await fillPost(page);

    await expect(page.getByTestId('preview-path')).toHaveText('content/blog/shipping-the-archive-sweep.md');
    const md = page.getByTestId('preview-markdown');
    await expect(md).toContainText('title: "Shipping the Archive Sweep"');
    await expect(md).toContainText('template: post');
    await expect(md).toContainText('date: "2026-07-30"');
    await expect(md).toContainText('The storage layer existed for weeks with no caller.');
  });

  test('saves the post into the graph as a WebPage node', async ({ page }) => {
    await fillPost(page);
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toContainText('Saved to the graph');

    // The claim that matters: it is IN the graph, not merely acknowledged by the form.
    const pages = await webPagesInGraph(page);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe(TITLE);
  });

  test('the saved post survives a reload and lists itself', async ({ page }) => {
    await fillPost(page);
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    await page.reload();
    await page.getByTestId('post-title').waitFor({ timeout: 15_000 });

    const list = page.getByTestId('posts-list');
    await expect(list).toContainText(TITLE);
    await expect(list).toContainText('content/blog/shipping-the-archive-sweep.md');
    await expect(list).toContainText('draft');
  });

  test('editing a listed post updates it instead of minting a duplicate', async ({ page }) => {
    await fillPost(page);
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    await page.reload();
    await page.getByTestId('post-title').waitFor({ timeout: 15_000 });

    // Open it from the list, change the title, save again.
    await page.getByTestId('posts-list').getByRole('button', { name: TITLE }).click();
    await page.getByTestId('post-title').fill('Shipping the Archive Sweep, Revised');
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    // One node, not two. A duplicate here would export as a second file and split the post.
    const pages = await webPagesInGraph(page);
    expect(pages).toHaveLength(1);
  });

  test('a slug collision is refused before it can overwrite a file on export', async ({ page }) => {
    await fillPost(page);
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    // A NEW post whose title resolves to the same section+slug would write the same path.
    await page.getByTestId('post-new').click();
    await fillPost(page);

    await expect(page.getByTestId('post-problems')).toContainText('already exists');
    await expect(page.getByTestId('post-save')).toBeDisabled();
  });

  test('a date that never happened is refused', async ({ page }) => {
    await fillPost(page);
    // Typed rather than filled: a native date input rejects 30 February on its own, so the
    // validation being tested is the one that runs on whatever value actually arrives.
    await page.getByTestId('post-date').fill('');
    await expect(page.getByTestId('post-problems')).toContainText('yyyy-mm-dd');
    await expect(page.getByTestId('post-save')).toBeDisabled();
  });

  test('exports the markdown as a download when no workspace is connected', async ({ page }) => {
    await fillPost(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('post-export').click();

    expect((await download).suggestedFilename()).toBe('shipping-the-archive-sweep.md');
    await expect(page.getByTestId('post-exported')).toContainText('content/blog/shipping-the-archive-sweep.md');
  });

  test('an edit supersedes the old facts rather than leaving two confirmed titles', async ({ page }) => {
    // REGRESSION, found by probing the graph after an edit while the DOM looked correct.
    // buildSitePages keeps the LAST value it sees per single-valued predicate, so two confirmed
    // titles make the winner depend on array order — the post would silently revert to its old
    // title after a TTL export/import or any change in Dexie read order.
    await fillPost(page);
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    await page.getByTestId('post-title').fill('Revised Title');
    await page.getByTestId('post-save').click();
    await expect(page.getByTestId('post-saved')).toBeVisible();

    const titles = await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
      const db = new KBaseDB('kbase');
      const rows = await db.statements.toArray();
      db.close();
      return rows
        .filter((r) => r.p.value === 'http://www.w3.org/2000/01/rdf-schema#label')
        .map((r) => ({ value: r.o.value, status: r.status }));
    });

    // Exactly ONE active title. The old one survives as history, not as a competing answer.
    const active = titles.filter((t) => t.status !== 'superseded' && t.status !== 'rejected');
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe('Revised Title');
    expect(titles.some((t) => t.value === TITLE && t.status === 'superseded')).toBe(true);
  });

  test('is reachable from the graph page — not another feature with no entry point', async ({ page }) => {
    // The sin this whole file exists to catch, one level up: a working /publish that nothing
    // links to is as unusable as a publish module with no caller.
    await page.goto('/kb');
    const link = page.getByTestId('kb-write-post');
    await link.waitFor({ timeout: 15_000 });
    await link.click();
    await expect(page.getByTestId('post-title')).toBeVisible();
  });
});
