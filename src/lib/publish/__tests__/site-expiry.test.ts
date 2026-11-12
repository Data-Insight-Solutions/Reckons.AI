/**
 * F293 done-test (kb:facts-that-expire), on a synthetic fixture site: a credential dated past is reported
 * with every page that states it and site:build refuses those pages naming both; one within 60 days warns;
 * one with no date passes; an unknown date appears as an open question.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../site-build';
import {
  FACTS_FILE, classifyExpiry, collectExpiryFacts, describeExpiry, expiryFactsFromContent, parseExpiryMarkers, stripExpiryMarkers,
} from '../site-expiry';
import { factsFromTurtle } from '../../../../scripts/offline/fact-expiry';
import { buildSiteSpace } from '../../../../scripts/starter/build-site-space';

const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true }); });

const page = (slug: string, body: string, extra = ''): string => `---\ntitle: ${slug}\nslug: ${slug}\nstatus: published\ntemplate: doc\nnav: both\n${extra}---\n\n${body}\n`;
const FILES: Record<string, string> = {
  'content/index.md': page('index', '## Home\n\nWelcome.\n\n- Certificate Alpha, issued 2024 | valid-until: 2026-01-31\n'),
  'content/about.md': page('about', '## About\n\n- Certificate Alpha, issued 2024 | valid-until: 2026-01-31\n- Certificate [Beta](https://example.test/b) | valid-until: 2026-12-01\n- Certificate Gamma | valid-until: ?\n- Course Delta, 2024\n- Oct 2021 – Nov 2023 | Example Co | Engineer | logo: /assets/logos/x.svg | valid-until: 2099-01-01\n'),
  'content/draft.md': page('draft', '- Certificate Hidden | valid-until: 2020-01-01\n').replace('status: published', 'status: draft'),
};

describe('valid-until markers', () => {
  it('reads a date and an open date from a list entry, flattening links and ignoring logo segments', () => {
    const m = parseExpiryMarkers(FILES['content/about.md']);
    expect(m.map((x) => [x.text, x.validUntil])).toEqual([
      ['Certificate Alpha, issued 2024', '2026-01-31'],
      ['Certificate Beta', '2026-12-01'],
      ['Certificate Gamma', null],
      ['Oct 2021 – Nov 2023 | Example Co | Engineer', '2099-01-01'],
    ]);
  });
  it('refuses a marker that is not a real date or ?, and an entry that is only a marker', () => {
    expect(() => parseExpiryMarkers('- Thing | valid-until: soon')).toThrow(/YYYY-MM-DD/);
    expect(() => parseExpiryMarkers('- Thing | valid-until: 2026-02-31')).toThrow(/real date/);
    expect(() => parseExpiryMarkers('- valid-until: ?')).toThrow(/needs the entry/);
  });
  it('removes only the marker, leaving the entry and every other line', () => {
    const out = stripExpiryMarkers(FILES['content/about.md']);
    expect(out).not.toMatch(/valid-until/);
    expect(out).toContain('- Certificate Gamma\n');
    expect(out).toContain('| logo: /assets/logos/x.svg');
    expect(out).toContain('- Course Delta, 2024');
  });
  it('merges one fact stated on two pages, and refuses two dates for one fact', () => {
    const facts = expiryFactsFromContent(FILES);
    const alpha = facts.find((f) => f.label.startsWith('Certificate Alpha'))!;
    expect(alpha.pages.map((p) => p.path)).toEqual(['/about/', '/']);
    expect(facts.some((f) => f.label.includes('Hidden'))).toBe(false); // a draft page states nothing
    expect(() => collectExpiryFacts([
      { slug: 'a', isPost: false, body: '- X | valid-until: 2030-01-01' }, { slug: 'b', isPost: true, body: '- X | valid-until: 2031-01-01' },
    ])).toThrow(/two dates/);
  });
});

describe('classifyExpiry', () => {
  const facts = expiryFactsFromContent(FILES);
  it('sorts past, within 60 days, open and later, counting the last day as still valid', () => {
    const r = classifyExpiry(facts, '2026-01-31');
    expect(r.warning.map((f) => f.label)).toContain('Certificate Alpha, issued 2024'); // the date itself: 0 days left, still valid
    const late = classifyExpiry(facts, '2026-11-12');
    expect(late.expired.map((f) => f.label)).toEqual(['Certificate Alpha, issued 2024']);
    expect(late.warning.map((f) => [f.label, f.daysLeft])).toEqual([['Certificate Beta', 19]]);
    expect(late.open.map((f) => f.label)).toEqual(['Certificate Gamma']);
    expect(late.ok.length).toBe(1);
    expect(describeExpiry(late).join('\n')).toMatch(/EXPIRED 2026-01-31 .*stated on \/about\/, \//);
  });
  it('honours a different warning window', () => {
    expect(classifyExpiry(facts, '2026-11-12', 10).warning).toHaveLength(0);
  });
});

function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'expiry-site-'));
  tmp.push(dir);
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
}

describe('site:build and the check', () => {
  it('refuses to build a page that states an expired fact, naming fact and page; --allow-expired builds and says so', () => {
    const s = site(FILES);
    const out = join(mkdtempSync(join(tmpdir(), 'expiry-out-')), 'dist'); tmp.push(join(out, '..'));
    expect(() => buildSite({ site: s, out, today: '2026-11-12' })).toThrow(/Certificate Alpha, issued 2024.*expired 2026-01-31.*\/about\/, \//s);
    expect(existsSync(out)).toBe(false);
    const r = buildSite({ site: s, out, today: '2026-11-12', allowExpired: true });
    expect(r.expiry.overridden).toBe(true);
    expect(r.expiry.expired).toHaveLength(1);
    for (const f of r.files.filter((x) => x.endsWith('.html'))) expect(readFileSync(join(out, f), 'utf8')).not.toMatch(/valid-until/);
    expect(readFileSync(join(out, FACTS_FILE), 'utf8')).toContain('Certificate Gamma');
  });
  it('builds a site whose dated facts are all in date, warns inside the window, and a later run is identical', () => {
    const s = site({ ...FILES, 'content/index.md': page('index', '## Home\n\n- Certificate Alpha, issued 2024 | valid-until: 2027-01-31\n'), 'content/about.md': page('about', '- Certificate Alpha, issued 2024 | valid-until: 2027-01-31\n- Certificate Gamma | valid-until: ?\n') });
    const base = mkdtempSync(join(tmpdir(), 'expiry-out-')); tmp.push(base);
    const a = buildSite({ site: s, out: join(base, 'a'), today: '2026-12-15' });
    expect(a.expiry.warning.map((f) => f.label)).toEqual(['Certificate Alpha, issued 2024']);
    expect(a.expiry.open.map((f) => f.label)).toEqual(['Certificate Gamma']);
    expect(a.expiry.overridden).toBe(false);
    buildSite({ site: s, out: join(base, 'b'), today: '2026-12-15' });
    expect(readFileSync(join(base, 'a', FACTS_FILE), 'utf8')).toBe(readFileSync(join(base, 'b', FACTS_FILE), 'utf8'));
  });
  it('a site with no marker writes no facts file and an undated fact never expires', () => {
    const s = site({ 'content/index.md': page('index', '- Course Delta, 2024\n') });
    const out = join(mkdtempSync(join(tmpdir(), 'expiry-out-')), 'dist'); tmp.push(join(out, '..'));
    const r = buildSite({ site: s, out, today: '2099-01-01' });
    expect(existsSync(join(out, FACTS_FILE))).toBe(false);
    expect(r.expiry.expired).toHaveLength(0);
  });
  it('the check lists a Turtle file\'s facts with every page, and exits 1 on an expired fact', () => {
    const built = buildSiteSpace(FILES, { url: 'https://site.example.test', siteName: 'Example' });
    const facts = factsFromTurtle(built.text);
    expect(facts.map((f) => [f.label, f.validUntil, f.pages.map((p) => p.path)])).toContainEqual(['Certificate Alpha, issued 2024', '2026-01-31', ['/', '/about/']]);
    expect(facts.find((f) => f.label === 'Certificate Gamma')!.validUntil).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'expiry-ttl-')); tmp.push(dir);
    writeFileSync(join(dir, 's.ttl'), built.text);
    const run = (today: string) => spawnSync('npx', ['tsx', 'scripts/offline/fact-expiry.ts', '--ttl=' + join(dir, 's.ttl'), '--today=' + today], { encoding: 'utf8', cwd: process.cwd() });
    const late = run('2026-11-12');
    expect(late.status).toBe(1);
    expect(late.stdout).toMatch(/EXPIRED 2026-01-31/);
    expect(late.stdout).toMatch(/OPEN DATE: Certificate Gamma \| stated on \/about\//);
    expect(late.stdout).toMatch(/1 expired, 1 within 60 day\(s\), 1 open date\(s\), 1 ok/);
    expect(run('2025-06-01').status).toBe(0);
  }, 60000);
});
