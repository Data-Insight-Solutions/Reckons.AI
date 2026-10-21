import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStorage, waitForApp } from './helpers';
import { compressSplat } from '../../scripts/content/splat-compress';

/**
 * YOUR ROOM (F58.9.7-.10 / kb:room-scene-space): the guided example space opens from About, its
 * synthetic room loads as the background of the 3D graph with the placed turtle inside it, a bad
 * scan is refused with the reason, and a good one is imported and becomes the background.
 *
 * Headless SwiftShader renders slowly; the canvas reports what it loaded in data-splats
 * ("loaded/failed"), because nothing else in the DOM can say what WebGL drew.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await clearStorage(page);
  await waitForApp(page);
});

/** A tiny valid 3DGS PLY (a flat 20 x 20 grid of Gaussians) built in the page's own bytes. */
function plyBytes(opts: { nan?: boolean } = {}): number[] {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const n = 400;
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${n}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const head = [...Buffer.from(header, 'utf8')];
  const body = Buffer.alloc(n * props.length * 4);
  for (let i = 0; i < n; i++) {
    props.forEach((p, k) => {
      let v = 0;
      if (p === 'x') v = (i % 20) / 10 - 1;
      if (p === 'z') v = Math.floor(i / 20) / 10 - 1;
      if (p === 'opacity') v = 2;
      if (p.startsWith('scale')) v = -3;
      if (p === 'rot_0') v = 1;
      if (opts.nan && i === 3 && p === 'scale_0') v = NaN;
      body.writeFloatLE(v, (i * props.length + k) * 4);
    });
  }
  return [...head, ...body];
}

const bytesFile = (name: string, bytes: number[]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });

async function openYourRoom(page: Page) {
  await page.goto('/about');
  const card = page.locator('.starter-card', { hasText: /your room/i });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 15_000 });
}

test('Your room opens as its own space and the synthetic room loads as the background', async ({ page }) => {
  test.setTimeout(120_000);
  await openYourRoom(page);
  // Two splats are drawn: the room (background) and the placed turtle. The node that carries the
  // room keeps its marker, so the room is not drawn a second time.
  await expect(page.locator('main canvas[data-splats]').first()).toHaveAttribute('data-splats', '2/0', { timeout: 60_000 });
  await page.goto('/kb');
  await expect(page.locator('.kb-entry.current').first()).toContainText(/your room/i, { timeout: 10_000 });
  await expect(page.getByTestId('space-background')).toContainText(/synthetic/i);
  await expect(page.getByTestId('background-settings')).toBeVisible();
});

test('a damaged scan is refused with the reason and changes nothing', async ({ page }) => {
  await page.goto('/kb');
  const panel = page.getByTestId('space-background');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-scan-input').setInputFiles(bytesFile('bad.ply', plyBytes({ nan: true })));
  await expect(page.getByTestId('import-scan-refused')).toContainText(/non-finite/i, { timeout: 10_000 });
  await page.getByTestId('import-scan-input').setInputFiles(bytesFile('notes.txt', [1, 2, 3]));
  await expect(page.getByTestId('import-scan-refused')).toContainText(/not a \.ply, \.spz or \.sog/i);
  await expect(page.getByTestId('background-settings')).toHaveCount(0);
});

test('a good scan is stored in the browser, referenced by name, and becomes the background', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/kb');
  await page.getByTestId('import-scan-input').setInputFiles(bytesFile('living-room.ply', plyBytes()));
  await expect(page.getByRole('status').filter({ hasText: /now the background/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('background-settings')).toBeVisible();
  // The bytes are in IndexedDB, and the triple holds a name, not a data: URI.
  const stored = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const out: { files: number; ref: string | null } = { files: 0, ref: null };
    for (const info of dbs) {
      if (!info.name) continue;
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open(info.name!); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (db.objectStoreNames.contains('splatFiles')) {
        out.files += await new Promise<number>((res) => { const r = db.transaction('splatFiles').objectStore('splatFiles').count(); r.onsuccess = () => res(r.result); });
      }
      if (db.objectStoreNames.contains('statements')) {
        const rows: { p: { value: string }; o: { value: string } }[] = await new Promise((res) => { const r = db.transaction('statements').objectStore('statements').getAll(); r.onsuccess = () => res(r.result); });
        const bg = rows.find((r) => r.p.value === 'urn:kbase:meta/background-splat');
        if (bg) out.ref = bg.o.value;
      }
      db.close();
    }
    return out;
  });
  expect(stored.files).toBe(1);
  expect(stored.ref).toMatch(/^asset:splat\/[0-9a-f]{32}\.ply$/);
  // It loads into the 3D graph from IndexedDB.
  await page.goto('/');
  await expect(page.locator('main canvas[data-splats]').first()).toHaveAttribute('data-splats', '1/0', { timeout: 60_000 });
});

// F58.9.11: compressed scans are decoded by the renderer's own decoder before they are kept.
for (const format of (process.env.RECKONS_SPLAT_GPU ? ['spz', 'sog'] : ['spz']) as ('spz' | 'sog')[]) {
  test(`a .${format} is decoded for a real count and extent, stored, and drawn`, async ({ page }) => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(join(tmpdir(), 'room-compressed-'));
    try {
      writeFileSync(join(dir, 'grid.ply'), Buffer.from(plyBytes()));
      const r = compressSplat(join(dir, 'grid.ply'), { format }); // sog needs RECKONS_SPLAT_GPU
      expect(r.check.pass, r.check.problems.join()).toBe(true);
      await page.goto('/kb');
      await page.getByTestId('import-scan-input').setInputFiles({ name: `grid.${format}`, mimeType: 'application/octet-stream', buffer: readFileSync(join(dir, r.file)) });
      await expect(page.getByRole('status').filter({ hasText: /now the background/i })).toBeVisible({ timeout: 30_000 });
      await page.goto('/');
      await expect(page.locator('main canvas[data-splats]').first()).toHaveAttribute('data-splats', '1/0', { timeout: 60_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a .sog whose archive is not a real SOG is refused with the reason, not stored', async ({ page }) => {
  await page.goto('/kb');
  const zipish = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(200, 7)]);
  await page.getByTestId('import-scan-input').setInputFiles({ name: 'broken.sog', mimeType: 'application/octet-stream', buffer: zipish });
  await expect(page.getByTestId('import-scan-refused')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('background-settings')).toHaveCount(0);
});

// F58.9.16: background settings in the graph view's filters panel, and placement without the large preview.
test('Your room: set surround and scale from the filters panel, place the turtle with the bar, the large preview is gone', async ({ page }) => {
  test.setTimeout(240_000);
  await openYourRoom(page);
  await expect(page.locator('main canvas[data-splats]').first()).toHaveAttribute('data-splats', '2/0', { timeout: 60_000 });

  // The Background section is in the graph view's Filters & layout panel, with the same controls as the Graphs tab.
  const panel = page.getByTestId('graph-background-settings');
  await expect(panel).toBeVisible();
  await panel.getByTestId('bg-mode-backdrop').click();
  await expect(panel.getByTestId('bg-mode-backdrop')).toHaveClass(/active/);
  await panel.getByTestId('bg-mode-surround').click();
  await expect(panel.getByTestId('bg-mode-surround')).toHaveClass(/active/);
  const scale = panel.getByTestId('bg-scale');
  await scale.fill('12');
  await scale.press('Tab');
  await expect(scale).toHaveValue('12');
  // Set focal point: click a point in the 3D view; the room's centre moves to it and the point is stored.
  await panel.getByTestId('set-focal-point').click();
  await expect(panel.getByTestId('background-message')).toContainText(/click the point in the 3d view/i, { timeout: 30_000 });
  await page.locator('main canvas').first().click({ position: { x: 760, y: 420 } });
  await expect(panel.getByTestId('focal-readout')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('background-message')).toContainText(/focal point set|floor plane/i);

  // Open the turtle's splat (selected nodes always show their preview), then start placing.
  await page.goto('/?sel=' + encodeURIComponent('i:urn:reckons:room/turtle'));
  const open = page.getByRole('button', { name: /open asset for splat/i }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
  await expect(page.locator('.asset-large')).toBeVisible();
  const controls = page.getByTestId('splat-placement');
  if (await controls.getByRole('button', { name: /^unplace$/i }).count()) await controls.getByRole('button', { name: /^unplace$/i }).click();
  await controls.getByTestId('place-in-space').click();

  // Placement mode: the large preview is gone, a compact bar floats over the graph instead.
  await expect(page.getByTestId('placement-bar')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.asset-large')).toBeHidden();
  const readout = page.getByTestId('placement-readout');
  await expect(readout).toBeVisible();
  const before = await readout.innerText();
  await page.getByTestId('placement-bar').getByRole('button', { name: 'Move right' }).click();
  // CI runners starve the main thread while the splat renders (this test took 2.4 min there), so the write-then-render round trip gets 20 s, not the 5 s default.
  await expect.poll(() => readout.innerText(), { timeout: 20_000 }).not.toBe(before);
  await page.screenshot({ path: process.env.ROOM_SHOT ?? 'test-results/placement.png' });

  // Escape leaves placement mode.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('placement-bar')).toHaveCount(0);
});
