#!/usr/bin/env npx tsx
/**
 * Feed discovery (SCRIPT tier) — can this site be watched at all?
 *
 * Before adding a current you need to know whether the source will hand you a feed, and the
 * honest answer is usually "yes, but nothing on the page links to it". Site owners publish
 * RSS constantly without advertising it: WordPress serves /feed on every install, Squarespace
 * serves ?format=rss, most municipal CMSs expose something under /RSSFeed.aspx. A human
 * checking by eye concludes "no feed" and reaches for a scraper. This checks properly.
 *
 * WHY IT IS SCRIPT TIER. Every question here is a rule — does this URL return 200, does the
 * body parse as XML, does it contain <item> or <entry>, does the HTML declare a
 * rel="alternate" link. No judgment, no model, zero tokens, and it cannot invent a feed that
 * is not there. (F74.3: prefer growing the script tier.)
 *
 * IT ALSO CHECKS FOR TURTLE. If a site advertises <link rel="alternate" type="text/turtle">
 * it is publishing a graph, and kb:ttl-aware-ingest imports that directly with no LLM
 * extraction — cheaper, exact, and lossless against re-extracting prose the publisher already
 * modelled. Worth knowing before you point an extractor at it.
 *
 * Usage:
 *   npx tsx scripts/offline/find-feed.ts https://example.gov/parks
 *   npx tsx scripts/offline/find-feed.ts https://example.gov/parks --json
 */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--'));

const invokedDirectly =
  !!process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000');

if (!target && invokedDirectly) {
  console.error('usage: find-feed.ts <url> [--json]');
  process.exit(2);
}

/** Paths worth trying even when nothing links to them. Ordered by how often they pay off. */
const GUESSES = [
  '/feed',            // WordPress default, and the single highest-yield guess
  '/feed/',
  '/rss',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/index.xml',       // Hugo
  '/?format=rss',     // Squarespace
  '/RSSFeed.aspx',    // CivicPlus and friends — common for US municipal sites
  '/rss/news',
  '/news/feed',
  '/events/feed',
  '/knowledge.ttl',   // a Reckons-published site
];

type Finding = {
  url: string;
  kind: 'rss' | 'atom' | 'turtle' | 'unknown';
  how: 'declared' | 'guessed';
  items?: number;
  title?: string;
};

const UA = 'Reckons.AI feed-discovery (script tier; one request per candidate)';

async function get(url: string, timeoutMs = 8000): Promise<{ status: number; body: string; type: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, body, type: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a body as a feed WITHOUT an XML parser — presence of the container elements is
 *  the rule, and a strict parse would reject real-world feeds over trivia like stray entities. */
export function classify(body: string, contentType: string): { kind: Finding['kind']; items: number; title?: string } | null {
  const head = body.slice(0, 4000);
  if (/^\s*(@prefix|@base|#|<)/.test(head) && /\.\s*$/m.test(body) && /text\/turtle|application\/x-turtle/.test(contentType)) {
    return { kind: 'turtle', items: 0 };
  }
  const isXml = /^\s*<\?xml|^\s*<(rss|feed)\b/i.test(head) || /xml/.test(contentType);
  if (!isXml) return null;

  const rssItems = (body.match(/<item[\s>]/gi) ?? []).length;
  const atomEntries = (body.match(/<entry[\s>]/gi) ?? []).length;
  const title = body.match(/<title[^>]*>([^<]{1,120})</i)?.[1]?.trim();

  if (/<rss\b/i.test(head) || rssItems > 0) return { kind: 'rss', items: rssItems, title };
  if (/<feed\b/i.test(head) || atomEntries > 0) return { kind: 'atom', items: atomEntries, title };
  return null;
}

/** rel="alternate" links the page declares itself. Attribute order varies, so match the tag
 *  then read attributes out of it rather than assuming a shape. */
export function declaredLinks(html: string, base: string): Array<{ href: string; type: string }> {
  const out: Array<{ href: string; type: string }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const type = tag.match(/type\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (!/rss|atom|turtle/.test(type)) continue;
    try {
      out.push({ href: new URL(href, base).toString(), type });
    } catch {
      /* a malformed href is the site's problem, not a crash */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = new URL(target!);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  const page = await get(root.toString());
  if (!page) {
    console.error(`Could not reach ${root} — no DNS, no route, or it timed out.`);
    process.exit(1);
  }

  // 1. What the page says about itself. Always cheaper and more reliable than guessing.
  const declared = page.body.includes('<link') ? declaredLinks(page.body, root.toString()) : [];
  for (const d of declared) {
    if (seen.has(d.href)) continue;
    seen.add(d.href);
    const res = await get(d.href);
    if (!res || res.status >= 400) continue;
    const c = classify(res.body, res.type || d.type);
    if (c) findings.push({ url: d.href, kind: c.kind, how: 'declared', items: c.items, title: c.title });
  }

  // 2. The unlinked conventions. Only worth trying because sites so often have one.
  for (const path of GUESSES) {
    const candidate = new URL(path, root.origin + root.pathname.replace(/\/[^/]*$/, '/')).toString();
    const atOrigin = new URL(path, root.origin).toString();
    for (const url of new Set([candidate, atOrigin])) {
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await get(url, 5000);
      if (!res || res.status >= 400) continue;
      const c = classify(res.body, res.type);
      if (c) findings.push({ url, kind: c.kind, how: 'guessed', items: c.items, title: c.title });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ target: root.toString(), findings }, null, 2));
    return;
  }

  console.log(`\nFeed discovery — ${root}`);
  if (findings.length === 0) {
    console.log('\n  No feed found.');
    console.log('  That is a real answer, not a failure: this site publishes no machine-readable');
    console.log('  feed at any conventional path and declares none. Watching it would mean');
    console.log('  scraping HTML, which currents deliberately does not do (it parses RSS/Atom).');
    console.log('\n  Before giving up: check whether the same body sends an EMAIL newsletter.');
    console.log('  An address subscribed to it, watched over IMAP, is more reliable than any');
    console.log('  scraper and does not break when the markup changes.');
    process.exit(0);
  }

  console.log(`\n  ${findings.length} feed(s) found:\n`);
  for (const f of findings) {
    const label = f.kind === 'turtle' ? 'TURTLE (a published graph)' : f.kind.toUpperCase();
    console.log(`  ${label}  ${f.how === 'declared' ? '(declared by the page)' : '(unlinked — found by convention)'}`);
    console.log(`    ${f.url}`);
    if (f.title) console.log(`    title: ${f.title}`);
    if (f.items) console.log(`    items: ${f.items}`);
    console.log();
  }

  const turtle = findings.find((f) => f.kind === 'turtle');
  if (turtle) {
    console.log('  This site publishes a GRAPH. Import it directly (kb:ttl-aware-ingest) rather');
    console.log('  than extracting prose the publisher already modelled.\n');
  }
  const best = findings.find((f) => f.how === 'declared') ?? findings[0];
  console.log(`  To watch it: add a current with kind "rss" and sourceUrl ${best.url}\n`);
}

// Only crawl when run as a command. Importing this module for tests must not fire requests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  main().catch((e) => {
    console.error('find-feed failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
