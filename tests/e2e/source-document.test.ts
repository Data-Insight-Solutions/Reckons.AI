import { test, expect, type Page } from '@playwright/test';

// The Source View's source side (kb:source-corpus, F221): a source's retained text, cut into
// passages, each with the statements that came from it. Synthetic text only.
async function seed(page: Page) {
  await page.goto('/');
  await page.locator('nav').waitFor();
  await page.evaluate(async () => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { iri, lit } = await runtimeImport('/src/lib/rdf/types.ts') as typeof import('../../src/lib/rdf/types');
    const { retainSourceCorpus } = await runtimeImport('/src/lib/stores/source-corpus.ts') as typeof import('../../src/lib/stores/source-corpus');
    const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts') as typeof import('../../src/lib/stores/settings.svelte');
    const at = Date.UTC(2026, 9, 6);
    // ~12k characters with the default 4000-character cut: three passages.
    const para = (n: number) => `Section ${n} describes the harbor ferry schedule in plain terms. `.repeat(9).trim();
    const text = Array.from({ length: 20 }, (_, i) => para(i + 1)).join('\n\n');
    await db.sources.bulkPut([
      { id: 'memo', title: 'Harbor memo', kind: 'document', uri: 'https://example.test/memo', hash: 'memo-hash-0001', ingestedAt: at },
      { id: 'bare', title: 'Unkept note', kind: 'note', uri: 'https://example.test/bare', hash: 'bare-hash-0001', ingestedAt: at - 1000 },
    ]);
    const st = (id: string, sourceId: string, subject: string, extra: object) => ({
      id, sourceId, s: iri(`urn:source-doc-test/${subject}`), p: iri('urn:kbase:predicate/mentions'), o: lit(`fact ${id}`),
      g: iri(`urn:kbase:source/${sourceId}`), confidence: 0.8, status: 'confirmed' as const, createdAt: at, updatedAt: at, ...extra,
    });
    await db.statements.bulkPut([
      st('early', 'memo', 'Ferry', { excerpt: 'Section 2 describes the harbor ferry schedule in plain terms.', grounded: true }),
      st('late', 'memo', 'Pier', { excerpt: 'Section 19 describes the harbor ferry schedule in plain terms.', grounded: true, status: 'pending' }),
      st('loose', 'memo', 'Tide', { status: 'pending' }),
      st('bare-fact', 'bare', 'Note', { excerpt: 'kept nowhere' }),
    ]);
    const result = await retainSourceCorpus({ sourceId: 'memo', title: 'Harbor memo', hash: 'memo-hash-0001', text });
    if (result.status !== 'retained') throw new Error(`retain failed: ${JSON.stringify(result)}`);
    await updateSettings({ prefer2D: true });
  });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Graph perspective' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page).toHaveURL(/perspective=sources/);
}

for (const width of [1280, 390]) {
  test(`a source shows its passages and the statements each produced at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await seed(page);

    if (width < 600) await page.locator('.source-picker > summary').click();
    await page.getByRole('button', { name: 'Inspect source Harbor memo' }).click();
    const details = page.getByRole('region', { name: 'Source details' });
    const document = details.getByRole('region', { name: 'Source document' });
    await expect(document.getByRole('heading', { name: 'Document · 3 passages' })).toBeVisible();
    // The whole text is shown, with each passage's yield on its boundary.
    const boundaries = document.locator('.source-document-boundary');
    await expect(boundaries).toHaveCount(3);
    await expect(boundaries.nth(0)).toContainText('1 confirmed');
    await expect(boundaries.nth(1)).toContainText('no statements');
    await expect(boundaries.nth(2)).toContainText('1 pending');

    await boundaries.nth(0).click();
    await expect(boundaries.nth(0)).toHaveAttribute('aria-expanded', 'true');
    const fromFirst = document.getByRole('region', { name: 'Statements from passage 1' });
    await expect(fromFirst.getByRole('heading', { name: 'confirmed (1)' })).toBeVisible();
    await expect(fromFirst).toContainText('fact early');
    await expect(fromFirst).not.toContainText('fact late');

    // An empty passage says nothing was placed, never that it was unread.
    await boundaries.nth(1).click();
    const fromSecond = document.getByRole('region', { name: 'Statements from passage 2' });
    await expect(fromSecond).toContainText('which passages extraction read is not recorded yet');

    // A statement without a quote is listed with its reason rather than guessed into a passage.
    await document.getByRole('button', { name: '1 statement not placed in a passage' }).click();
    await expect(document.getByText('Not placed: no quoted excerpt was saved.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`source-document-${width}.png`) });

    // From a passage to the statement's entity, whose detail carries the statement-side Evidence.
    await boundaries.nth(2).click();
    await document.getByRole('region', { name: 'Statements from passage 3' }).getByRole('button', { name: 'Pier' }).click();
    await expect(details.getByRole('heading', { name: 'Pier', exact: true })).toBeVisible();
    await expect(details.getByRole('region', { name: 'Evidence' })).toContainText('passage 3 of 3');

    // A source whose text was never kept says so. Both sources are selected by default.
    await details.getByRole('button', { name: 'Close source details' }).click();
    if (width < 600 && (await page.locator('.source-picker').getAttribute('open')) === null) await page.locator('.source-picker > summary').click();
    await page.getByRole('button', { name: 'Inspect source Unkept note' }).click();
    await expect(details.getByRole('region', { name: 'Source document' })).toContainText('was not kept');
    expect(errors).toEqual([]);
  });
}
