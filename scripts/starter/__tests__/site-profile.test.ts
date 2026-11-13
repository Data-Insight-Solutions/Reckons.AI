import { describe, expect, it } from 'vitest';
import { buildSiteSpace } from '../build-site-space';
import { extractProfile, parseBlocks } from '../site-profile';
import { extractStories } from '../../../src/lib/rdf/story';

// Synthetic site: invented people, company and posts. Nothing here is a real person's text.
const about = `---
title: About Example Studio
slug: about
template: sections
status: published
---

## About ==Example Studio==
@section: hero

Example Studio LLC is a Nebraska limited liability company, formed in 2019, and a consultancy in Lakeside, Nebraska, working remotely with teams anywhere. It is also home to Widgetry, the demo tool behind this site.

## Principles
@section: text
@id: principles

We help teams turn scattered notes into usable plans.

==Tools should serve people.==

- **People first:** tools serve the team.
- **Own it:** your team owns the system, which is where [how we work](/services/#how-we-work) ends.

## ==Pat Example==, founder
@section: text
@id: owner

I'm Pat Example, the founder of Example Studio: a planner for logistics and a tool integrator.

## The career line
@section: blocks
@id: background

### Credentials
**Current:**

- Certified Planner, issued May 2025, valid to May 2028 — [verify](https://example.test/badge/1) | valid-until: 2028-05-01
- Fixture Practitioner, Sample Institute, 2024 — [verify](https://example.test/badge/2)

**Earlier certifications (expired):**

- Old Practitioner Associate (2019)

### Education and research
- Sample State University, 2010–2014: BA in Fixtures
- Sample Lab, 2012–2014; published a paper in a made-up journal.

### Recognition
Fixture Hackathon winner, and the first round-trip Sample integration with Acme.

### Widgetry
Pat is building Widgetry, the demo tool behind this site: MIT licensed, works offline, and no account.

### The widget, rebuilt in 3D
This widget was reconstructed into a 3D model from photographs. It is not generated.

<iframe src="/assets/widget/viewer/" title="Widget" loading="lazy"></iframe>

[See how it was made](https://widgetry.example.test/about?example=widget-scan).
`;
const services = `---
title: Services
slug: services
template: sections
status: published
---

## Planning
@section: hero

Logistics planning (LP) is the work of moving things from where they are to where they are needed.

## What we do
@section: cards
@id: services

### Planning consulting
Plain consulting.

### Custom integrations
Recent integrations:

- [Route export](/blog/route-post/), for the depot: one clean file.
- [Label printing](/blog/route-post/): labels from records.
- Spreadsheet sync: a link to a platform.
- [Draft thing](/blog/not-published/): unpublished.

### Widgetry
@tag: alpha
A demo tool.

Honest status: alpha. Small and unfinished.
`;
const files = {
  'content/about.md': about,
  'content/services.md': services,
  'content/blog/route-post.md': '---\ntitle: Route Post\nslug: route-post\ntemplate: post\nstatus: published\ndate: 2026-01-02\ncategories:\n  - "Ops"\nexcerpt: A post.\n---\n\nBody.\n',
  'content/blog/not-published.md': '---\ntitle: Draft Thing\nslug: not-published\ntemplate: post\nstatus: draft\ndate: 2026-01-03\n---\n\nDRAFT-BODY\n',
};
const opts = { url: 'https://site.example.test', publisher: 'Example Studio LLC', siteName: 'Example Studio', footer: '(c) Example' };
const has = (r: ReturnType<typeof buildSiteSpace>, s: string, p: string, o?: string) =>
  r.statements.some((x) => x.s.value === s && x.p.value.endsWith(p) && (o === undefined || x.o.value === o));
const K = 'urn:kbase:concept/';

describe('extractProfile: reads the structure the markdown already has', () => {
  const p = extractProfile(files);
  it('person and organization', () => {
    expect(p.person).toEqual({ name: 'Pat Example', role: 'founder', titles: ['planner for logistics', 'tool integrator'] });
    expect(p.org).toMatchObject({ legalName: 'Example Studio LLC', state: 'Nebraska', formed: '2019', city: 'Lakeside', region: 'Nebraska', remote: true });
  });
  it('mission, principles (a trailing link clause is dropped), recognition, product, education', () => {
    expect(p.mission).toEqual({ text: 'We help teams turn scattered notes into usable plans.', tenet: 'Tools should serve people.' });
    expect(p.principles.map((x) => x.name)).toEqual(['People first', 'Own it']);
    expect(p.principles[1].text).toBe('Your team owns the system');
    expect(p.recognition).toEqual(['Fixture Hackathon winner', 'the first round-trip Sample integration with Acme']);
    expect(p.product).toEqual({ name: 'Widgetry', traits: ['MIT licensed', 'works offline', 'no account'] });
    expect(p.education.map((x) => x.years)).toEqual(['2010–2014']);
  });
  it('leaves out what does not match its shape, and says so', () => {
    expect(p.skipped.join('|')).toContain('Sample Lab');
  });
  it('credentials keep their group, their dates and their verify link', () => {
    expect(p.credentials.map((c) => [c.group, c.validUntil, c.year])).toEqual([
      ['Current', '2028-05-01', undefined], ['Current', null, undefined], ['Earlier certifications (expired)', null, '2019'],
    ]);
    expect(p.credentials[0].verify).toBe('https://example.test/badge/1');
    expect(p.credentials[0].label).toBe('Certified Planner, issued May 2025, valid to May 2028');
  });
  it('parseBlocks keeps list items under the bold group line', () => {
    const b = parseBlocks('## A\n\n### S\n**G:**\n\n- one\n- two\n');
    expect(b[0].subs[0].items.map((i) => [i.text, i.group])).toEqual([['one', 'G'], ['two', 'G']]);
  });
});

describe('buildSiteSpace with a profile', () => {
  const r = buildSiteSpace(files, opts);
  it('has a Person who works for and owns the organization, and builds the product', () => {
    const pat = K + 'dis-person-pat-example';
    expect(has(r, pat, 'type', 'urn:kbase:type/Person')).toBe(true);
    expect(has(r, pat, '/works-for', K + 'dis-llc')).toBe(true);
    expect(has(r, pat, '/owns', K + 'dis-llc')).toBe(true);
    expect(has(r, pat, '/builds', K + 'dis-product-widgetry')).toBe(true);
    expect(has(r, pat, '/stated-on', K + 'dis-page-about')).toBe(true);
  });
  it('the organization carries its legal form, year, place and services', () => {
    expect(has(r, K + 'dis-llc', '/legal-form', 'Nebraska limited liability company')).toBe(true);
    expect(has(r, K + 'dis-llc', '/formed', '2019')).toBe(true);
    expect(has(r, K + 'dis-llc', '/located-in', K + 'dis-place-lakeside-nebraska')).toBe(true);
    expect(has(r, K + 'dis-llc', '/offers', K + 'dis-service-custom-integrations')).toBe(true);
  });
  it('links services and specialties to the PUBLISHED posts only', () => {
    expect(has(r, K + 'dis-service-custom-integrations', '/covered-in', K + 'dis-post-route-post')).toBe(true);
    expect(has(r, K + 'dis-specialty-label-printing', '/covered-in', K + 'dis-post-route-post')).toBe(true);
    expect(has(r, K + 'dis-specialty-spreadsheet-sync', '/part-of', K + 'dis-service-custom-integrations')).toBe(true);
    expect(r.statements.some((x) => x.o.value.includes('not-published'))).toBe(false);
    expect(r.text).not.toMatch(/DRAFT-BODY|not-published/);
  });
  it('a credential with a valid-until date IS the dated fact, with the date kept', () => {
    const fact = r.statements.find((x) => x.p.value.endsWith('/valid-until') && x.o.value === '2028-05-01')!;
    expect(has(r, fact.s.value, 'type', 'urn:kbase:type/Credential')).toBe(true);
    expect(has(r, K + 'dis-person-pat-example', '/holds', fact.s.value)).toBe(true);
    expect(has(r, fact.s.value, '/verify-at', 'https://example.test/badge/1')).toBe(true);
  });
  it('recognition, mission and principles, product status and honest note', () => {
    expect(r.statements.filter((x) => x.p.value.endsWith('/received'))).toHaveLength(2);
    expect(has(r, K + 'dis-llc', '/mission', K + 'dis-mission')).toBe(true);
    expect(r.statements.filter((x) => x.p.value.endsWith('/follows'))).toHaveLength(2);
    expect(has(r, K + 'dis-product-widgetry', '/status', 'alpha')).toBe(true);
    expect(r.statements.some((x) => x.s.value === K + 'dis-product-widgetry' && x.o.value === 'Honest status: alpha. Small and unfinished.')).toBe(true);
  });
  it('the reconstructed asset has a leap to its own example space, as an in-app path', () => {
    const ring = K + 'dis-ring';
    expect(has(r, ring, 'type', 'urn:kbase:type/GaussianSplat')).toBe(true);
    expect(has(r, ring, '/provenance')).toBe(true);
    expect(r.statements.find((x) => x.s.value === ring && x.p.value === 'urn:reckons:leap')!.o.value).toBe('/about?example=widget-scan');
    expect(has(r, ring, '/url', 'https://site.example.test/assets/widget/viewer/')).toBe(true);
  });
  it('the story gains one early step about who is behind the site, with computed counts and resolving highlights', () => {
    const [st] = extractStories(r.statements);
    expect(st.steps.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(st.steps[1].title).toBe('Who is behind the site');
    expect(st.steps[1].content).toContain('Pat Example is the founder of Example Studio LLC, formed in 2019, in Lakeside, Nebraska');
    expect(st.steps[1].content).toContain('3 services, 3 credentials, 2 recognitions');
    const nodes = new Set(r.statements.map((x) => x.s.value));
    for (const h of st.steps[1].highlights) expect(nodes.has(h), h).toBe(true);
  });
  it('is deterministic, and a site with no About page gets no person and the old five steps', () => {
    expect(buildSiteSpace(files, opts).text).toBe(r.text);
    const bare = buildSiteSpace({ 'content/index.md': '---\ntitle: Home\nslug: index\nstatus: published\n---\n\nHi.\n' }, opts);
    expect(bare.statements.some((x) => x.p.value.endsWith('/works-for'))).toBe(false);
    expect(extractStories(bare.statements)[0].steps).toHaveLength(5);
  });
});
