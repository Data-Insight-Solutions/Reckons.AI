/** Motion proof for a splat-embed folder: frames differ over time (turn + bob), and an animated frame matches a freshly sorted one at the same yaw. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] ?? '');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  let u = decodeURIComponent((req.url ?? '/').split('?')[0]); if (u === '/') u = '/index.html';
  try { res.setHeader('content-type', MIME[extname(u)] ?? 'application/octet-stream'); res.end(readFileSync(join(dir, u))); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 500, height: 500 }, reducedMotion: 'no-preference' });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => (window as any).__splatEmbed?.ready, null, { timeout: 60000 });
const grab = () => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.querySelector('canvas')!; const s = document.createElement('canvas'); s.width = s.height = 125;
  const g = s.getContext('2d')!; g.drawImage(c, 0, 0, 125, 125); return Array.from(g.getImageData(0, 0, 125, 125).data);
});
const diff = (a: number[], b: number[]) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return +(d / a.length).toFixed(2); };
const frames: number[][] = []; const yaws: number[] = [];
const t0 = Date.now();
for (const sec of [0, 1, 2, 4]) {
  const wait = sec * 1000 - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait);
  frames.push(await grab()); yaws.push(await page.evaluate(() => (window as any).__splatEmbed.getYaw()));
}
const consecutive = frames.slice(1).map((f, i) => diff(frames[i], f));
// animated frame at yaw X (pause so bob and yaw hold), then a fresh sort: swing away, return to X, hold still a second
await page.evaluate(() => (window as any).__splatEmbed.pause(true)); await page.waitForTimeout(800);
const X = await page.evaluate(() => (window as any).__splatEmbed.getYaw());
const animated = await grab();
await page.evaluate((x) => (window as any).__splatEmbed.setYaw(x + 2.5), X); await page.waitForTimeout(1200);
await page.evaluate((x) => (window as any).__splatEmbed.setYaw(x), X); await page.waitForTimeout(1500);
const fresh = await grab();
const settled = diff(animated, await grab());
console.log(JSON.stringify({ yaws, consecutiveFrameDiff: consecutive, animatedVsFreshSortDiff: diff(animated, fresh), selfNoise: settled }));
await browser.close(); server.close();
process.exit(consecutive.every((d) => d > 0.5) && diff(animated, fresh) < Math.max(2, settled * 3 + 1) ? 0 : 1);
