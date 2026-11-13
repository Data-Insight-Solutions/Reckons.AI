#!/usr/bin/env npx tsx
/**
 * Site live (F294.6, SCRIPT tier) — is the published website up, whole, and what was merged?
 * No model. It reads the live site over https (same origin only) and, with --dns, the site's mail DNS.
 *
 *   npx tsx scripts/offline/site-live.ts --site=<site repository> [--url=<https address>] [--dns]
 *                                        [--dns-rebaseline] [--domains=a.com,b.com] [--max-pages=200]
 *
 * Checks: (1) every page answers 200; (2) every internal link and asset answers 200 with a content-type that
 * fits its extension (a host's fallback HTML page for a missing .webp is a FINDING, not a pass);
 * (3) /reckons-build.json (written by site:build) names the site commit that is live, compared with origin/main;
 * (4) with --dns, MX/TXT and the two DKIM selector CNAMEs against a private baseline.
 * Exit 1 on any finding; UNKNOWNs are reported and do not fail. A missing site repository exits 0 and says so.
 *
 * PRIVACY: the form endpoint and any config override are never read or printed; the site's workspace/ folder is never
 * read. DNS values and the JSON report go to $XDG_STATE_HOME/reckons/site-live/<host>/ (dir 0700, files 0600),
 * outside any checkout; stdout carries counts only for DNS.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolve as dnsResolve } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../../src/lib/publish/site-config.js';

export const BUILD_STAMP_PATH = '/reckons-build.json';

// ---------- pure helpers ----------

export interface Refs { internal: string[]; externalCount: number }

const REF_TAGS: { re: RegExp; attr: string }[] = [
  { re: /<a\b[^>]*>/gi, attr: 'href' },
  { re: /<img\b[^>]*>/gi, attr: 'src' },
  { re: /<script\b[^>]*>/gi, attr: 'src' },
  { re: /<link\b[^>]*>/gi, attr: 'href' },
  { re: /<source\b[^>]*>/gi, attr: 'src' },
];

function attrValue(tag: string, attr: string): string | null {
  const m = new RegExp('\\s' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** Internal (same-origin) absolute URLs a page references, fragments dropped; external links are only counted. */
export function extractRefs(html: string, pageUrl: string): Refs {
  const origin = new URL(pageUrl).origin;
  const internal = new Set<string>();
  let externalCount = 0;
  for (const { re, attr } of REF_TAGS) {
    for (const m of html.matchAll(re)) {
      const raw = attrValue(m[0], attr);
      if (raw === null) continue;
      const v = raw.trim().replace(/&amp;/g, '&');
      if (v === '' || v.startsWith('#') || /^(mailto|tel|javascript|data|sms|blob):/i.test(v)) continue;
      let u: URL;
      try { u = new URL(v, pageUrl); } catch { continue; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      if (u.origin !== origin) { externalCount++; continue; }
      u.hash = '';
      internal.add(u.toString());
    }
  }
  return { internal: [...internal].sort(), externalCount };
}

const TYPE_BY_EXT: Record<string, RegExp> = {
  '.webp': /^image\/webp/, '.jpg': /^image\/jpeg/, '.jpeg': /^image\/jpeg/, '.png': /^image\/png/, '.gif': /^image\/gif/,
  '.svg': /^image\/svg\+xml/, '.ico': /^image\/(x-icon|vnd\.microsoft\.icon)/, '.avif': /^image\/avif/,
  '.js': /^(text|application)\/(javascript|x-javascript)/, '.mjs': /^(text|application)\/javascript/, '.css': /^text\/css/,
  '.json': /^application\/(.+\+)?json/, '.pdf': /^application\/pdf/, '.woff2': /^(font\/woff2|application\/(font-woff2|octet-stream))/,
  '.woff': /^(font\/woff|application\/(font-woff|octet-stream))/, '.ttf': /^(font\/ttf|application\/(font-sfnt|octet-stream))/,
  '.glb': /^(model\/gltf-binary|application\/octet-stream)/, '.ply': /^(application\/octet-stream|model\/|text\/plain)/,
  '.splat': /^application\/octet-stream/, '.xml': /^(text|application)\/xml|^application\/.+\+xml/, '.txt': /^text\/plain/,
  '.mp4': /^video\/mp4/, '.webm': /^video\/webm/, '.mp3': /^audio\/mpeg/, '.wasm': /^application\/wasm/,
};

export function extensionOf(url: string): string {
  const p = new URL(url).pathname;
  if (p.endsWith('/')) return '';
  const last = p.split('/').pop() ?? '';
  const i = last.lastIndexOf('.');
  return i <= 0 ? '' : last.slice(i).toLowerCase();
}

export function isPageUrl(url: string): boolean {
  const ext = extensionOf(url);
  return ext === '' || ext === '.html' || ext === '.htm';
}

/** Null when status and content-type fit the URL; else a one-line reason. */
export function judgeResponse(url: string, status: number, contentType: string | null): string | null {
  if (status !== 200) return 'answered ' + status;
  const ct = (contentType ?? '').toLowerCase().trim();
  const ext = extensionOf(url);
  if (ext === '' || ext === '.html' || ext === '.htm') {
    return /^text\/html|^application\/xhtml/.test(ct) ? null : 'a page answered content-type ' + (ct || 'none');
  }
  if (/^text\/html/.test(ct)) return 'served a fallback page (text/html) for a ' + ext + ' file, the file is missing';
  const want = TYPE_BY_EXT[ext];
  if (!want) return null;
  return want.test(ct) ? null : ext + ' file served as ' + (ct || 'no content-type');
}

export function parseSitemap(xml: string, origin: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'));
      if (u.origin === origin) { u.hash = ''; out.add(u.toString()); }
    } catch { /* skip a malformed entry */ }
  }
  return [...out].sort();
}

export type Freshness =
  | { kind: 'current'; commit: string }
  | { kind: 'behind'; commit: string; behind: number }
  | { kind: 'ahead-or-diverged'; commit: string }
  | { kind: 'no-stamp'; reason: string }
  | { kind: 'no-commit' };

export function parseStamp(body: string | null): { siteCommit: string | null; version: string | null } | null {
  if (body === null) return null;
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (j.generator !== 'Reckons.AI') return null;
    return { siteCommit: typeof j.siteCommit === 'string' ? j.siteCommit : null, version: typeof j.version === 'string' ? j.version : null };
  } catch { return null; }
}

/** `behindCount(stampCommit)` is `git rev-list --count <stamp>..origin/main`, or null when it cannot be known. */
export function compareStamp(stamp: ReturnType<typeof parseStamp>, mainCommit: string | null, behindCount: (c: string) => number | null): Freshness {
  if (!stamp) return { kind: 'no-stamp', reason: 'this build predates the build stamp (the site\'s deploy workflow pins an older Reckons.AI)' };
  if (!stamp.siteCommit) return { kind: 'no-commit' };
  if (mainCommit && stamp.siteCommit === mainCommit) return { kind: 'current', commit: stamp.siteCommit };
  const n = behindCount(stamp.siteCommit);
  if (n === null) return { kind: 'ahead-or-diverged', commit: stamp.siteCommit };
  return n === 0 ? { kind: 'current', commit: stamp.siteCommit } : { kind: 'behind', commit: stamp.siteCommit, behind: n };
}

export type DnsSnapshot = Record<string, Record<string, string[]>>; // host -> record type -> sorted values

export interface DnsChange { host: string; type: string; before: number; after: number }

export function diffDns(before: DnsSnapshot, after: DnsSnapshot): DnsChange[] {
  const out: DnsChange[] = [];
  for (const host of Object.keys(after).sort()) {
    const b = before[host] ?? {};
    const a = after[host];
    for (const type of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const bv = b[type] ?? [], av = a[type] ?? [];
      if (JSON.stringify(bv) !== JSON.stringify(av)) out.push({ host, type, before: bv.length, after: av.length });
    }
  }
  return out;
}

// ---------- injected effects ----------

export interface Reply { status: number; contentType: string | null; text: string | null }
export type Fetcher = (url: string, method: 'GET' | 'HEAD') => Promise<Reply>;
export interface DnsResolver { mx(h: string): Promise<string[]>; txt(h: string): Promise<string[]>; cname(h: string): Promise<string[]> }
export type Git = (args: string[]) => string | null;

export async function snapshotDns(r: DnsResolver, hosts: string[]): Promise<DnsSnapshot> {
  const snap: DnsSnapshot = {};
  for (const h of hosts) {
    snap[h] = {
      MX: (await r.mx(h)).sort(), TXT: (await r.txt(h)).sort(),
      'selector1._domainkey CNAME': (await r.cname('selector1._domainkey.' + h)).sort(),
      'selector2._domainkey CNAME': (await r.cname('selector2._domainkey.' + h)).sort(),
    };
  }
  return snap;
}

export interface Options { url: string; maxPages: number; fetcher: Fetcher; git?: Git; mainRefNote?: string }
export interface Report {
  url: string; pages: number; assets: number; externalLinks: number; findings: string[]; unknowns: string[];
  freshness: Freshness | null;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function checkSite(o: Options): Promise<Report> {
  const origin = new URL(o.url).origin;
  const findings: string[] = [], unknowns: string[] = [];
  const rel = (u: string): string => { const x = new URL(u); return x.pathname + x.search; };
  let externalLinks = 0;
  const seen = new Set<string>();
  const pageQueue: string[] = [];
  const assetQueue: string[] = [];
  const enqueue = (u: string): void => {
    if (seen.has(u)) return;
    seen.add(u);
    (isPageUrl(u) ? pageQueue : assetQueue).push(u);
  };

  const home = origin + '/';
  enqueue(home);
  const sm = await o.fetcher(origin + '/sitemap.xml', 'GET').catch(() => null);
  if (sm && sm.status === 200 && /xml/i.test(sm.contentType ?? '') && sm.text) for (const u of parseSitemap(sm.text, origin)) enqueue(u);

  let pages = 0;
  const overflow: string[] = [];
  while (pageQueue.length > 0) {
    const u = pageQueue.shift() as string;
    if (pages >= o.maxPages) { overflow.push(u); continue; }
    pages++;
    let r: Reply;
    try { r = await o.fetcher(u, 'GET'); } catch (e) { findings.push('page ' + rel(u) + ': ' + ((e as Error).message || 'request failed')); continue; }
    const bad = judgeResponse(u, r.status, r.contentType);
    if (bad) { findings.push('page ' + rel(u) + ': ' + bad); continue; }
    if (r.text) {
      const refs = extractRefs(r.text, u);
      externalLinks += refs.externalCount;
      for (const x of refs.internal) enqueue(x);
    }
  }
  if (overflow.length > 0) unknowns.push(overflow.length + ' page(s) beyond --max-pages=' + o.maxPages + ' were not read (their own links are unchecked)');

  const targets = [...assetQueue, ...overflow];
  let assets = 0;
  await pool(targets, 8, async (u) => {
    assets++;
    try {
      let r = await o.fetcher(u, 'HEAD');
      if (r.status === 405 || r.status === 501 || r.status === 403 || (r.status === 200 && !r.contentType)) r = await o.fetcher(u, 'GET');
      const bad = judgeResponse(u, r.status, r.contentType);
      if (bad) findings.push((isPageUrl(u) ? 'link ' : 'asset ') + rel(u) + ': ' + bad);
    } catch (e) { findings.push('asset ' + rel(u) + ': ' + ((e as Error).message || 'request failed')); }
  });
  findings.sort();

  // Freshness
  let freshness: Freshness | null = null;
  const sr = await o.fetcher(origin + BUILD_STAMP_PATH, 'GET').catch(() => null);
  const stamp = sr && sr.status === 200 && /json/i.test(sr.contentType ?? '') ? parseStamp(sr.text) : null;
  if (!o.git) {
    unknowns.push('freshness: no site repository to compare the live build with');
  } else {
    let main: string | null = null;
    if (stamp?.siteCommit) {
      const fetched = o.git(['fetch', '-q', 'origin', 'main']);
      main = o.git(['rev-parse', 'origin/main']);
      if (main === null) main = o.git(['rev-parse', 'main']);
      if (fetched === null) unknowns.push('freshness: git fetch failed, compared with the local origin/main ref, which may be stale');
    }
    freshness = compareStamp(stamp, main, (c) => { const n = o.git!(['rev-list', '--count', c + '..origin/main']); return n === null ? null : Number(n); });
    if (freshness.kind === 'no-stamp') unknowns.push('freshness: ' + freshness.reason);
    else if (freshness.kind === 'no-commit') unknowns.push('freshness: the stamp has no site commit (the site was built outside a git checkout)');
    else if (freshness.kind === 'behind') findings.push('freshness: live is ' + freshness.behind + ' commit(s) behind origin/main (live ' + freshness.commit.slice(0, 8) + ')');
    else if (freshness.kind === 'ahead-or-diverged') unknowns.push('freshness: live commit ' + freshness.commit.slice(0, 8) + ' is not in this clone, so how far behind main it is cannot be counted');
  }
  return { url: origin, pages, assets, externalLinks, findings, unknowns, freshness };
}

// ---------- real effects ----------

export const realFetcher: Fetcher = async (url, method) => {
  const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'reckons-site-live/1' } });
  const contentType = res.headers.get('content-type');
  const wantText = method === 'GET' && /html|xml|json/i.test(contentType ?? '');
  const text = wantText ? await res.text() : null;
  if (method === 'GET' && !wantText) await res.body?.cancel().catch(() => undefined);
  return { status: res.status, contentType, text };
};

export function realGit(site: string): Git {
  return (args) => {
    try { return execFileSync('git', ['-C', site, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).trim(); } catch { return null; }
  };
}

const quiet = async <T>(p: Promise<T[]>): Promise<T[]> => { try { return await p; } catch { return []; } };
export const realDns: DnsResolver = {
  mx: async (h) => (await quiet(dnsResolve(h, 'MX'))).map((m) => m.priority + ' ' + m.exchange.toLowerCase()),
  txt: async (h) => (await quiet(dnsResolve(h, 'TXT'))).map((t) => t.join('')),
  cname: async (h) => (await quiet(dnsResolve(h, 'CNAME'))).map((c) => c.toLowerCase()),
};

export function stateDir(host: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'reckons', 'site-live', host);
}

function privateWrite(dir: string, name: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const f = path.join(dir, name);
  writeFileSync(f, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(f, 0o600);
}

/** First run records the baseline; later runs diff against it. Values go only to the private files. */
export async function dnsCheck(r: DnsResolver, hosts: string[], dir: string, rebaseline: boolean, now = new Date()): Promise<{ findings: string[]; unknowns: string[]; note: string }> {
  const snap = await snapshotDns(r, hosts);
  const baseFile = path.join(dir, 'dns-baseline.json');
  const empty = hosts.every((h) => Object.values(snap[h]).every((v) => v.length === 0));
  if (empty) return { findings: [], unknowns: ['dns: nothing resolved for ' + hosts.length + ' domain(s) (offline, or the records are gone); no baseline written'], note: 'dns not recorded' };
  if (rebaseline || !existsSync(baseFile)) {
    privateWrite(dir, 'dns-baseline.json', { recordedAt: now.toISOString(), snapshot: snap });
    return { findings: [], unknowns: [], note: rebaseline ? 'dns baseline replaced' : 'dns baseline recorded (first run)' };
  }
  const base = JSON.parse(readFileSync(baseFile, 'utf8')) as { snapshot: DnsSnapshot };
  const changes = diffDns(base.snapshot, snap);
  privateWrite(dir, 'dns-last.json', { checkedAt: now.toISOString(), changes, baseline: base.snapshot, now: snap });
  return {
    findings: changes.map((c) => 'dns: ' + c.host + ' ' + c.type + ' changed since the baseline (' + c.before + ' -> ' + c.after + ' record(s)); values in the private dns-last.json'),
    unknowns: [], note: 'dns compared with the baseline: ' + changes.length + ' change(s)',
  };
}

// ---------- CLI ----------

const flag = (name: string): string | undefined => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : undefined;
};

export async function main(): Promise<number> {
  const site = flag('site');
  if (!site) { console.log('site-live: --site=<site repository> is required'); return 1; }
  const siteDir = path.resolve(site.replace(/^~(?=\/)/, homedir()));
  if (!existsSync(siteDir)) { console.log('site-live: site repository not found (' + path.basename(siteDir) + '); nothing to check'); return 0; }
  let url = flag('url') ?? null;
  if (!url) { try { url = loadSiteConfig(siteDir)?.url ?? null; } catch { url = null; } }
  if (!url) { console.log('site-live: UNKNOWN no public url (pass --url or set "url" in site.config.json)'); return 0; }
  const host = new URL(url).host;
  const maxPages = Number(flag('max-pages') ?? 200);
  const isGit = existsSync(path.join(siteDir, '.git'));
  const report = await checkSite({ url, maxPages, fetcher: realFetcher, git: isGit ? realGit(siteDir) : undefined });
  let dnsNote: string | null = null;
  if (process.argv.includes('--dns')) {
    const hosts = [...new Set([new URL(url).hostname, ...(flag('domains')?.split(',').map((d) => d.trim()).filter(Boolean) ?? [])])];
    const d = await dnsCheck(realDns, hosts, stateDir(host), process.argv.includes('--dns-rebaseline'));
    report.findings.push(...d.findings); report.unknowns.push(...d.unknowns); dnsNote = d.note;
  }
  try { privateWrite(stateDir(host), 'report.json', { checkedAt: new Date().toISOString(), ...report }); } catch { report.unknowns.push('the private report could not be written'); }
  console.log('site-live ' + new Date().toISOString().slice(0, 10) + ' ' + host + ': ' + report.pages + ' page(s), ' + report.assets + ' internal asset/link target(s), ' + report.externalLinks + ' external link(s) counted not fetched, ' + report.findings.length + ' finding(s), ' + report.unknowns.length + ' unknown(s)' + (dnsNote ? '; ' + dnsNote : ''));
  for (const f of report.findings) console.log('FINDING ' + f);
  for (const u of report.unknowns) console.log('UNKNOWN ' + u);
  if (report.freshness?.kind === 'current') console.log('freshness: live site commit ' + report.freshness.commit.slice(0, 8) + ' is origin/main');
  return report.findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((c) => process.exit(c), (e) => { console.error('site-live: ' + (e as Error).message); process.exit(1); });
}
