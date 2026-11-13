import { describe, expect, it } from 'vitest';
import { buildSiteSpace } from '../build-site-space';
import { parseCardRecord } from '../site-card';
import { extractStories } from '../../../src/lib/rdf/story';

// Synthetic: an invented studio and card. Nothing here is a real person's text or image.
const K = 'urn:kbase:concept/';
const home = '---\ntitle: Home\nslug: index\nstatus: published\n---\n\nHi.\n';
const about = '---\ntitle: About\nslug: about\ntemplate: sections\nstatus: published\n---\n\n## About ==Example Studio==\n@section: hero\n\nExample Studio LLC is a Nebraska limited liability company, formed in 2019, and a consultancy in Lakeside, Nebraska, working remotely with teams anywhere.\n\n## ==Pat Example==, founder\n@section: text\n@id: owner\n\nI\'m Pat Example, the founder of Example Studio: a planner.\n';
const record = {
  schema: 1,
  design: { name: 'Example card', owner: 'Example Studio LLC', person: 'Pat Example', size: '3.5 x 2 in', tool: 'Designer', brand: { colours: ['navy #001122'], fonts: ['Sans'], logo: 'the mark' }, publicCopy: 'Back shown without the phone.' },
  designVersions: [{ id: 'd1', date: '2026-01-01', summary: 'First.' }, { id: 'd2', date: '2026-01-02', summary: 'Bigger text.' }, { id: 'd3', date: '2026-01-03', summary: 'Moved a dot.' }],
  printSheetSpec: { paper: 'US Letter', layout: '2 x 5', bleed: '1/8 in', marks: 'crop marks', duplex: 'long edge', note: 'n', script: 'scripts/content/print-sheet.ts' },
  printSheets: [{ id: 'v1', madeFrom: 'd1', what: 'First sheet.', why: 'To see it.' }, { id: 'v2', madeFrom: 'd2', what: 'Rebuilt.', why: 'Text too small.' }, { id: 'v3', madeFrom: 'd3', what: 'Rebuilt again.', why: 'Design changed.' }],
  sheetsPrivate: 'The sheets are private PDFs.',
  process: ['Made in the tool.', 'Printed.'],
};
const opts = { url: 'https://site.example.test', publisher: 'Example Studio LLC', siteName: 'Example Studio' };
const has = (r: ReturnType<typeof buildSiteSpace>, s: string, p: string, o?: string) =>
  r.statements.some((x) => x.s.value === s && x.p.value.endsWith(p) && (o === undefined || x.o.value === o));

describe('the business card in the site space (F294.8)', () => {
  const files = { 'content/index.md': home, 'content/about.md': about };
  const r = buildSiteSpace(files, { ...opts, card: parseCardRecord(JSON.stringify(record)) });

  it('the design is owned by the company, shows the person and has two image sides', () => {
    const d = K + 'dis-business-card';
    expect(has(r, d, '/owned-by', K + 'dis-llc')).toBe(true);
    expect(has(r, d, '/shows', K + 'dis-person-pat-example')).toBe(true);
    expect(has(r, d, '/has-side', K + 'dis-business-card-front')).toBe(true);
    expect(has(r, K + 'dis-business-card-back', '/icon2d', '/media/dis-business-card-back.webp')).toBe(true);
  });
  it('each sheet is derived from the design version it was made from and superseded by the next', () => {
    expect(has(r, K + 'dis-business-card-sheet-v2', '/derived-from', K + 'dis-business-card-design-d2')).toBe(true);
    expect(has(r, K + 'dis-business-card-sheet-v1', '/superseded-by', K + 'dis-business-card-sheet-v2')).toBe(true);
    expect(has(r, K + 'dis-business-card-sheet-v3', '/superseded-by')).toBe(false);
    expect(has(r, K + 'dis-business-card-design-d1', '/superseded-by', K + 'dis-business-card-design-d2')).toBe(true);
    expect(has(r, K + 'dis-business-card-sheet-v3', '/visibility', 'private')).toBe(true);
  });
  it('the rule says to regenerate when the design changes and points at the latest sheet', () => {
    expect(has(r, K + 'dis-business-card-rule', '/applies-to', K + 'dis-business-card')).toBe(true);
    expect(has(r, K + 'dis-business-card-rule', '/regenerates', K + 'dis-business-card-sheet-v3')).toBe(true);
  });
  it('adds one story step after "Who is behind the site" with computed counts and resolving highlights', () => {
    const [st] = extractStories(r.statements);
    const titles = st.steps.map((x) => x.title);
    expect(titles.indexOf('The business card, and its print sheets')).toBe(titles.indexOf('Who is behind the site') + 1);
    const step = st.steps[titles.indexOf('The business card, and its print sheets')];
    expect(step.content).toContain('3 print sheets were built from it across 3 versions');
    const nodes = new Set(r.statements.map((x) => x.s.value));
    for (const h of step.highlights) expect(nodes.has(h), h).toBe(true);
  });
  it('is deterministic, and with no card record nothing about a card appears', () => {
    expect(buildSiteSpace(files, { ...opts, card: parseCardRecord(JSON.stringify(record)) }).text).toBe(r.text);
    expect(buildSiteSpace(files, opts).text).not.toContain('business-card');
  });
  it('refuses a record that carries a phone number or a sheet made from an unknown version', () => {
    expect(() => parseCardRecord(JSON.stringify({ ...record, process: ['Call (555) 010-1234'] }))).toThrow(/phone/);
    expect(() => parseCardRecord(JSON.stringify({ ...record, process: ['Call 555-010-1234'] }))).toThrow(/phone/);
    expect(() => parseCardRecord(JSON.stringify({ ...record, printSheets: [{ id: 'v9', madeFrom: 'dX', what: 'a', why: 'b' }] }))).toThrow(/unknown design version/);
    expect(() => parseCardRecord(JSON.stringify(record))).not.toThrow();
  });
});
