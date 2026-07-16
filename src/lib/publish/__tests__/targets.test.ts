/**
 * Publish targets (F76) — the per-host limits and the asset-size preflight that answers the
 * file-size worry: which files will a given host reject before we try to publish.
 */
import { describe, it, expect } from 'vitest';
import { PUBLISH_TARGETS, getTarget, checkAssetSizes, formatBytes } from '../targets';

describe('PUBLISH_TARGETS', () => {
  it('Cloudflare Pages is the first (decided) target and caps files at 25 MB', () => {
    expect(PUBLISH_TARGETS[0].id).toBe('cloudflare-pages');
    expect(getTarget('cloudflare-pages')!.perFileLimitMB).toBe(25);
  });

  it('GitHub Pages is present but tighter (100 MB/file) — kept, not led with', () => {
    const gh = getTarget('github-pages')!;
    expect(gh.perFileLimitMB).toBe(100);
    expect(PUBLISH_TARGETS.findIndex((t) => t.id === 'github-pages')).toBeGreaterThan(0);
  });

  it('the zip target is always available and unlimited', () => {
    const zip = getTarget('zip')!;
    expect(zip.deploy).toBe('manual');
    expect(zip.perFileLimitMB).toBe(Infinity);
  });

  it('Cloudflare and Netlify can deploy from either git backend; GitLab Pages only from GitLab', () => {
    expect(getTarget('cloudflare-pages')!.gitBackends).toEqual(['github', 'gitlab']);
    expect(getTarget('gitlab-pages')!.gitBackends).toEqual(['gitlab']);
  });

  it('Cloudflare deploys via the Wrangler CLI (local install acceptable), with a real deploy command', () => {
    const cf = getTarget('cloudflare-pages')!;
    expect(cf.deploy).toBe('cli');
    expect(cf.cli!.tool).toBe('wrangler');
    expect(cf.cli!.command('./build', 'my-site')).toBe('wrangler pages deploy ./build --project-name=my-site');
  });

  it('every target carries setup guidance, and hosted targets note the DNS/custom-domain step', () => {
    for (const t of PUBLISH_TARGETS) expect(t.setup.length).toBeGreaterThan(0);
    for (const t of PUBLISH_TARGETS.filter((x) => x.id !== 'zip')) expect(t.dns).toBeTruthy();
  });
});

describe('checkAssetSizes — the preflight', () => {
  const files = {
    'index.html': 'x'.repeat(1000), // ~1 KB
    'assets/big.glb': 30 * 1024 * 1024, // 30 MB (over Cloudflare's 25, under GitHub's 100)
    'assets/huge.mp4': 120 * 1024 * 1024, // 120 MB (over both)
  };

  it('flags files over Cloudflare 25 MB (the GLB and the video)', () => {
    const w = checkAssetSizes(files, getTarget('cloudflare-pages')!);
    expect(w.map((x) => x.path)).toEqual(['assets/huge.mp4', 'assets/big.glb']); // largest first
    expect(w[0].limitMB).toBe(25);
  });

  it('on GitHub Pages only the 120 MB video is over the 100 MB cap', () => {
    const w = checkAssetSizes(files, getTarget('github-pages')!);
    expect(w.map((x) => x.path)).toEqual(['assets/huge.mp4']);
  });

  it('unlimited targets (zip) warn about nothing', () => {
    expect(checkAssetSizes(files, getTarget('zip')!)).toEqual([]);
  });

  it('measures UTF-8 byte length of string content', () => {
    const w = checkAssetSizes({ 'a.txt': 'é'.repeat(20 * 1024 * 1024) }, getTarget('cloudflare-pages')!);
    expect(w).toHaveLength(1); // 'é' is 2 bytes → 40 MB > 25 MB
  });
});

describe('formatBytes', () => {
  it('formats B / KB / MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
