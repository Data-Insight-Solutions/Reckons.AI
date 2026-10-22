/**
 * Headless rendering of a generated Three.js scene (F183.3). Serves one folder at
 * /bench-generation/assets/ on a throwaway local port, opens the page in Chromium with software
 * WebGL (so it takes no GPU), and measures: console errors, a canvas, pixel variance of the
 * screenshot, and frames per second over 5 s. The judgement lives in bench-review-lib.ts.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { luminanceVariance, type SceneStats } from './bench-review-lib.js';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png' };
const PREFIX = '/bench-generation/assets/';

export async function serveAssets(dir: string): Promise<{ port: number; close: () => Promise<void>; server: Server }> {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    const rel = normalize(url.slice(PREFIX.length));
    if (!url.startsWith(PREFIX) || rel.startsWith('..')) { res.writeHead(404).end(); return; }
    try { const b = await readFile(join(dir, rel)); res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(b); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, server, close: () => new Promise((r) => server.close(() => r())) };
}

/** Open `file` (inside the served folder), measure it, write the screenshot as WebP to `shot`. */
export async function renderScene(port: number, file: string, shot: string, htmlBytes: number): Promise<SceneStats> {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 300)));
    page.on('requestfailed', (r) => errors.push(`request failed: ${r.url().replace(/^https?:\/\/[^/]+/, '')}`));
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: number };
      w.__frames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => { w.__frames++; cb(t); });
    });
    await page.goto(`http://127.0.0.1:${port}${PREFIX}${file}`, { waitUntil: 'load', timeout: 10_000 }).catch((e) => errors.push(`load: ${String(e.message).split('\n')[0]}`));
    await page.waitForTimeout(1500);
    const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas')).catch(() => false);
    await page.evaluate(() => { (window as unknown as { __frames: number }).__frames = 0; });
    await page.waitForTimeout(5000);
    const frames = await page.evaluate(() => (window as unknown as { __frames: number }).__frames).catch(() => 0);
    const png = await page.screenshot({ type: 'png' });
    await sharp(png).webp({ quality: 85 }).toFile(shot);
    const raw = await sharp(png).resize(128, 96, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    return { errors: [...new Set(errors)].slice(0, 5), hasCanvas, variance: luminanceVariance(raw), fps: frames / 5, htmlBytes };
  } finally { await browser.close(); }
}
