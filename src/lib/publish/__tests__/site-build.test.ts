/**
 * F274.4.1 done-test — site:build: a site repository's content/ into static HTML with the
 * Reckons.AI engine. The done-test lives on kb:downstream-site-build (static/reckons-roadmap.ttl):
 *
 *   On a synthetic fixture site under src/lib/publish/__tests__/fixtures/ (three pages, one
 *   with status draft, an assets/ file and an admin/ folder): the output has index.html, one
 *   page per published file and none for the draft, assets/ and admin/ copied, and a second
 *   run is byte-identical. npm run check 0 errors.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { buildSite, BUILD_STAMP_FILE } from '../site-build';

const FIXTURE_SITE = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/fixture-site');
if (!existsSync(join(FIXTURE_SITE, 'content'))) {
  throw new Error('fixture site not found — run vitest from the repository root: ' + FIXTURE_SITE);
}

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

/** Recursively list a directory as sorted POSIX-relative paths (files only). */
function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const rest of listTree(join(dir, entry.name))) out.push(entry.name + '/' + rest);
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** Snapshot a directory tree as path -> bytes, for byte-for-byte comparison. */
function readTree(dir: string): Record<string, Buffer> {
  const tree: Record<string, Buffer> = {};
  for (const rel of listTree(dir)) tree[rel] = readFileSync(join(dir, rel));
  return tree;
}

function expectSameTree(dir: string, tree: Record<string, Buffer>): void {
  expect(Object.keys(readTree(dir)).sort()).toEqual(Object.keys(tree).sort());
  for (const rel of Object.keys(tree)) {
    expect(Buffer.compare(readFileSync(join(dir, rel)), tree[rel]), 'byte mismatch in ' + rel).toBe(0);
  }
}

/** Write one minimal content page (plain frontmatter values, one-line body). */
function writePage(site: string, slug: string, status: string): void {
  mkdirSync(join(site, 'content'), { recursive: true });
  writeFileSync(
    join(site, 'content', slug + '.md'),
    '---\ntitle: ' + slug + '\nslug: ' + slug + '\nstatus: ' + status + '\n---\nbody\n',
  );
}

describe('site:build (F274.4.1)', () => {
  it('builds index.html and one page per published file, and none for the draft', () => {
    const out = makeTmp('site-build-');
    const result = buildSite({ site: FIXTURE_SITE, out });

    expect(result.pageCount).toBe(2);
    expect(result.files).toContain('index.html');
    expect(result.files).toContain('about/index.html');
    expect(result.files).not.toContain('draft-idea/index.html');
    expect(result.files).toContain('styles.css');
    expect(result.files).toContain('graph.json');

    // The draft page must appear in NO output file — not the body, not the nav, not the JSON page index.
    for (const rel of result.files) {
      expect(readFileSync(join(out, rel), 'utf8'), 'draft leaked into ' + rel).not.toContain('DRAFT-SECRET-MARKER');
    }
  });

  it('copies assets/ and admin/ byte-for-byte', () => {
    const out = makeTmp('site-build-');
    buildSite({ site: FIXTURE_SITE, out });
    expect(
      Buffer.compare(readFileSync(join(out, 'assets/logo.svg')), readFileSync(join(FIXTURE_SITE, 'assets/logo.svg'))),
    ).toBe(0);
    expect(
      Buffer.compare(readFileSync(join(out, 'admin/config.yml')), readFileSync(join(FIXTURE_SITE, 'admin/config.yml'))),
    ).toBe(0);
  });

  it('writes _headers with the project hardening headers (CSP stays in each page meta tag)', () => {
    const out = makeTmp('site-build-');
    buildSite({ site: FIXTURE_SITE, out });
    const headers = readFileSync(join(out, '_headers'), 'utf8');
    expect(headers).toContain('Strict-Transport-Security: max-age=63072000; includeSubDomains');
    expect(headers).toContain('X-Frame-Options: SAMEORIGIN');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    // The generator puts CSP in a page meta tag; a header copy would risk divergence.
    expect(headers).not.toContain('Content-Security-Policy');
  });

  it('a second run into the same output directory is byte-identical', () => {
    const out = makeTmp('site-build-');
    const now = new Date('2026-11-13T00:00:00Z');
    buildSite({ site: FIXTURE_SITE, out, now });
    const first = readTree(out);
    buildSite({ site: FIXTURE_SITE, out, now });
    expectSameTree(out, first);
  });

  it('refuses to overwrite a directory it does not own', () => {
    const out = makeTmp('site-build-');
    writeFileSync(join(out, 'README.md'), 'not from site:build\n');
    expect(() => buildSite({ site: FIXTURE_SITE, out })).toThrow(/refus/i);
  });

  it('refuses a site directory without a content/ folder', () => {
    const site = makeTmp('site-build-site-');
    expect(() => buildSite({ site, out: makeTmp('site-build-') })).toThrow(/content/);
  });

  it('refuses a site whose pages are all drafts', () => {
    const site = makeTmp('site-build-site-');
    writePage(site, 'only', 'draft');
    expect(() => buildSite({ site, out: makeTmp('site-build-') })).toThrow(/published/i);
  });

  it('refuses a symlink anywhere in the site tree', () => {
    const site = makeTmp('site-build-site-');
    const target = makeTmp('site-build-target-');
    writePage(site, 'home', 'published');
    mkdirSync(join(site, 'assets'), { recursive: true });
    writeFileSync(join(target, 'secret.txt'), 'outside the site\n');
    symlinkSync(join(target, 'secret.txt'), join(site, 'assets', 'evil'));
    expect(() => buildSite({ site, out: makeTmp('site-build-') })).toThrow(/symlink/i);
  });
});

describe('F294.6 build stamp', () => {
  it('writes reckons-build.json with a null commit when the site is not a git checkout of its own', () => {
    const site = makeTmp('site-stamp-');
    cpSync(FIXTURE_SITE, site, { recursive: true });
    const out = makeTmp('site-stamp-out-');
    buildSite({ site, out: join(out, 'dist') });
    const stamp = JSON.parse(readFileSync(join(out, 'dist', BUILD_STAMP_FILE), 'utf8'));
    expect(Object.keys(stamp).sort()).toEqual(['builtAt', 'generator', 'siteCommit', 'version']);
    expect(stamp.generator).toBe('Reckons.AI');
    expect(stamp.siteCommit).toBeNull();
    expect(typeof stamp.version).toBe('string');
    expect(Number.isNaN(Date.parse(stamp.builtAt))).toBe(false);
  });

  it('records the site repository HEAD when the site is a git checkout', () => {
    const site = makeTmp('site-stamp-git-');
    cpSync(FIXTURE_SITE, site, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', site, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    const head = git('rev-parse', 'HEAD');
    const out = makeTmp('site-stamp-out-');
    const res = buildSite({ site, out: join(out, 'dist') });
    expect(res.files).toContain(BUILD_STAMP_FILE);
    expect(JSON.parse(readFileSync(join(out, 'dist', BUILD_STAMP_FILE), 'utf8')).siteCommit).toBe(head);
  });

  it('carries no secret: no webhook, no config path', () => {
    const out = makeTmp('site-stamp-out-');
    buildSite({ site: FIXTURE_SITE, out: join(out, 'dist') });
    expect(readFileSync(join(out, 'dist', BUILD_STAMP_FILE), 'utf8')).not.toMatch(/webhook|https?:/i);
  });

  it('is absent from a draft preview', () => {
    const out = makeTmp('site-stamp-out-');
    buildSite({ site: FIXTURE_SITE, out: join(out, 'dist'), includeDrafts: true });
    expect(existsSync(join(out, 'dist', BUILD_STAMP_FILE))).toBe(false);
  });
});
