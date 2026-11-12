/** Real-browser check of a splat-embed output folder: no page errors, canvas draws pixels, a drag changes the image. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] ?? '');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.spz': 'application/octet-stream', '.webp': 'image/webp', '.png': 'image/png' };
const server = createServer((req, res) => {
  let u = decodeURIComponent((req.url ?? '/').split('?')[0]); if (u === '/') u = '/index.html';
  try { res.setHeader('content-type', MIME[extname(u)] ?? 'application/octet-stream'); res.end(readFileSync(join(dir, u))); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
const remote: string[] = [];
page.on('request', (r) => { if (!r.url().startsWith(`http://127.0.0.1:${port}`) && !/^(blob|data):/.test(r.url())) remote.push(r.url()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => (window as any).__splatEmbed?.ready || (window as any).__splatEmbed?.failed, null, { timeout: 60000 });
const status = await page.evaluate(() => (window as any).__splatEmbed);
// a still frame: freeze the yaw so the only change is the drag
const sample = async () => (await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const c = document.querySelector('canvas')!; const s = document.createElement('canvas'); s.width = c.width; s.height = c.height;
  const g = s.getContext('2d')!; await new Promise((r) => requestAnimationFrame(r)); g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, s.width, s.height).data; let drawn = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) drawn++;
  return { drawn, total: s.width * s.height, hash: Array.from({ length: 4000 }, (_, k) => d[(k * 977) % d.length]).join(',') };
}));
await page.screenshot({ path: join(dir, 'check-before.png') });
const a = await sample();
await page.mouse.move(300, 300); await page.mouse.down(); await page.mouse.move(420, 300, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
await page.screenshot({ path: join(dir, 'check-after.png') });
const b = await sample();
const before = readFileSync(join(dir, 'check-before.png')), after = readFileSync(join(dir, 'check-after.png'));
console.log(JSON.stringify({ status, errors, remote, drawn: a.drawn, total: a.total, dragChangedCanvas: a.hash !== b.hash, screenshotsDiffer: !before.equals(after) }, null, 2));
await browser.close(); server.close();
process.exit(errors.length || remote.length || status.failed || !a.drawn || a.hash === b.hash ? 1 : 0);
