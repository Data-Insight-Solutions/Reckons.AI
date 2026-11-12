// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEmbed } from '../splat-embed.js';
import { EMBED_CSP, LOADER_SOURCE, parseEmbedArgs, renderEmbedHtml } from '../splat-embed-lib.js';

describe('parseEmbedArgs', () => {
  it('requires --splat and --out', () => {
    expect(() => parseEmbedArgs(['--out=x'])).toThrow(/--splat/);
    expect(() => parseEmbedArgs(['--splat=a.spz'])).toThrow(/--out/);
  });
  it('rejects unknown splat extensions and bad colours', () => {
    expect(() => parseEmbedArgs(['--splat=a.png', '--out=x'])).toThrow(/\.spz/);
    expect(() => parseEmbedArgs(['--splat=a.spz', '--out=x', '--bg=red'])).toThrow(/hex/);
  });
  it('reads optional title, poster and bg', () => {
    expect(parseEmbedArgs(['--splat=a.spz', '--out=x', '--title=T', '--poster=p.webp', '--bg=#101010']))
      .toMatchObject({ title: 'T', poster: 'p.webp', bg: '#101010' });
  });
});

describe('embed page', () => {
  it('CSP names no remote origin', () => {
    expect(EMBED_CSP).not.toMatch(/https?:|\/\/|\*/);
    expect(EMBED_CSP).toContain("default-src 'none'");
  });
  it('index.html loads only the loader, with no inline script', () => {
    const h = renderEmbedHtml({ title: 'T', splatFile: 'a.spz' });
    expect(h).toContain('src="loader.js"');
    expect(h).not.toContain('src="viewer.js"');
    expect(h).not.toMatch(/<script(?![^>]*src=)/);
  });
  it('loader injects viewer.js on first intersection with a 200px margin', () => {
    expect(LOADER_SOURCE).toContain("'viewer.js'");
    expect(LOADER_SOURCE).toContain("rootMargin: '200px'");
    expect(LOADER_SOURCE).toContain('disconnect');
  });
  it('escapes the title', () => {
    expect(renderEmbedHtml({ title: '<b>"x"', splatFile: 'a.spz' })).not.toContain('<b>"x"');
  });
});

describe('buildEmbed', () => {
  it('writes a self-contained folder', async () => {
    const d = mkdtempSync(join(tmpdir(), 'embed-test-'));
    writeFileSync(join(d, 'a.spz'), 'x'); writeFileSync(join(d, 'p.webp'), 'y');
    const out = join(d, 'out');
    await buildEmbed([`--splat=${join(d, 'a.spz')}`, `--out=${out}`, `--poster=${join(d, 'p.webp')}`]);
    expect(readdirSync(out).sort()).toEqual(['a.spz', 'index.html', 'loader.js', 'p.webp', 'viewer.css', 'viewer.js']);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).not.toMatch(/https?:\/\//);
  }, 60000);
});
