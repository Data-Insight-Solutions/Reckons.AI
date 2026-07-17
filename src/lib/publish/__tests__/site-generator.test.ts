/**
 * Standalone static-site generator (F76) — self-contained HTML from the graph, a theme read from
 * the graph, and TARGETED regeneration (don't rebuild the whole site when one page's body changes).
 */
import { describe, it, expect } from 'vitest';
import { generateStaticSite, extractTheme, regenerateChangedPages, siteShellSignature } from '../site-generator';
import type { Statement } from '../../rdf/types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const PAGE = 'urn:reckons:page/';
const SITE = 'urn:reckons:site/';
let n = 0;
function st(s: string, p: string, o: string, iri = false): Statement {
  n += 1;
  return {
    id: `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: iri ? { kind: 'iri', value: o } : { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'confirmed',
    createdAt: n,
    updatedAt: n,
  } as Statement;
}

function page(iri: string, title: string, extra: Record<string, string> = {}): Statement[] {
  return [
    st(iri, RDF_TYPE, 'urn:kbase:type/WebPage', true),
    st(iri, RDFS_LABEL, title),
    st(iri, `${PAGE}status`, extra.status ?? 'published'),
    st(iri, `${PAGE}slug`, extra.slug ?? title.toLowerCase()),
    st(iri, `${PAGE}template`, extra.template ?? 'doc'),
    ...(extra.body ? [st(iri, `${PAGE}body`, extra.body)] : []),
    ...(extra.section ? [st(iri, `${PAGE}section`, extra.section)] : []),
  ];
}

const HOME = 'urn:kbase:concept/home';
const ABOUT = 'urn:kbase:concept/about';
const base = [
  ...page(HOME, 'Home', { template: 'landing', slug: 'home', body: '# Welcome\n\nHi **there**.' }),
  ...page(ABOUT, 'About', { slug: 'about', body: '## About us\n\nA graph site.' }),
];

describe('generateStaticSite', () => {
  it('renders one clean-URL HTML file per published page, plus styles + graph.json', () => {
    const site = generateStaticSite(base, { siteTitle: 'My Site' });
    expect(site.pageCount).toBe(2);
    expect(Object.keys(site.files).sort()).toEqual(['about/index.html', 'graph.json', 'index.html', 'styles.css']);
    expect(site.homeIri).toBe(HOME); // landing template is the home
  });

  it('renders the markdown body to HTML', () => {
    const site = generateStaticSite(base);
    expect(site.files['index.html']).toContain('<strong>there</strong>');
    expect(site.files['about/index.html']).toContain('About us');
  });

  it('links pages in the nav and advertises the knowledge.ttl (F72)', () => {
    const site = generateStaticSite(base);
    expect(site.files['index.html']).toContain('href="/about/"');
    expect(site.files['index.html']).toContain('rel="alternate" type="text/turtle"');
  });

  it('excludes unpublished pages', () => {
    const withDraft = [...base, ...page('urn:kbase:concept/draft', 'Draft', { status: 'draft', slug: 'draft' })];
    expect(generateStaticSite(withDraft).pageCount).toBe(2);
  });
});

describe('extractTheme + graph-driven design', () => {
  const THEME = 'urn:kbase:concept/theme';
  const themed = [
    ...base,
    st(THEME, RDF_TYPE, 'urn:kbase:type/SiteTheme', true),
    st(THEME, `${SITE}accent`, '#ff0066'),
    st(THEME, `${SITE}logo`, 'https://example.com/logo.png'),
    st(THEME, `${SITE}title`, 'Themed'),
  ];

  it('falls back to defaults when no SiteTheme entity exists', () => {
    const t = extractTheme(base);
    expect(t.accent).toBe('#f59e0b');
    expect(t.logoUrl).toBeNull();
  });

  it('reads accent, logo, and title from a SiteTheme entity', () => {
    const t = extractTheme(themed);
    expect(t.accent).toBe('#ff0066');
    expect(t.logoUrl).toBe('https://example.com/logo.png');
    expect(t.title).toBe('Themed');
  });

  it('injects the theme into the generated CSS and shows the logo', () => {
    const site = generateStaticSite(themed);
    expect(site.files['styles.css']).toContain('--accent:#ff0066');
    expect(site.files['index.html']).toContain('class="site-logo" src="https://example.com/logo.png"');
  });
});

describe('targeted regeneration (do not rebuild the whole site)', () => {
  it('regenerates ONLY the changed page(s), plus graph.json', () => {
    const { files, regenerated } = regenerateChangedPages(base, [ABOUT]);
    expect(regenerated).toEqual(['about/index.html']);
    expect(Object.keys(files).sort()).toEqual(['about/index.html', 'graph.json']); // home NOT rebuilt
  });

  it('shell signature is stable across a body-only change but moves when a title/theme changes', () => {
    const sig0 = siteShellSignature(base);
    // change ABOUT's body only → shell (nav + theme) unchanged
    const bodyEdited = base.map((s) =>
      s.s.value === ABOUT && s.p.value === `${PAGE}body` ? { ...s, o: { kind: 'literal' as const, value: '## New body' } } : s,
    );
    expect(siteShellSignature(bodyEdited)).toBe(sig0);
    // change ABOUT's title → shell moves (nav changes) → full rebuild needed
    const titleEdited = base.map((s) =>
      s.s.value === ABOUT && s.p.value === RDFS_LABEL ? { ...s, o: { kind: 'literal' as const, value: 'Renamed' } } : s,
    );
    expect(siteShellSignature(titleEdited)).not.toBe(sig0);
  });
});
