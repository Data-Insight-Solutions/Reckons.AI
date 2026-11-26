import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearStorage, waitForApp } from './helpers';

/**
 * F312: review image options inside a knowledge base. One generated from SYNTHETIC images (flat coloured squares made here,
 * never a real picture, built by the real CLI in a child process because Playwright's loader cannot load n3) is loaded through populateKbFromTtl, the function the folder/zip/GitHub import paths all call
 * (a folder picker cannot be driven headless), then the Reckoning page lists the decision, shows each option with its
 * picture, and accepting one goes through the existing OptionDecision: the other options become superseded.
 */
function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function squarePng(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const size = 16;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function syntheticSpace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'optrev-e2e-'));
  const img = (name: string, rgb: [number, number, number]) => { const p = path.join(dir, name); writeFileSync(p, squarePng(...rgb)); return p; };
  const input = path.join(dir, 'decisions.json');
  writeFileSync(input, JSON.stringify({
    space: 'Synthetic review',
    decisions: [
      { id: 'service', question: 'Which picture represents Service?', subject: 'Service', predicate: 'represented by',
        options: [{ label: 'Red', image: img('r.png', [200, 40, 40]) }, { label: 'Green', image: img('g.png', [40, 200, 40]) }, { label: 'Blue', image: img('b.png', [40, 40, 200]) }] },
      { id: 'document', question: 'Which picture represents Document?', subject: 'Document', predicate: 'represented by',
        options: [{ label: 'Yellow', image: img('y.png', [220, 200, 40]) }, { label: 'Grey', image: img('k.png', [120, 120, 120]) }] },
    ],
  }));
  const out = path.join(dir, 'out', 'synthetic-review');
  execFileSync('npx', ['tsx', 'scripts/content/option-review-space.ts', '--in', input, '--out', out], { stdio: 'pipe' });
  const icons = readdirSync(path.join(out, 'assets', 'icons'));
  return {
    ttl: readFileSync(path.join(out, 'synthetic-review.ttl'), 'utf8'),
    assets: new Map(icons.map((f) => [`assets/icons/${f}`, readFileSync(path.join(out, 'assets', 'icons', f))] as const)),
  };
}

type Row = { id: string; status: string; p: string; proposalOption?: string };
const rows = (page: Page) => page.evaluate(async () => {
  const out: any[] = [];
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const open = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (open.objectStoreNames.contains('statements')) {
      const all: any[] = await new Promise((res) => { const q = open.transaction('statements').objectStore('statements').getAll(); q.onsuccess = () => res(q.result); });
      for (const st of all) out.push({ id: st.id, status: st.status, p: st.p?.value, proposalOption: st.proposalOption });
    }
    open.close();
  }
  return out as Row[];
});

test('a generated option-review knowledge base: decisions are listed, options show their pictures, accepting one supersedes the others', async ({ page }) => {
  await clearStorage(page);
  await waitForApp(page);
  const space = syntheticSpace();
  const assets = [...space.assets].map(([k, v]) => [k, v.toString('base64')] as const);
  await page.goto('/reckoning');
  const loaded = await page.evaluate(async ({ ttl, assets }) => {
    const imp = (p: string) => import(/* @vite-ignore */ p);
    const { db } = await imp('/src/lib/storage/db.ts');
    const { populateKbFromTtl } = await imp('/src/lib/stores/kb-import.ts');
    const map = new Map<string, Uint8Array>(assets.map(([k, b64]) => [k, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
    const n = await populateKbFromTtl(db, 'Synthetic review', 'fixture://option-review', ttl, map);
    return { n, icons: await db.icon2dOverrides.count() };
  }, { ttl: space.ttl, assets });
  expect(loaded.n).toBeGreaterThan(20);
  expect(loaded.icons).toBe(5); // one image per option
  await page.reload();

  // the decisions are offered
  const list = page.getByTestId('open-decisions');
  await expect(list).toBeVisible({ timeout: 15_000 });
  await expect(list.getByTestId('open-decision')).toHaveCount(2);
  await list.getByTestId('open-decision').filter({ hasText: 'Service' }).click();

  // three options, each with its picture
  const cards = page.getByTestId('proposal-option');
  await expect(cards).toHaveCount(3, { timeout: 15_000 });
  for (let i = 0; i < 3; i++) {
    const image = cards.nth(i).getByTestId('option-image');
    await expect(image).toBeVisible();
    expect(await image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  expect((await rows(page)).filter((r) => r.proposalOption && r.status === 'confirmed')).toHaveLength(0);

  // accept the second option through the existing OptionDecision
  await cards.nth(1).getByTestId('accept-option').click();
  await expect(cards.nth(1).getByTestId('accept-confirm')).toContainText('confirm 1 statement');
  await expect(cards.nth(1).getByTestId('accept-confirm')).toContainText('queue no jobs');
  await cards.nth(1).getByTestId('accept-confirm-yes').click();
  await expect(cards.nth(1).getByText('Accepted by you.')).toBeVisible({ timeout: 15_000 });
  await expect(cards.nth(0).getByText(/Superseded/)).toBeVisible();
  await expect(cards.nth(2).getByText(/Superseded/)).toBeVisible();

  const after = await rows(page);
  const [a, b, c] = ['a', 'b', 'c'].map((k) => `reckoning-service-option-${k}`);
  const status = (opt: string) => [...new Set(after.filter((r) => r.proposalOption === opt).map((r) => r.status))].sort();
  expect(status(b)).toEqual(['confirmed']);
  expect(status(a)).toEqual(['superseded']);
  expect(status(c)).toEqual(['superseded']);
  // the other decision is untouched
  expect(after.filter((r) => r.proposalOption?.startsWith('reckoning-document-option-')).every((r) => r.status === 'pending')).toBe(true);
  // the decision's question was the target, so the proposal closes
  await expect(page.getByTestId('proposal-status')).toContainText('Completed', { timeout: 10_000 });
});
