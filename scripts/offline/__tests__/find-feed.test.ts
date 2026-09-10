/**
 * Feed discovery classification, tested without a network.
 *
 * The point of this script is to stop a human concluding "no feed" from a page that does not
 * link to one. So the interesting cases are the messy real-world ones: attribute order that
 * varies by CMS, feeds served with the wrong content-type, and HTML that merely MENTIONS rss
 * without being a feed. A classifier that only handles the tidy case would send someone off to
 * write a scraper for a site that publishes RSS.
 */
import { describe, it, expect } from 'vitest';
import { classify, declaredLinks } from '../find-feed';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Ava Parks News</title>
  <item><title>Fall soccer signups open</title></item>
  <item><title>Pool closes Sept 8</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Parks</title>
  <entry><title>Signups</title></entry>
</feed>`;

describe('classify', () => {
  it('recognises RSS and counts its items', () => {
    const c = classify(RSS, 'application/rss+xml');
    expect(c).toMatchObject({ kind: 'rss', items: 2, title: 'Ava Parks News' });
  });

  it('recognises Atom and counts its entries', () => {
    expect(classify(ATOM, 'application/atom+xml')).toMatchObject({ kind: 'atom', items: 1 });
  });

  it('recognises a feed served with the WRONG content-type', () => {
    // Municipal CMSs do this constantly — text/html on a perfectly good RSS body. Trusting the
    // header would report "no feed" on a site that has one, which is the exact failure this
    // script exists to prevent.
    expect(classify(RSS, 'text/html')).toMatchObject({ kind: 'rss', items: 2 });
  });

  it('does not mistake an HTML page that merely mentions rss for a feed', () => {
    const html = '<html><body><a href="/rss">Subscribe to our RSS feed</a></body></html>';
    expect(classify(html, 'text/html')).toBeNull();
  });

  it('does not claim a feed from an empty body', () => {
    expect(classify('', 'application/rss+xml')).toBeNull();
  });

  it('recognises a published Turtle graph', () => {
    const ttl = '@prefix kb: <urn:kbase:concept/> .\nkb:x kb:y "z" .\n';
    expect(classify(ttl, 'text/turtle')).toMatchObject({ kind: 'turtle' });
  });

  it('does not call Turtle a feed just because the content-type says xml', () => {
    const ttl = '@prefix kb: <urn:kbase:concept/> .\nkb:x kb:y "z" .\n';
    expect(classify(ttl, 'text/html')).toBeNull();
  });

  it('handles an RSS feed with no items — an empty feed is still a feed', () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title></channel></rss>';
    expect(classify(empty, 'application/rss+xml')).toMatchObject({ kind: 'rss', items: 0 });
  });
});

describe('declaredLinks', () => {
  const base = 'https://parks.example.gov/news';

  it('finds a feed link and resolves it against the page URL', () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    expect(declaredLinks(html, base)).toEqual([
      { href: 'https://parks.example.gov/feed.xml', type: 'application/rss+xml' },
    ]);
  });

  it('does not care what order the attributes are in', () => {
    // Every CMS emits these differently; assuming href-then-type finds nothing on half of them.
    const html = `<link href="/atom.xml" type="application/atom+xml" rel="alternate"/>`;
    expect(declaredLinks(html, base)[0].href).toBe('https://parks.example.gov/atom.xml');
  });

  it('accepts single quotes', () => {
    const html = `<link rel='alternate' type='application/rss+xml' href='/feed'>`;
    expect(declaredLinks(html, base)).toHaveLength(1);
  });

  it('finds a declared Turtle graph, which is worth more than a feed', () => {
    const html = `<link rel="alternate" type="text/turtle" href="/knowledge.ttl">`;
    expect(declaredLinks(html, base)[0].type).toBe('text/turtle');
  });

  it('ignores stylesheets and icons', () => {
    const html = `<link rel="stylesheet" href="/a.css"><link rel="icon" href="/f.ico">`;
    expect(declaredLinks(html, base)).toEqual([]);
  });

  it('skips a malformed href instead of throwing', () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="ht!tp://:::">`;
    expect(() => declaredLinks(html, base)).not.toThrow();
  });

  it('finds several feeds when a site publishes more than one', () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" title="News" href="/news/feed">
      <link rel="alternate" type="application/rss+xml" title="Events" href="/events/feed">`;
    expect(declaredLinks(html, base).map((l) => l.href)).toEqual([
      'https://parks.example.gov/news/feed',
      'https://parks.example.gov/events/feed',
    ]);
  });
});
