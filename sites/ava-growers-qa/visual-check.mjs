/**
 * Static-site QA sweep for the Ava Farmers Market site.
 *
 * Runs the checks that catch the defects a human reviewer should never have to
 * find: text that renders invisible, content wider than the phone it is read on,
 * links that 404, images with no alt text, tap targets too small to hit.
 *
 * It deliberately tests WITH JAVASCRIPT DISABLED as well as enabled. The scroll
 * reveal once hid seven blocks of real text in any preview that did not run JS,
 * and that class of bug is invisible to a screenshot taken in a normal browser.
 *
 *   node test/visual-check.mjs [baseUrl]      # default http://localhost:4183
 *
 * Exits non-zero if any FAIL is recorded, so it can gate a deploy.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4183';
const PAGES = ['/', '/about.html', '/contact.html', '/404.html'];
const VIEWPORTS = [
  { name: 'phone',   width: 390,  height: 844 },
  { name: 'phone-sm',width: 320,  height: 700 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'laptop',  width: 1280, height: 900 },
  { name: 'wide',    width: 1920, height: 1080 },
];
const SHOTS = process.env.SHOT_DIR || 'test/screenshots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (level, page, vp, msg) => results.push({ level, page, vp, msg });

const browser = await chromium.launch();

// ── 1. Per viewport: layout, overflow, visibility, tap targets ──────────────
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const path of PAGES) {
    const p = await ctx.newPage();
    const errs = [], bad = [];
    p.on('pageerror', e => errs.push(String(e)));
    p.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });

    await p.goto(BASE + path, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2800);              // let the reveal safety net fire

    errs.forEach(e => rec('FAIL', path, vp.name, `JS error: ${e}`));
    bad.forEach(e => rec('FAIL', path, vp.name, `bad response: ${e}`));

    const audit = await p.evaluate(() => {
      const out = { overflow: null, invisible: [], smallTaps: [], noAlt: [], tiny: [] };
      const de = document.documentElement;
      if (de.scrollWidth > window.innerWidth + 1) {
        const wide = [];
        document.querySelectorAll('body *').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0) return;
          if (r.right > window.innerWidth + 1 || r.left < -1) {
            if (el.closest('.skip')) return;
            wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0,30)}`);
          }
        });
        out.overflow = { scrollW: de.scrollWidth, innerW: window.innerWidth, culprits: [...new Set(wide)].slice(0,5) };
      }
      const visibleText = el => (el.textContent || '').trim().length > 0;
      document.querySelectorAll('p, h1, h2, h3, li, a, span, dd, dt, label, button').forEach(el => {
        if (!visibleText(el)) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (parseFloat(cs.opacity) < 0.15) {
          out.invisible.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0,26)} "${el.textContent.trim().slice(0,30)}"`);
        }
        const fs = parseFloat(cs.fontSize);
        if (fs && fs < 11) out.tiny.push(`${el.tagName.toLowerCase()} ${fs}px`);
      });
      document.querySelectorAll('a[href], button').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (el.closest('.skip')) return;
        /* WCAG 2.5.8 exempts a link inline in a sentence. Detect that by asking
           whether the parent holds text other than this link; if it does, the
           link is in prose and padding it would wreck the paragraph. */
        const parentText = (el.parentElement?.textContent || '').trim();
        const ownText = (el.textContent || '').trim();
        const inlineInProse = parentText.length > ownText.length + 3;
        if (inlineInProse) return;
        if (r.height < 40 || r.width < 40) out.smallTaps.push(`${el.tagName.toLowerCase()} "${ownText.slice(0,22)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      document.querySelectorAll('img').forEach(img => {
        if (!img.hasAttribute('alt')) out.noAlt.push(img.getAttribute('src') || '(no src)');
      });
      return out;
    });

    if (audit.overflow) rec('FAIL', path, vp.name,
      `horizontal overflow ${audit.overflow.scrollW}px > ${audit.overflow.innerW}px — ${audit.overflow.culprits.join(', ')}`);
    [...new Set(audit.invisible)].forEach(t => rec('FAIL', path, vp.name, `invisible text: ${t}`));
    [...new Set(audit.noAlt)].forEach(t => rec('FAIL', path, vp.name, `img without alt: ${t}`));
    if (vp.name.startsWith('phone'))
      [...new Set(audit.smallTaps)].forEach(t => rec('WARN', path, vp.name, `small tap target: ${t}`));
    [...new Set(audit.tiny)].forEach(t => rec('WARN', path, vp.name, `font under 11px: ${t}`));

    if (vp.name === 'phone' || vp.name === 'laptop') {
      await p.screenshot({ path: `${SHOTS}/${vp.name}${path.replace(/[\/.]/g,'_')}.png`, fullPage: true });
    }
    await p.close();
  }
  await ctx.close();
}

// ── 2. JavaScript disabled: nothing may be hidden ───────────────────────────
{
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  for (const path of PAGES) {
    const p = await ctx.newPage();
    await p.goto(BASE + path, { waitUntil: 'load' });
    await p.waitForTimeout(400);
    const hidden = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('.reveal').forEach(el => {
        if (parseFloat(getComputedStyle(el).opacity) < 0.9) out.push(String(el.className).slice(0,40));
      });
      return out;
    });
    hidden.forEach(h => rec('FAIL', path, 'no-js', `content hidden with JS off: ${h}`));
    await p.close();
  }
  await ctx.close();
}

// ── 3. Reduced motion: animation must be off, content still visible ─────────
{
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => ({
    leaves: getComputedStyle(document.querySelector('.leaf-fall')).display,
    hiddenReveals: [...document.querySelectorAll('.reveal')].filter(e => parseFloat(getComputedStyle(e).opacity) < 0.9).length,
  }));
  if (r.leaves !== 'none') rec('WARN', '/', 'reduced-motion', `falling leaves still rendered (display: ${r.leaves})`);
  if (r.hiddenReveals) rec('FAIL', '/', 'reduced-motion', `${r.hiddenReveals} blocks still hidden`);
  await ctx.close();
}

// ── 4. Internal links and SEO/deploy basics ─────────────────────────────────
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  for (const path of PAGES) {
    await p.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    const links = await p.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
    for (const href of [...new Set(links)]) {
      if (!href || /^(https?:|mailto:|tel:|#)/.test(href)) continue;
      const r = await p.request.get(new URL(href, BASE + path).toString());
      if (r.status() >= 400) rec('FAIL', path, 'links', `${href} -> ${r.status()}`);
    }
    const head = await p.evaluate(() => ({
      title: document.title,
      desc: document.querySelector('meta[name="description"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href,
      viewport: document.querySelector('meta[name="viewport"]')?.content,
      lang: document.documentElement.lang,
      h1: document.querySelectorAll('h1').length,
    }));
    if (!head.title || head.title.length < 10) rec('FAIL', path, 'seo', 'missing or short <title>');
    if (!head.desc) rec('FAIL', path, 'seo', 'missing meta description');
    if (!head.viewport) rec('FAIL', path, 'seo', 'missing viewport meta');
    if (!head.lang) rec('FAIL', path, 'seo', 'missing lang on <html>');
    if (head.h1 !== 1) rec('WARN', path, 'seo', `${head.h1} <h1> elements (want exactly 1)`);
    if (path !== '/404.html' && !head.canonical) rec('WARN', path, 'seo', 'missing canonical');
  }
  for (const f of ['/robots.txt', '/sitemap.xml', '/assets/site.css']) {
    const r = await p.request.get(BASE + f);
    if (r.status() >= 400) rec('FAIL', f, 'deploy', `${f} -> ${r.status()}`);
  }
  await ctx.close();
}

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────
const fails = results.filter(r => r.level === 'FAIL');
const warns = results.filter(r => r.level === 'WARN');
const show = rs => rs.forEach(r => console.log(`  ${r.level}  [${r.page} @ ${r.vp}] ${r.msg}`));
console.log(`\nAva Farmers Market — QA sweep against ${BASE}`);
console.log(`${PAGES.length} pages x ${VIEWPORTS.length} viewports, plus no-JS, reduced-motion, links and SEO\n`);
if (fails.length) { console.log('FAILURES'); show(fails); console.log(''); }
if (warns.length) { console.log('WARNINGS'); show(warns); console.log(''); }
console.log(fails.length ? `${fails.length} failure(s), ${warns.length} warning(s).`
                         : `No failures. ${warns.length} warning(s). Screenshots in ${SHOTS}/`);
process.exit(fails.length ? 1 : 0);
