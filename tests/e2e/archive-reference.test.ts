import { test, expect, type Page } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';

const ARCHIVE_DB = 'kbase_archive_reference_e2e';
const ARCHIVED_ENTITY = 'urn:kbase:concept/test-source';

async function seedArchivedEntity(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    return !!registry.find((entry: { id: string; stableId?: string }) =>
      entry.id === 'kbase' && entry.stableId
    );
  });

  await page.evaluate(async ({ archiveDbName, archivedEntity }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { eventToStatements } = await runtimeImport('/src/lib/rdf/archive.ts') as typeof import('../../src/lib/rdf/archive');
    const registry = JSON.parse(localStorage.getItem('kbRegistry') ?? '[]');
    const parent = registry.find((entry: { id: string; stableId?: string }) => entry.id === 'kbase');
    if (!parent?.stableId) throw new Error('Default graph stable ID was not registered');

    registry.push({
      id: archiveDbName,
      name: 'Default Graph (archives)',
      createdAt: Date.now(),
      archiveOf: parent.stableId,
    });
    localStorage.setItem('kbRegistry', JSON.stringify(registry));

    const workingDb = new KBaseDB('kbase');
    await workingDb.sources.put({
      id: 'archived-source',
      title: 'Archived source',
      uri: 'test://archive-reference',
      kind: 'note',
      ingestedAt: 1,
      trustLevel: 'review',
    });
    workingDb.close();

    const archivedFact = {
      id: 'archived-fact',
      s: { kind: 'iri' as const, value: archivedEntity },
      p: { kind: 'iri' as const, value: 'urn:kbase:predicate/legacy-value' },
      o: { kind: 'literal' as const, value: 'from archive' },
      g: { kind: 'iri' as const, value: 'urn:kbase:source/archived-source' },
      sourceId: 'archived-source',
      confidence: 1,
      status: 'confirmed' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const event = {
      id: 'archive-reference-e2e',
      type: 'delete' as const,
      at: 2,
      actor: 'human' as const,
      entities: [archivedEntity],
      statementCount: 1,
      parentStableId: parent.stableId,
      committed: true,
    };
    const archiveDb = new KBaseDB(archiveDbName);
    await archiveDb.statements.bulkPut([archivedFact, ...eventToStatements(event)]);
    archiveDb.close();
  }, { archiveDbName: ARCHIVE_DB, archivedEntity: ARCHIVED_ENTITY });
}

async function submitMatchingMockIngest(page: Page): Promise<void> {
  await page.goto('/ingest');
  await page.getByPlaceholder(/what is this about/i).first().fill('Archived Match');
  await page.locator('textarea').first().fill('This note mentions the mock test source.');
  await page.getByRole('button', { name: /extract facts/i }).click();
  await expect(page.getByRole('dialog', { name: /archived entity mentioned/i })).toBeVisible({
    timeout: 15_000,
  });
}

async function submitMatchingManualFacts(page: Page): Promise<void> {
  await page.goto('/ingest');
  await page.getByRole('button', { name: /^facts/i }).click();
  await page.getByPlaceholder(/name for this set of notes/i).fill('Manual archived match');
  await page.getByRole('textbox', { name: 'Fact 1 subject' }).fill('test-source');
  await page.getByRole('textbox', { name: 'Fact 1 predicate' }).fill('new-value');
  await page.getByRole('textbox', { name: 'Fact 1 object' }).fill('from manual facts');
  await page.getByRole('button', { name: /add to graph/i }).click();
  await expect(page.getByRole('dialog', { name: /archived entity mentioned/i })).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  await seedArchivedEntity(page);
});

test('cancel at restore-on-reference writes no ingest source, facts, or revert event', async ({ page }) => {
  await submitMatchingMockIngest(page);
  await page.getByRole('button', { name: /cancel ingest/i }).click();
  await expect(page.getByRole('dialog', { name: /archived entity mentioned/i })).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/ingest');

  const state = await page.evaluate(async ({ archiveDbName }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { statementsToEvents } = await runtimeImport('/src/lib/rdf/archive.ts') as typeof import('../../src/lib/rdf/archive');
    const workingDb = new KBaseDB('kbase');
    const [sourceCount, statementCount] = await Promise.all([
      workingDb.sources.count(),
      workingDb.statements.count(),
    ]);
    workingDb.close();
    const archiveDb = new KBaseDB(archiveDbName);
    const events = statementsToEvents(await archiveDb.statements.toArray());
    archiveDb.close();
    return {
      sourceCount,
      statementCount,
      revertCount: events.filter((event) => event.type === 'revert').length,
    };
  }, { archiveDbName: ARCHIVE_DB });

  expect(state).toEqual({ sourceCount: 1, statementCount: 0, revertCount: 0 });
});

test('manual facts shares the archive boundary and cancellation writes nothing', async ({ page }) => {
  await submitMatchingManualFacts(page);
  await page.getByRole('button', { name: /cancel ingest/i }).click();
  await expect(page.getByRole('dialog', { name: /archived entity mentioned/i })).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/ingest');

  const state = await page.evaluate(async ({ archiveDbName }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { statementsToEvents } = await runtimeImport('/src/lib/rdf/archive.ts') as typeof import('../../src/lib/rdf/archive');
    const workingDb = new KBaseDB('kbase');
    const [sourceCount, statementCount] = await Promise.all([
      workingDb.sources.count(),
      workingDb.statements.count(),
    ]);
    workingDb.close();
    const archiveDb = new KBaseDB(archiveDbName);
    const events = statementsToEvents(await archiveDb.statements.toArray());
    archiveDb.close();
    return {
      sourceCount,
      statementCount,
      revertCount: events.filter((event) => event.type === 'revert').length,
    };
  }, { archiveDbName: ARCHIVE_DB });

  expect(state).toEqual({ sourceCount: 1, statementCount: 0, revertCount: 0 });
});

test('restore journals the decision, restores the archived fact, then completes ingest', async ({ page }) => {
  await submitMatchingMockIngest(page);
  await page.getByRole('button', { name: /restore archived/i }).click();
  await page.waitForURL((url) => url.pathname === '/compare', { timeout: 30_000 });

  const state = await page.evaluate(async ({ archiveDbName, archivedEntity }) => {
    const runtimeImport = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await runtimeImport('/src/lib/storage/db.ts') as typeof import('../../src/lib/storage/db');
    const { statementsToEvents } = await runtimeImport('/src/lib/rdf/archive.ts') as typeof import('../../src/lib/rdf/archive');
    const workingDb = new KBaseDB('kbase');
    const statements = await workingDb.statements.toArray();
    const sourceCount = await workingDb.sources.count();
    workingDb.close();
    const archiveDb = new KBaseDB(archiveDbName);
    const events = statementsToEvents(await archiveDb.statements.toArray());
    archiveDb.close();
    return {
      sourceCount,
      restoredFactPresent: statements.some((statement) => statement.id === 'archived-fact'),
      incomingUsesRestoredEntity: statements.some(
        (statement) => statement.id !== 'archived-fact' && statement.s.value === archivedEntity,
      ),
      committedReverts: events.filter(
        (event) => event.type === 'revert' && event.committed === true,
      ).length,
    };
  }, { archiveDbName: ARCHIVE_DB, archivedEntity: ARCHIVED_ENTITY });

  expect(state).toEqual({
    sourceCount: 2,
    restoredFactPresent: true,
    incomingUsesRestoredEntity: true,
    committedReverts: 1,
  });
});
