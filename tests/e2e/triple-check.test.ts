import { test, expect, type Page } from '@playwright/test';
// On a phone the onboarding notice sits over the view-settings button; a person dismisses it first.
async function openViewSettings(page: Page) {
  const fab = page.getByRole('button', { name: 'View settings', exact: true }); await fab.waitFor();
  const dismiss = page.getByRole('button', { name: 'dismiss' });
  for (let i = 0; i < 3 && await dismiss.first().waitFor({ timeout: 3000 }).then(() => true, () => false); i++) await dismiss.first().click();
  await fab.click();
}
for (const width of [1280, 390]) {
  test(`Triple Check persists settings and adds what it finds to Review at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000); await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings/triple-check');
    const enable = page.getByRole('checkbox', { name: 'Keep Triple Check on for this space' });
    await expect(enable).toBeVisible({ timeout: 30000 }); await expect(enable).not.toBeChecked();
    await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { db, KBaseDB } = await runtimeImport('/src/lib/storage/db.ts');
      const { createKb } = await runtimeImport('/src/lib/storage/kb-registry.ts');
      const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts');
      const { loadAll } = await runtimeImport('/src/lib/stores/kb.svelte.ts');
      const current = { id: 'fixture', s: { kind: 'iri', value: 'urn:example:product' }, p: { kind: 'iri', value: 'urn:example:capacity' }, o: { kind: 'literal', value: '100' }, g: { kind: 'iri', value: 'urn:example:source' }, sourceId: 'draft', status: 'pending', confidence: 1, createdAt: 1, updatedAt: 1 };
      await db.statements.clear(); await db.sources.clear(); await db.tripleChecks.clear(); await db.statements.put(current);
      await db.sources.put({ id: 'draft', title: 'Synthetic marketing draft', uri: 'note:synthetic', kind: 'note', ingestedAt: 1 });
      const other = createKb('Engineering reference'), foreign = new KBaseDB(other.id);
      await foreign.statements.put({ ...current, id: 'engineering', status: 'confirmed', sourceId: 'engineering-source', o: { kind: 'literal', value: '200' } }); foreign.close();
      await updateSettings({ tripleCheckWebEnabled: false, prefer2D: true }); await loadAll();
    });
    await enable.check(); await page.getByLabel('Search service').selectOption('firecrawl'); await page.getByLabel('Read evidence from').selectOption('firecrawl'); await page.getByLabel('Evidence model provider').selectOption('ollama');
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible(); await page.reload();
    await expect(enable).toBeChecked(); await expect(page.getByLabel('Search service')).toHaveValue('firecrawl'); await expect(page.getByRole('checkbox', { name: 'Check the internet', exact: true })).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true }); await page.goto('/review?group=source');
    // What the check found is an ordinary pending statement from its own source, in the queue — not a panel beside it.
    const found = page.getByTestId('source-cards').locator('.entity-card').filter({ hasText: 'Engineering reference (another space)' });
    await expect(found).toBeVisible({ timeout: 30000 }); await expect(found).toContainText('200');
    // It disagrees with the pending "100", so a group accept holds it back for its own decision.
    await expect(found).toContainText('held back');
    await page.screenshot({ path: testInfo.outputPath('review-by-source.png'), fullPage: true });
    await page.evaluate(async () => {
      const runtimeImport = (p: string) => import(/* @vite-ignore */ p); const { db } = await runtimeImport('/src/lib/storage/db.ts'); const { loadAll } = await runtimeImport('/src/lib/stores/kb.svelte.ts');
      await db.statements.update('fixture', { o: { kind: 'literal', value: '300' } }); await loadAll();
    });
    await page.goto('/analyze'); await page.getByLabel('Current purposes — one per line').fill('Engineering comparison'); await page.getByRole('button', { name: 'Analyze and apply organization' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Applied 1 purpose' })).toBeVisible();
    const result = await page.evaluate(async () => { const runtimeImport = (p: string) => import(/* @vite-ignore */ p); const { db } = await runtimeImport('/src/lib/storage/db.ts'); return { original: await db.statements.get('fixture'), snapshots: await db.kbSnapshots.count(), members: (await db.statements.toArray()).filter((s: { p: { value: string } }) => s.p.value.endsWith('#member')).length }; });
    expect(result.original.status).toBe('pending'); expect(result.original.o.value).toBe('300'); expect(result.snapshots).toBeGreaterThan(0); expect(result.members).toBe(1);
  });
  test(`Repository shortlist saves a bounded space view at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90000); await page.setViewportSize({ width, height: 900 }); await page.goto('/compare/repositories');
    await expect(page.getByRole('heading', { name: 'Repository comparison views' })).toBeVisible();
    await page.evaluate(async () => {
      const runtimeImport = (p: string) => import(/* @vite-ignore */ p); const { db } = await runtimeImport('/src/lib/storage/db.ts'); const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts'); const { loadAll } = await runtimeImport('/src/lib/stores/kb.svelte.ts');
      await db.statements.clear(); await db.sources.clear(); await updateSettings({ tripleCheckEnabled: false, prefer2D: true, canvasEntityLimit: 25 });
      const rows = [];
      for (let i = 0; i < 100; i++) for (const [p, o] of [['reported-star-count', String(i)], ['reported-license', 'MIT'], ['keywords', 'https://github.com/topics/rdf']]) rows.push({ id: `${i}-${p}`, s: { kind: 'iri', value: i === 0 ? 'https://github.com/Data-Insight-Solutions/Reckons.AI' : `https://github.com/example/repo-${i}` }, p: { kind: 'iri', value: p === 'keywords' ? 'https://schema.org/keywords' : `urn:kbase:predicate/${p}` }, o: { kind: p === 'keywords' ? 'iri' : 'literal', value: o }, g: { kind: 'iri', value: 'urn:source' }, sourceId: 'synthetic', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1 });
      await db.statements.bulkPut(rows); await db.sources.put({ id: 'synthetic', title: 'Synthetic metadata', uri: 'https://example.test/fixture', kind: 'repository', ingestedAt: 1 }); await loadAll();
    });
    await expect(page.getByRole('table', { name: 'Quantitative repository comparison' })).toBeVisible();
    await expect(page.getByLabel('Compare against')).toHaveValue('https://github.com/Data-Insight-Solutions/Reckons.AI');
    await page.getByLabel('View name').fill('RDF shortlist'); await page.getByRole('button', { name: 'Save space view' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'View saved' })).toBeVisible(); await page.screenshot({ path: testInfo.outputPath('repository-comparison.png'), fullPage: true });
    await page.getByRole('link', { name: 'Open focused canvas' }).click();
    if (width === 390) await openViewSettings(page);
    await expect(page.getByLabel('Space view')).toHaveValue(/.+/); await expect(page.getByTestId('space-view-count')).toContainText('6 of 6');
    await page.reload(); if (width === 390) await openViewSettings(page);
    await expect(page.getByLabel('Space view')).toHaveValue(/.+/);
    const count = await page.evaluate(async () => { const runtimeImport = (p: string) => import(/* @vite-ignore */ p); return (await runtimeImport('/src/lib/storage/db.ts')).db.statements.count(); }); expect(count).toBe(300);
  });
}
