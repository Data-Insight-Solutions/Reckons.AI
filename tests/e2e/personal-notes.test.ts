import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.goto('/notes');
  await expect(page.getByRole('heading', { name: 'Personal Notes', exact: true })).toBeVisible();
  await expect(page.getByText('Opening your notebook…')).toHaveCount(0);
  const ids = await page.evaluate(async () => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { createNamedKb } = await imp('/src/lib/storage/kb-naming.ts');
    const { personalNotesPolicy } = await imp('/src/lib/storage/personal-notes.ts');
    const project = await createNamedKb('Garden Project');
    const other = await createNamedKb('Private Journal');
    return { project: project.id as string, other: other.id as string, inbox: (await personalNotesPolicy()).inboxId as string };
  });
  await page.reload();
  await expect(page.getByText('Opening your notebook…')).toHaveCount(0);
  return ids;
}

test('save without extraction, review an excerpt, and copy only to an allowed graph', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await setup(page);
  const original = 'Plant the new herbs on Saturday.\n\nPrivate journal: I need time to think. ';
  await page.getByLabel('What’s on your mind?').fill(original);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved on this browser');
  await expect(page.getByLabel('Text to send')).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Approve and send copy' })).toBeDisabled();

  await page.getByText('Allowed graphs', { exact: false }).filter({ hasNot: page.locator('option') }).first().click();
  await page.getByLabel('Garden Project', { exact: true }).check();
  await page.getByLabel('Destination graph').selectOption(ids.project);
  await page.getByLabel('Text to send').fill('Plant the new herbs on Saturday.');
  await page.screenshot({ path: testInfo.outputPath('personal-notes-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve and send copy' }).click();
  await expect(page.getByRole('status')).toContainText('Copied to Garden Project');
  await page.reload();
  await expect(page.locator('.history')).toContainText('Copied');
  const snapshot = await page.evaluate(async (ids) => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await imp('/src/lib/storage/db.ts');
    const result: Record<string, unknown[]> = {};
    for (const [key, id] of Object.entries(ids)) {
      const graph = new KBaseDB(id);
      result[key] = await graph.statements.toArray(); graph.close();
    }
    return result;
  }, ids);
  expect(snapshot.other).toEqual([]);
  expect(snapshot.project).toHaveLength(2);
  expect(JSON.stringify(snapshot.project)).not.toContain('Private journal');
  expect(snapshot.inbox).toEqual([expect.objectContaining({ o: { kind: 'literal', value: original } })]);
  expect(snapshot.project.every((s: any) => s.status === 'pending')).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('voice queue drains to the inactive personal graph and is acknowledged after its Turtle file is saved', async ({ page }) => {
  const ids = await setup(page);
  const result = await page.evaluate(async (ids) => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const { KBaseDB } = await imp('/src/lib/storage/db.ts');
    const { getCurrentKbId } = await imp('/src/lib/storage/kb-registry.ts');
    const ws = await imp('/src/lib/stores/workspace.svelte.ts');
    const { importTurtleFull } = await imp('/src/lib/rdf/import-ttl.ts');
    const root = await navigator.storage.getDirectory();
    ws.__linkHandleForTest(root);
    const queue = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    const row = { kb: 'Garden Project', subject: 'urn:test:voice-note', predicate: 'urn:kbase:predicate/captured-note',
      object: 'For Garden Project: buy seeds. Private aside stays here.', objectKind: 'literal',
      agent: 'ios-shortcut', addedAt: '2026-09-14T12:00:00.000Z' };
    const unrelated = JSON.stringify({ ...row, kb: 'Unknown Graph', predicate: 'urn:test:claim' });
    const malformed = '{bad-json';
    const write = async (text: string) => { const stream = await queue.createWritable(); await stream.write(text); await stream.close(); };
    await write([JSON.stringify(row), JSON.stringify(row), unrelated, malformed, ''].join('\n'));
    const written = await ws.drainAndImportPending();
    const left = await (await queue.getFile()).text();
    const inbox = new KBaseDB(ids.inbox);
    const project = new KBaseDB(ids.project);
    const notes = await inbox.statements.toArray();
    const targetCount = await project.statements.count();
    const kbs = await root.getDirectoryHandle('kbs');
    const dir = await kbs.getDirectoryHandle('personal-notes');
    const ttl = await (await (await dir.getFileHandle('personal-notes.ttl')).getFile()).text();
    const exported = await importTurtleFull(ttl);
    // A conflicting retry must not overwrite the original or fall into the active importer.
    const conflicting = JSON.stringify({ ...row, kb: getCurrentKbId(), object: 'Different text under the same identity' });
    await write(`${conflicting}\n`);
    const retried = await ws.drainAndImportPending();
    const conflictLeft = await (await queue.getFile()).text();
    inbox.close(); project.close();
    return { written, left, unrelated, malformed, notes, targetCount, exported: exported.statements,
      active: getCurrentKbId(), retried, conflictLeft, conflicting };
  }, ids);
  expect(result.active).not.toBe(ids.inbox);
  expect(result.written).toBe(1);
  expect(result.left).toBe(`${result.unrelated}\n${result.malformed}\n`);
  expect(result.notes).toHaveLength(1);
  expect(result.targetCount).toBe(0);
  expect(result.exported).toHaveLength(1);
  expect(result.exported[0].o).toEqual(result.notes[0].o);
  expect(result.retried).toBe(0);
  expect(result.conflictLeft).toBe(`${result.conflicting}\n`);
});

test('revocation cancels queued approvals; retries after a receipt failure never duplicate or overwrite a copy', async ({ page }) => {
  const ids = await setup(page);
  const result = await page.evaluate(async (ids) => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const notes = await imp('/src/lib/storage/personal-notes.ts');
    const { appDb } = await imp('/src/lib/storage/app-db.ts');
    const { KBaseDB } = await imp('/src/lib/storage/db.ts');
    const iri = await notes.savePersonalNote('The whole original');
    let denied = false;
    try { await notes.approveNoteTransfer(iri, ids.other, 'A copy'); } catch { denied = true; }
    await notes.allowNotesDestination(ids.project, true);
    const first = await notes.approveNoteTransfer(iri, ids.project, 'Only this part');
    await notes.allowNotesDestination(ids.project, false);
    await notes.deliverApprovedNoteTransfers();
    const cancelled = (await appDb.noteTransfers.get(first.id)).state;
    await notes.allowNotesDestination(ids.project, true);
    await notes.deliverApprovedNoteTransfers();
    const target = new KBaseDB(ids.project);
    const beforeReapproval = await target.statements.count();
    const approved = await notes.approveNoteTransfer(iri, ids.project, 'Only this part');
    // Fail between the destination commit and the outbox receipt, the cross-database crash window.
    const realUpdate = appDb.noteTransfers.update.bind(appDb.noteTransfers);
    let fail = true;
    appDb.noteTransfers.update = async (key: string, changes: any) => {
      if (changes.state === 'delivered' && fail) { fail = false; throw new Error('Injected receipt failure'); }
      return realUpdate(key, changes);
    };
    try { await notes.deliverApprovedNoteTransfers(); } finally { appDb.noteTransfers.update = realUpdate; }
    const pending = await appDb.noteTransfers.get(approved.id);
    const copied = (await target.statements.toArray()).find((s: any) => s.p.value.endsWith('/captured-note'));
    await target.statements.update(copied.id, { o: { kind: 'literal', value: 'User edited the destination copy' }, status: 'refined' });
    await notes.deliverApprovedNoteTransfers();
    const final = await appDb.noteTransfers.get(approved.id);
    const content = await target.statements.toArray();
    const sources = await target.sources.count(); target.close();
    return { denied, cancelled, beforeReapproval, pending: pending.state, final: final.state, content, sources };
  }, ids);
  expect(result.denied).toBe(true);
  expect(result.cancelled).toBe('cancelled');
  expect(result.beforeReapproval).toBe(0);
  expect(result.pending).toBe('approved');
  expect(result.final).toBe('delivered');
  expect(result.content).toHaveLength(2);
  expect(result.sources).toBe(1);
  expect(result.content).toContainEqual(expect.objectContaining({ o: { kind: 'literal', value: 'User edited the destination copy' }, status: 'refined' }));
});
