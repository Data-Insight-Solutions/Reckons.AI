import { test, expect } from '@playwright/test';
import { clearStorage, waitForApp } from './helpers';
import { attachRows, contentId } from '../../scripts/content/scan-attach';

/**
 * F58.9.20 (kb:scan-auto-attach): a scan job queued rows addressed to this space and copied the file
 * to kbs/<space>/assets/splats/. Draining the queue stores the file from the folder and imports the
 * rows as PENDING facts, and the splat viewer mounts the scan. Synthetic bytes only; the folder is the
 * browser's own OPFS directory, linked without the native picker.
 */

/** A tiny valid 3DGS PLY (a flat 20 x 20 grid of Gaussians). */
function plyBytes(): Buffer {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const n = 400;
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${n}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const body = Buffer.alloc(n * props.length * 4);
  for (let i = 0; i < n; i++) {
    props.forEach((p, k) => {
      let v = 0;
      if (p === 'x') v = (i % 20) / 10 - 1;
      if (p === 'z') v = Math.floor(i / 20) / 10 - 1;
      if (p === 'opacity') v = 2;
      if (p.startsWith('scale')) v = -3;
      if (p === 'rot_0') v = 1;
      body.writeFloatLE(v, (i * props.length + k) * 4);
    });
  }
  return Buffer.concat([Buffer.from(header, 'utf8'), body]);
}

test('a drained scan row stores its splat from the folder and the viewer mounts it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);

  const bytes = plyBytes();
  const id = contentId(bytes, 'ply');
  const result = await page.evaluate(async ({ bytes, id, rowsFor }) => {
    const imp = (path: string) => import(/* @vite-ignore */ path);
    const ws = await imp('/src/lib/stores/workspace.svelte.ts');
    const { getCurrentKbId } = await imp('/src/lib/storage/kb-registry.ts');
    const space = getCurrentKbId() as string;
    const root = await navigator.storage.getDirectory();
    ws.__linkHandleForTest(root);
    // The folder the scan job wrote: kbs/<space>/assets/splats/<content id>.
    let dir = await root.getDirectoryHandle('kbs', { create: true });
    for (const seg of [space, 'assets', 'splats']) dir = await dir.getDirectoryHandle(seg, { create: true });
    const w = await (await dir.getFileHandle(id, { create: true })).createWritable();
    await w.write(new Uint8Array(bytes)); await w.close();
    const queue = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    const qw = await queue.createWritable();
    await qw.write(rowsFor.map((r: object) => JSON.stringify({ ...r, kb: space })).join('\n') + '\n'); await qw.close();
    const written = await ws.drainAndImportPending();
    const left = await (await queue.getFile()).text();
    return { space, written, left };
  }, { bytes: [...bytes], id, rowsFor: attachRows('placeholder', id, 'room scan') });

  expect(result.written).toBe(4);
  expect(result.left).toBe('');

  // The blob is in this browser's IndexedDB and every imported statement is a proposal.
  const stored = await page.evaluate(async () => {
    const out = { files: 0, statuses: [] as string[] };
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (db.objectStoreNames.contains('splatFiles')) out.files += await new Promise<number>((res) => { const r = db.transaction('splatFiles').objectStore('splatFiles').count(); r.onsuccess = () => res(r.result); });
      if (db.objectStoreNames.contains('statements')) {
        const rows: { status: string; p: { value: string } }[] = await new Promise((res) => { const r = db.transaction('statements').objectStore('statements').getAll(); r.onsuccess = () => res(r.result); });
        out.statuses.push(...rows.filter((r) => r.p.value.includes('splat') || r.p.value.endsWith('#type')).map((r) => r.status));
      }
      db.close();
    }
    return out;
  });
  expect(stored.files).toBe(1);
  expect(stored.statuses.length).toBeGreaterThan(0);
  expect(stored.statuses.every((s) => s === 'pending')).toBe(true);

  await page.goto('/');
  await expect(page.locator('main canvas[data-splats]').first()).toHaveAttribute('data-splats', '1/0', { timeout: 90_000 });
});
