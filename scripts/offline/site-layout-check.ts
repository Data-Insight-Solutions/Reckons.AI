#!/usr/bin/env npx tsx
/**
 * site-layout-check (F274.4.3, SCRIPT tier) — the browser half of the landing layout's done-test.
 *
 *   npx tsx scripts/offline/site-layout-check.ts [--site=<site repo> | --dir=<built folder>]
 *        [--pages=/,/about/] [--shots=<folder>] [--widths=390,1440]
 *
 * With --site the site is built (site:build) into a scratch folder first; with --dir an existing
 * static folder is served as is (use it to screenshot a hand-made preview the same way). The default
 * site is the synthetic fixture under src/lib/publish/__tests__/fixtures/landing-site.
 * For every page at every width it loads the page, scrolls to the bottom so reveals fire, and records
 * page errors, console errors, failed requests and horizontal overflow; a full-page screenshot goes to
 * --shots. Exit code 1 when any page has an error or overflows. It judges nothing about looks: the
 * "same layout as the approved preview" call is a person (or visual:local's model) looking at the shots.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildSite } from '../../src/lib/publish/site-build.js';

const flag = (n: string): string | undefined => process.argv.find((a) => a.startsWith('--' + n + '='))?.split('=').slice(1).join('=');
const widths = (flag('widths') ?? '390,1440').split(',').map((w) => parseInt(w, 10));
const pages = (flag('pages') ?? '/').split(',');
const shots = resolve(flag('shots') ?? join(tmpdir(), 'site-layout-shots'));
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

async function main(): Promise<void> {
  let root = flag('dir') ? resolve(flag('dir') as string) : '';
  let scratch = '';
  if (!root) {
    const site = resolve(flag('site') ?? 'src/lib/publish/__tests__/fixtures/landing-site');
    scratch = mkdtempSync(join(tmpdir(), 'site-layout-'));
    root = join(scratch, 'out');
    buildSite({ site, out: root });
  }
  mkdirSync(shots, { recursive: true });

  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch();
  let bad = 0;
  try {
    for (const width of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      for (const path of pages) {
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
        page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
        page.on('requestfailed', (r) => errors.push('request failed: ' + r.url()));
        // The approved preview loads web fonts from a font host; a sandbox with no network is not a layout error.
        await page.goto('http://127.0.0.1:' + port + path, { waitUntil: 'load' });
        await page.evaluate(async () => {
          // 'instant': the pages declare scroll-behavior: smooth, which would make these steps never arrive
          for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 150)); }
          window.scrollTo({ top: 0, behavior: 'instant' });
        });
        await page.waitForTimeout(1500);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        const overflow = m.sw > m.cw;
        const name = (path === '/' ? 'home' : path.replace(/\W+/g, '-').replace(/^-|-$/g, '')) + '-' + width + '.png';
        await page.screenshot({ path: join(shots, name), fullPage: true });
        const ok = errors.length === 0 && !overflow;
        if (!ok) bad++;
        console.log((ok ? 'ok   ' : 'FAIL ') + width + 'px ' + path + '  scrollWidth ' + m.sw + ' / ' + m.cw + (errors.length ? '  errors: ' + errors.join(' | ') : '') + '  -> ' + join(shots, name));
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
