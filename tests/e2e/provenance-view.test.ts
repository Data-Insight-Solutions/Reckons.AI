import { test, expect, type Page } from '@playwright/test';

async function seedProvenance(page: Page, prefer2D: boolean) {
  await page.goto('/');
  await page.locator('nav').waitFor();
  await page.evaluate(async (prefer2D) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { db } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { iri, lit } = await runtimeImport('/src/lib/rdf/types.ts') as typeof import('../../src/lib/rdf/types');
    const at = Date.UTC(2026, 8, 10);
    const srcs = [
      { id: 'interview', title: 'Field interview', kind: 'note' as const },
      { id: 'followup', title: 'Follow-up document', kind: 'document' as const },
      { id: 'import', title: 'Imported team graph', kind: 'turtle' as const },
      ...Array.from({ length: 4 }, (_, n) => ({ id: `extra-${n}`, title: `Older source ${n}`, kind: 'note' as const })),
    ].map((source, n) => ({ ...source, uri: `https://example.test/${source.id}`, ingestedAt: at - n * 86_400_000 }));
    const st = (id: string, sourceId: string, subject: string, predicate: string, object: ReturnType<typeof iri> | ReturnType<typeof lit>, extra = {}) => ({
      id, sourceId, s: iri(`urn:provenance-test/${subject}`), p: iri(predicate), o: object,
      g: iri(`urn:kbase:source/${sourceId}`), confidence: 0.8, status: 'confirmed' as const,
      createdAt: at, updatedAt: at, ...extra,
    });
    const kp = 'urn:kbase:predicate/';
    const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const skos = 'http://www.w3.org/2004/02/skos/core#';
    const facts = [
      st('alice-role', 'interview', 'Alice', `${kp}role`, lit('Engineer'), { extractionRunId: 'run-interview', excerpt: 'Alice is an engineer.', grounded: true }),
      st('bob-role', 'interview', 'Bob', `${kp}role`, lit('Researcher'), { status: 'pending', extractionRunId: 'run-interview' }),
      st('bad-role', 'interview', 'Nobody', `${kp}role`, lit('Rejected candidate'), { status: 'rejected' }),
      st('alice-note', 'followup', 'Alice', `${kp}description`, lit('Works with the research team'), { status: 'pending' }),
      st('team-type', 'import', 'Team', `${rdf}type`, iri(`${skos}Collection`)),
      st('team-label', 'import', 'Team', `${skos}prefLabel`, lit('Research team')),
      ...['Alice', 'Bob', 'Carol'].map((name) => st(`member-${name}`, 'import', 'Team', `${skos}member`, iri(`urn:provenance-test/${name}`))),
      ...Array.from({ length: 4 }, (_, n) => st(`older-${n}`, `extra-${n}`, `Older-${n}`, `${kp}description`, lit('Older fact'))),
    ];
    await db.sources.bulkPut(srcs);
    await db.statements.bulkPut(facts);
    await db.extractionRuns.put({
      id: 'run-interview', sourceId: 'interview', sourceHash: 'fixture', pipelineVersion: 'fixture-v1', promptId: 'fixture',
      startedAt: at, endedAt: at + 1000, status: 'succeeded',
      route: { policyVersion: 'fixture', selectedBackend: 'ollama', selectedModel: 'local-fixture-model', locality: 'local-network', reason: 'Selected local model', candidates: [],
        attempts: [{ id: 'first', backend: 'ollama', model: 'first-fixture-model', locality: 'local-network', startedAt: at, status: 'failed', error: 'Fixture timeout' },
          { id: 'second', backend: 'ollama', model: 'local-fixture-model', locality: 'local-network', startedAt: at + 100, status: 'succeeded' }] },
      stages: [{ name: 'route', status: 'succeeded' }, { name: 'extract', status: 'succeeded', detail: 'Two statements extracted' },
        { name: 'ground', status: 'succeeded', detail: 'One excerpt matched' }, { name: 'group', status: 'skipped', detail: 'No grouping was recorded during this run' }, { name: 'persist', status: 'succeeded' }],
      candidateStatementCount: 2, outputStatementIds: ['alice-role', 'bob-role'], validationCounts: { grounded: 1, ungrounded: 0 },
    });
    const { updateSettings } = await runtimeImport('/src/lib/stores/settings.svelte.ts') as typeof import('../../src/lib/stores/settings.svelte');
    await updateSettings({ prefer2D });
  }, prefer2D);
  await page.reload();
  await expect(page.getByRole('group', { name: 'Graph perspective' })).toBeVisible({ timeout: 20_000 });
}

for (const prefer2D of [true, false]) {
  test(`provenance summaries, source trail and separate filters work in ${prefer2D ? '2D' : '3D'}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await seedProvenance(page, prefer2D);
    await expect(page.locator('[data-node-key^="src:"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page).toHaveURL(/perspective=sources/);
    await expect(page.locator('.notification-stack')).toHaveCount(0);
    const graph = page.getByRole('region', { name: 'Sources graph' });
    await expect(graph).toHaveAttribute('data-graph-renderer', prefer2D ? '2d' : '3d');
    await expect(graph).toHaveAttribute('data-graph-settled', 'true', { timeout: 25_000 });
    await expect(page.locator('.node-label', { hasText: 'Field interview' })).toBeVisible();
    await expect(page.locator('.node-label', { hasText: 'Follow-up document' })).toBeVisible();
    await expect(page.locator('.node-label', { hasText: 'Imported team graph' })).toBeVisible();
    await expect(page.locator('.source-picker input:checked')).toHaveCount(3);
    await expect(page.getByText('Source filters', { exact: true })).toBeVisible();
    await expect(page.getByText('hubs', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Inspect source Field interview' }).click();
    const details = page.getByRole('region', { name: 'Source details' });
    await expect(details.getByRole('heading', { name: 'How extraction happened' })).toBeVisible();
    await expect(details.locator('.model')).toContainText('local-fixture-model · ollama');
    await expect(details.getByText('2 recorded outputs · 2 retained statements linked to this run.')).toBeVisible();
    await expect(details.getByText('No grouping was recorded during this run')).toBeVisible();
    await expect(details.getByText('skipped', { exact: true })).toBeVisible();
    await details.getByText('Model attempts (2)', { exact: true }).click();
    await expect(details.getByText('Fixture timeout', { exact: true })).toBeVisible();
    await details.getByRole('heading', { name: 'Field interview', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`provenance-${prefer2D ? '2d' : '3d'}-trail.png`) });

    await details.getByRole('button', { name: 'Research team 2 entities →', exact: true }).click();
    await expect(details.locator('.members')).not.toContainText('Carol');
    await details.getByRole('button', { name: 'Expand group', exact: true }).click();
    await expect(graph).toHaveAttribute('data-provenance-nodes', '9');
    await details.locator('.members').getByRole('button', { name: 'Alice', exact: true }).click();
    await expect(page.locator('.node-label-wrap[data-node-key="i:urn:provenance-test/Alice"]')).toHaveCount(1);
    await expect(details.getByText('Field interview', { exact: true }).first()).toBeVisible();
    await expect(details.getByText('Alice is an engineer.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`provenance-${prefer2D ? '2d' : '3d'}-entity.png`) });
    await details.getByRole('button', { name: 'Close source details' }).click();

    await page.locator('.filter-options > summary').click();
    await page.getByLabel('Statement review state').selectOption('pending');
    await page.getByRole('button', { name: 'Inspect source Field interview' }).click();
    await expect(details.getByRole('heading', { name: 'Matching statements (1)' })).toBeVisible();
    await expect(details.locator('[data-statement-id="bob-role"]')).toBeVisible();
    await expect(details.locator('[data-statement-id="alice-role"]')).toHaveCount(0);
    await details.getByRole('button', { name: 'Close source details' }).click();
    await page.getByRole('button', { name: 'Reset source filters' }).click();
    await page.getByLabel('Source kind').selectOption('document');
    await expect(page.locator('.selection-count')).toContainText('1 shown');
    await expect(graph).toHaveAttribute('data-provenance-nodes', '2');
    await page.getByRole('button', { name: 'Statements', exact: true }).click();
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.locator('.selection-count')).toContainText('1 shown');
    await expect(graph).toHaveAttribute('data-provenance-nodes', '2');
    await expect(page.locator('.source-picker > summary')).toContainText('3 selected');
    await page.locator('.filter-options > summary').click();
    await expect(page.getByLabel('Source kind')).toHaveValue('document');
    await page.getByRole('button', { name: 'Reset source filters' }).click();
    await page.getByRole('button', { name: 'Inspect source Imported team graph' }).click();
    await expect(details.getByText('No extraction execution record is available for this source.')).toBeVisible();
    await details.getByRole('button', { name: 'Close source details' }).click();

    await page.getByLabel(/Older source 0/).check();
    await page.getByLabel(/Older source 1/).check();
    await expect(page.getByLabel(/Older source 2/)).toBeDisabled();
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Select sources to explore' })).toBeVisible();
    await page.getByRole('button', { name: 'Statements', exact: true }).click();
    await expect(page.locator('[data-graph-perspective="statements"]')).toBeVisible();
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Select sources to explore' })).toBeVisible();
    expect(errors).toEqual([]);
    const persisted = await page.evaluate(async () => {
      const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
      const { db } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
      return { count: await db.statements.count(), bob: (await db.statements.get('bob-role'))?.status };
    });
    expect(persisted).toEqual({ count: 13, bob: 'pending' });
  });
}

test('provenance source selection and details are reachable on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedProvenance(page, true);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.locator('.source-picker')).not.toHaveAttribute('open', '');
  await page.locator('.source-picker > summary').click();
  await page.getByRole('button', { name: 'Inspect source Field interview' }).click();
  const details = page.getByRole('region', { name: 'Source details' });
  await expect(details.getByRole('heading', { name: 'How extraction happened' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('provenance-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await details.getByRole('button', { name: 'Close source details' }).click();
  await expect(page.getByRole('button', { name: 'Statements', exact: true })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`source sets retain their identity across folders, list, gallery and graph at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await seedProvenance(page, true);
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    const picker = page.locator('.source-picker');
    if (width < 850) await picker.locator(':scope > summary').click();
    const modes = page.getByRole('group', { name: 'Source presentation' });
    const detail = page.getByRole('region', { name: 'Source details' });
    let groupKey: string | null = null;
    for (const mode of ['Folders', 'List', 'Gallery']) {
      await modes.getByRole('button', { name: mode, exact: true }).click();
      const browser = page.getByRole('region', { name: `${mode} of source sets` });
      await expect(browser).toBeVisible();
      await expect(page.getByRole('region', { name: 'Sources graph' })).toHaveCount(0);
      await expect(page.locator('.node-label-wrap')).toHaveCount(0);
      if (mode === 'Folders') {
        const folder = browser.locator('.source-folder').filter({ has: page.locator('summary', { hasText: 'Field interview' }) });
        await folder.locator('.set-folder > summary').click();
        await folder.getByRole('button', { name: 'Inspect set', exact: false }).click();
      } else if (mode === 'List') {
        await browser.getByRole('row').filter({ hasText: 'Field interview' }).getByRole('button', { name: 'Research team', exact: false }).click();
      } else {
        await browser.getByRole('button', { name: 'Open set Research team from Field interview', exact: true }).click();
      }
      await expect(detail.getByRole('heading', { name: 'Research team · 2', exact: true })).toBeVisible();
      const selected = new URL(page.url()).searchParams.get('sel');
      expect(selected).toBeTruthy();
      if (groupKey) expect(selected).toBe(groupKey); else groupKey = selected;
      await expect(detail.locator('.members')).toContainText('Alice');
      await expect(detail.locator('.members')).toContainText('Bob');
      await expect(detail.locator('.members')).not.toContainText('Carol');
      await detail.getByRole('button', { name: 'Close source details' }).click();
      await expect(detail).toHaveCount(0);
      if (width < 850) await picker.locator(':scope > summary').click();
      await page.screenshot({ path: testInfo.outputPath(`sources-${mode.toLowerCase()}-${width}.png`) });
      if (width < 850) await picker.locator(':scope > summary').click();
      await expect(picker).toHaveAttribute('open', '');
    }

    // Filtering a two-member set down to one must preserve its name, key and original statement.
    await picker.locator('.filter-options > summary').click();
    await page.getByLabel('Statement review state').selectOption('pending');
    await page.getByRole('button', { name: 'Open set Research team from Field interview', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Research team · 1', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('sel')).toBe(groupKey);
    await expect(detail.locator('[data-statement-id="bob-role"]')).toBeVisible();
    await expect(detail.locator('.members')).not.toContainText('Alice');
    await detail.locator('.members').getByRole('button', { name: 'Bob', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Close source details' }).click();
    await page.getByRole('button', { name: 'Reset source filters' }).click();

    // A member opened directly from a collapsed folder also opens the shared entity details.
    await modes.getByRole('button', { name: 'Folders', exact: true }).click();
    const folder = page.locator('.source-folder').filter({ has: page.locator('summary', { hasText: 'Field interview' }) });
    await folder.locator('.set-folder > summary').click();
    await folder.getByRole('button', { name: 'Alice', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Alice', exact: true })).toBeVisible();
    await expect(detail.locator('[data-statement-id="alice-role"]')).toBeVisible();
    await expect(detail.locator('[data-statement-id="alice-note"]')).toBeVisible();
    await detail.getByRole('button', { name: 'Field interview extraction history →', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'How extraction happened' })).toBeVisible();
    await detail.getByRole('button', { name: 'Close source details' }).click();

    await modes.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Sources graph' })).toHaveAttribute('data-graph-settled', 'true');
    await expect(page.locator('.node-label-wrap[data-node-key="i:urn:provenance-test/Alice"]')).toHaveCount(1);
    await modes.getByRole('button', { name: 'Gallery', exact: true }).click();
    await page.getByRole('button', { name: 'Statements', exact: true }).click();
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Gallery of source sets' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
