/**
 * F274.4.6 — robots.txt and sitemap.xml for a site:build output.
 *
 * The sitemap lists the pages the generator actually wrote (published pages, posts, the blog index
 * and category pages), so a draft can never appear in it: drafts are not in the generated files
 * unless --drafts is on, and a draft preview gets no sitemap and a Disallow-all robots.txt.
 * The address comes only from the site's `url` setting; nothing here invents one.
 */
export interface SeoFiles {
  files: Record<string, string>;
  /** One line for the build output saying what was or was not written and why. */
  note: string;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** '/' for index.html, '/a/b/' for a/b/index.html; null for any other file. */
export function urlOfOutput(path: string): string | null {
  if (path === 'index.html') return '/';
  if (path.endsWith('/index.html')) return '/' + path.slice(0, -'index.html'.length);
  return null;
}

export function seoFiles(generatedPaths: string[], opts: { url: string | null; noindex: boolean; draftPreview: boolean }): SeoFiles {
  if (opts.draftPreview || opts.noindex) {
    return {
      files: { 'robots.txt': 'User-agent: *\nDisallow: /\n' },
      note: 'robots.txt disallows everything (' + (opts.draftPreview ? 'draft preview' : 'site.config.json has noindex') + '); no sitemap.xml',
    };
  }
  if (!opts.url) {
    return {
      files: { 'robots.txt': 'User-agent: *\nAllow: /\n' },
      note: 'no "url" in site.config.json: robots.txt has no Sitemap line, no sitemap.xml, no canonical or og:url, og:image stays relative',
    };
  }
  const urls = generatedPaths.map(urlOfOutput).filter((u): u is string => u !== null).sort();
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => '  <url><loc>' + xmlEsc(opts.url + u) + '</loc></url>\n').join('') + '</urlset>\n';
  return {
    files: { 'robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: ' + opts.url + '/sitemap.xml\n', 'sitemap.xml': sitemap },
    note: 'robots.txt and sitemap.xml written for ' + opts.url + ' (' + urls.length + ' URLs)',
  };
}
