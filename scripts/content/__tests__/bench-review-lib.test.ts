import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import {
  DEFAULT_PROMPT, assertNoLeaks, buildSpace, differsBy, ensureImportMap, extractHtml, imageSettings, IMAGE_BRANCHES,
  judgeScene, luminanceVariance, plyPreview, scrub, splatSettings, type Row,
} from '../bench-review-lib';

const id = { home: '/home/someone', user: 'someone', host: 'workbox' };

describe('differsBy', () => {
  it('names only what changed from the baseline', () => {
    const base = splatSettings({ id: 'a', gaussians: 32768, steps: 20 });
    expect(differsBy(base, splatSettings({ id: 'b', gaussians: 262144, steps: 28 }))).toBe('gaussians 32768 → 262144, steps 20 → 28');
  });
  it('treats an omitted splat field as its default, so it is not a difference', () => {
    expect(differsBy(splatSettings({ id: 'a', gaussians: 1, steps: 2 }), splatSettings({ id: 'b', gaussians: 1, steps: 2, guidance: 3, canvas: 1024 }))).toMatch(/baseline/);
  });
  it('compares image branches', () => {
    expect(differsBy(imageSettings(IMAGE_BRANCHES[0]), imageSettings(IMAGE_BRANCHES[3]))).toBe('size 768 → 1024');
  });
});

describe('judgeScene', () => {
  const ok = { errors: [], hasCanvas: true, variance: 400, fps: 30, htmlBytes: 5000 };
  it('passes a healthy scene', () => expect(judgeScene(ok)).toMatchObject({ passed: 4, failed: 0 }));
  it('fails each check on its own', () => {
    expect(judgeScene({ ...ok, errors: ['x'] }).items.find((i) => i.id === 'ran')!.pass).toBe(false);
    expect(judgeScene({ ...ok, variance: 0 }).items.find((i) => i.id === 'not-blank')!.pass).toBe(false);
    expect(judgeScene({ ...ok, fps: 1 }).items.find((i) => i.id === 'fps')!.pass).toBe(false);
    expect(judgeScene({ ...ok, htmlBytes: 9e6 }).failed).toBe(1);
  });
  it('measures luminance variance', () => {
    expect(luminanceVariance(new Uint8Array(400).fill(10))).toBeLessThan(1e-6);
    expect(luminanceVariance(Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]))).toBeGreaterThan(1000);
  });
});

describe('scene code', () => {
  it('extracts a fenced file, or a bare document, and rejects prose', () => {
    expect(extractHtml('here\n```html\n<!doctype html><html><script>1</script></html>\n```\nbye')).toContain('<script>');
    expect(extractHtml('<html><body><script>1</script></body></html>')).toContain('<html>');
    expect(extractHtml('sorry, I cannot')).toBeNull();
  });
  it('replaces the model import map with the local one', () => {
    const out = ensureImportMap('<html><head><script type="importmap">{"imports":{"three":"https://cdn/x.js"}}</script></head></html>');
    expect(out).toContain('/bench-generation/assets/three/three.module.js');
    expect(out).not.toContain('cdn');
  });
});

describe('plyPreview', () => {
  it('draws a coloured point on a grey ground', () => {
    const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
    const head = `ply\nformat binary_little_endian 1.0\nelement vertex 2\n${names.map((n) => `property float ${n}\n`).join('')}end_header\n`;
    const body = new Float32Array([0, 0, 0, 2, 0, 0, 5, 1, 1, 1, 0, 2, 0, 5]);
    const buf = new Uint8Array(head.length + body.byteLength);
    buf.set(new TextEncoder().encode(head)); buf.set(new Uint8Array(body.buffer), head.length);
    const p = plyPreview(buf, 32);
    expect(p.rgba.length).toBe(32 * 32 * 4);
    expect(new Set(Array.from({ length: 1024 }, (_, i) => p.rgba[i * 4 + 1])).size).toBeGreaterThan(1);
  });
});

describe('leaks', () => {
  it('scrubs paths, ports and names', () => {
    const t = scrub('failed at /home/someone/x/a.js via http://127.0.0.1:41233/s on workbox', id);
    expect(t).not.toMatch(/someone|workbox|127\.0\.0\.1/);
  });
  it('refuses a text that still holds one', () => {
    expect(() => assertNoLeaks('see /home/other/x', id, 't')).toThrow(/refusing/);
    expect(() => assertNoLeaks('clean', id, 't')).not.toThrow();
  });
});

describe('buildSpace', () => {
  const rows: Row[] = [
    { kind: 'image', prompt: DEFAULT_PROMPT, branch: 'incumbent', settings: { size: 768, steps: 8 }, seed: 42, seconds: 15, peakVramMiB: 12000, bytes: 50000, pass: true, problems: [], file: 'image-incumbent-s42.webp' },
    { kind: 'image', prompt: DEFAULT_PROMPT, branch: 'steps-4', settings: { size: 768, steps: 4 }, seed: 42, seconds: 9, peakVramMiB: 12000, bytes: 40000, pass: true, problems: [], file: 'image-steps-4-s42.webp' },
    { kind: 'splat', prompt: DEFAULT_PROMPT, image: 'image-incumbent-s42.webp', config: { id: 'standard', gaussians: 32768, steps: 20 }, seconds: 40, peakVramMiB: 7000, peakRssGiB: 5.3, plyBytes: 2e6, spzBytes: 5e5, pass: true, problems: [], plyFile: 'splat-standard.ply', spzFile: 'splat-standard.spz', previewFile: 'splat-standard.webp' },
    { kind: 'splat', prompt: DEFAULT_PROMPT, image: 'image-incumbent-s42.webp', config: { id: 'max', gaussians: 262144, steps: 28 }, seconds: 60, peakVramMiB: 7000, plyBytes: 1.7e7, pass: true, problems: [], plyFile: 'splat-max.ply', previewFile: 'splat-max.webp' },
    { kind: 'three', prompt: DEFAULT_PROMPT, model: 'm1', threeVersion: '0.186.1', modelVramMiB: 18000, peakRssMiB: 900, attempts: [
      { label: 'first', codeSeconds: 30, replyBytes: 5000, htmlBytes: 4000, htmlFile: 'three-m1-first.html', extracted: true, errors: ['boom'], hasCanvas: false, variance: 0, fps: 0, items: [{ id: 'ran', pass: false, detail: 'boom' }], passed: 0, failed: 1, screenshot: 'three-m1-first.webp' },
      { label: 'repair', codeSeconds: 31, replyBytes: 5000, htmlBytes: 4100, htmlFile: 'three-m1-repair.html', extracted: true, errors: [], hasCanvas: true, variance: 300, fps: 20, items: [{ id: 'ran', pass: true, detail: 'ok' }], passed: 4, failed: 0, screenshot: 'three-m1-repair.webp' }] },
  ];
  const opts = { assetBase: '/bench-generation/assets', splatExt: 'ply' as const, identity: id, toolNote: 'tools' };
  const ttl = buildSpace(DEFAULT_PROMPT, rows, opts);
  it('is valid Turtle and byte-identical on a second run', () => {
    expect(() => new Parser().parse(ttl)).not.toThrow();
    expect(buildSpace(DEFAULT_PROMPT, rows, opts)).toBe(ttl);
  });
  it('states what differs from the baseline on each branch', () => {
    expect(ttl).toContain('p:differs-by "gaussians 32768 → 262144, steps 20 → 28"');
    expect(ttl).toContain('p:differs-by "steps 8 → 4"');
    expect(ttl).toContain('p:differs-by "nothing: this is the baseline branch"');
  });
  it('gives every branch an unreviewed verdict, a picture, and measured literals', () => {
    expect((ttl.match(/kmeta:review-verdict "unreviewed"/g) ?? []).length).toBe(5);
    expect(ttl).toContain('p:splat "/bench-generation/assets/splat-standard.ply"');
    expect(ttl).toContain('p:seconds "40.0"^^xsd:decimal');
    expect(ttl).toContain('p:checks-failed "0"^^xsd:integer');
  });
  it('shows the repair as its own step and the public copy ships SPZ only', () => {
    expect(ttl).toContain('Repair: write fixed code');
    const pub = buildSpace(DEFAULT_PROMPT, rows, { ...opts, assetBase: '/generated/bench', splatExt: 'spz' });
    expect(pub).toContain('"/generated/bench/splat-standard.spz"');
    expect(pub).not.toContain('.ply"');
  });
});
