import { test, expect } from '@playwright/test';

// Real IndexedDB, serializers, importers and folder IO. Drive transport/OAuth are
// replaced in this isolated browser context with synthetic in-memory responses.
for (const backend of ['folder', 'drive'] as const) {
  test(`${backend} round-trip preserves review metadata, sources and binary assets`, async ({ page }) => {
    await page.goto('/notes');
    await expect(page.getByRole('heading', { name: 'Personal Notes', exact: true })).toBeVisible();
    await expect(page.getByText('Opening your notebook…')).toHaveCount(0);
    const result = await page.evaluate(async (backend) => {
      const imp = (path: string) => import(/* @vite-ignore */ path);
      const { KBaseDB } = await imp('/src/lib/storage/db.ts');
      const { createNamedKb } = await imp('/src/lib/storage/kb-naming.ts');
      const { updateSettings } = await imp('/src/lib/stores/settings.svelte.ts');
      const entry = await createNamedKb('Contract fixture');
      const target = new KBaseDB(entry.id);
      const iri = (value: string) => ({ kind: 'iri', value });
      const input = ['confirmed', 'refined', 'pending', 'pending-removal', 'rejected', 'superseded'].map((status, i) => ({
        id: `fixture-${i}`, s: iri('urn:example:thing'), p: iri('urn:example:detail'),
        o: { kind: 'literal', value: `detail ${i}` }, g: iri('urn:example:provenance'), sourceId: 'fixture-source',
        confidence: 0.9, status, createdAt: 1700000000000, updatedAt: 1700000100000,
        proposedBy: 'fixture-agent', grounded: false, settledByDecision: 'fixture-decision',
        settledBy: { actor: 'Example reviewer', channel: 'review', at: 1700000100000 },
      }));
      const sources = [{ id: 'fixture-source', title: 'Synthetic note', uri: 'note://fixture', kind: 'note',
        ingestedAt: 1700000000000, extractionBackend: 'mock', extractionModel: 'fixture-model', hash: 'fixture-hash' }];
      const icon = { id: 'urn:example:thing', url: 'data:image/png;base64,AQID' };
      await target.statements.bulkPut(input);
      await target.sources.bulkPut(sources);
      await target.icon2dOverrides.put(icon);
      let pull: () => Promise<unknown>;
      let changedFile: () => Promise<void>;
      let cleanup = () => {};
      if (backend === 'folder') {
        const ws = await imp('/src/lib/stores/workspace.svelte.ts');
        const root = await navigator.storage.getDirectory();
        ws.__linkHandleForTest(root);
        await ws.syncAllKbs();
        const dirs = await root.getDirectoryHandle('kbs');
        const dir = await dirs.getDirectoryHandle('contract-fixture');
        const file = await dir.getFileHandle('contract-fixture.ttl');
        changedFile = async () => {
          const text = await (await file.getFile()).text();
          const stream = await file.createWritable();
          await stream.write(text + '\n# simulate remote revision\n'); await stream.close();
        };
        pull = () => ws.pullFromWorkspace();
      } else {
        const tokenClient = { callback: (_response: unknown) => {}, requestAccessToken() {
          this.callback({ access_token: 'synthetic-token', expires_in: 3600 });
        } };
        (window as any).google = { accounts: { oauth2: { initTokenClient: () => tokenClient } } };
        await updateSettings({ googleClientId: 'synthetic-client' });
        const files = new Map<string, { id: string; name: string; parent: string; blob: Blob }>();
        const realFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = new URL(String(input));
          if (url.hostname !== 'www.googleapis.com') return realFetch(input, init);
          if (init?.body instanceof FormData) {
            const meta = JSON.parse(await (init.body.get('metadata') as Blob).text());
            const existing = [...files.values()].find(f => url.pathname.endsWith('/' + f.id));
            const id = existing?.id ?? `file-${files.size}`;
            files.set(id, { id, name: meta.name, parent: existing?.parent ?? meta.parents[0], blob: init.body.get('file') as Blob });
            return Response.json({ id });
          }
          if (url.searchParams.get('alt') === 'media') {
            const file = files.get(url.pathname.split('/').pop()!);
            if (!file) throw new Error('Unknown synthetic file');
            return new Response(file.blob);
          }
          const query = url.searchParams.get('q') ?? '';
          if (query.includes('application/vnd.google-apps.folder')) {
            return Response.json({ files: [{ id: query.includes("name = 'assets'") ? 'assets-folder' : 'fixture-folder' }] });
          }
          const parent = query.includes("'assets-folder'") ? 'assets-folder' : 'fixture-folder';
          return Response.json({ files: [...files.values()].filter(f => f.parent === parent).map(f => ({ id: f.id, name: f.name })) });
        };
        const drive = await imp('/src/lib/stores/drive-sync.svelte.ts');
        if (!await drive.linkDriveFolder('Fixture')) throw new Error('Synthetic Drive link failed');
        await drive.driveSyncPush();
        changedFile = async () => {
          const file = [...files.values()].find(f => f.name === 'contract-fixture.ttl');
          if (!file) throw new Error('Graph was not exported');
          file.blob = new Blob([await file.blob.text(), '\n# simulate remote revision\n']);
        };
        pull = () => drive.driveSyncPull();
        cleanup = () => { drive.unlinkDrive(); window.fetch = realFetch; };
      }
      try {
        await target.statements.clear(); await target.sources.clear(); await target.icon2dOverrides.clear();
        await changedFile();
        const outcome = await pull();
        const statements = await target.statements.toArray();
        const restoredSources = await target.sources.toArray();
        const restoredIcon = await target.icon2dOverrides.get(icon.id);
        return { input, sources, icon, statements, restoredSources, restoredIcon, outcome };
      } finally { cleanup(); target.close(); }
    }, backend);
    expect(result.outcome).toMatchObject({ updated: expect.arrayContaining([expect.stringMatching(/contract.fixture/i)]) });
    expect(result.statements).toEqual(result.input);
    expect(result.restoredSources).toEqual(result.sources);
    expect(result.restoredIcon).toEqual(result.icon);
  });
}

test('malformed input and a mid-write failure preserve live data; a snapshot restores prior review metadata', async ({ page }) => {
  await page.goto('/notes');
  await expect(page.getByRole('heading', { name: 'Personal Notes', exact: true })).toBeVisible();
  await expect(page.getByText('Opening your notebook…')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB, DEFAULT_SETTINGS } = await imp('/src/lib/storage/db.ts');
    const { populateKbFromTtl } = await imp('/src/lib/stores/kb-import.ts');
    const { toTurtleFull } = await imp('/src/lib/rdf/serialize.ts');
    const { restoreKbSnapshot } = await imp('/src/lib/storage/kb-snapshots.ts');
    const target = new KBaseDB('synthetic-recovery');
    const iri = (value: string) => ({ kind: 'iri', value });
    const original = { id: 'original', s: iri('urn:example:s'), p: iri('urn:example:p'), o: { kind: 'literal', value: 'original' },
      g: iri('urn:kbase:source/source'), sourceId: 'source', confidence: 1, status: 'pending',
      createdAt: 1700000000000, updatedAt: 1700000100000, settledByDecision: 'example-decision' };
    const source = { id: 'source', title: 'Example', uri: 'note://example', kind: 'note', ingestedAt: 1700000000000 };
    await target.settings.put(DEFAULT_SETTINGS);
    await target.statements.put(original); await target.sources.put(source);
    const replacement = toTurtleFull([{ ...original, id: 'replacement', status: 'confirmed' }], [source]);
    const snapshots: unknown[] = [];
    const errors: string[] = [];
    for (const text of ['<bad turtle', '<urn:kbase:stmt/broken> <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> <urn:example:s> .']) {
      try { await populateKbFromTtl(target, 'Example', 'fixture://invalid', text, new Map()); }
      catch (e) { errors.push(String(e)); }
      snapshots.push(await target.statements.toArray());
    }
    const put = target.statements.bulkPut;
    target.statements.bulkPut = async () => { throw new Error('Injected storage write failure'); };
    try { await populateKbFromTtl(target, 'Example', 'fixture://write-failure', replacement, new Map()); }
    catch (e) { errors.push(String(e)); }
    finally { target.statements.bulkPut = put; }
    snapshots.push(await target.statements.toArray());
    const sourcesAfterFailure = await target.sources.toArray();
    const snapshotCountAfterFailure = await target.kbSnapshots.count();
    await populateKbFromTtl(target, 'Example', 'fixture://replacement', replacement, new Map());
    const [recovery] = await target.kbSnapshots.toArray();
    await restoreKbSnapshot(target, recovery.id);
    const restored = await target.statements.toArray();
    target.close();
    return { original, source, errors, snapshots, sourcesAfterFailure, snapshotCountAfterFailure, restored };
  });
  expect(result.errors).toHaveLength(3);
  expect(result.errors[2]).toContain('Injected storage write failure');
  for (const snapshot of result.snapshots) expect(snapshot).toEqual([result.original]);
  expect(result.sourcesAfterFailure).toEqual([result.source]);
  expect(result.snapshotCountAfterFailure).toBe(0);
  expect(result.restored).toEqual([result.original]);
});
