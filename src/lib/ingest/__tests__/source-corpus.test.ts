import { describe, it, expect, vi } from 'vitest';

// Synthetic stand-in for the content policy: the gate is what is under test, not its patterns.
vi.mock('../../safety/content-policy', () => ({
  classifyText: (t: string) => ({ rating: t.includes('BLOCKME') ? 'blocked' : 'none', flags: [] }),
}));
import {
  slugify, hash8, corpusDirName, findCorpusDir, originalExtension, retainSource, readRetainedText,
  type CorpusRoot, type CorpusDir,
} from '../source-corpus';
import { deriveEvidence } from '../statement-evidence';

/** In-memory CorpusRoot. `failOn` makes a named file's write throw. */
function fakeRoot(failOn?: string) {
  const dirs = new Map<string, Map<string, string | Uint8Array>>();
  const root: CorpusRoot = {
    async listDirs() { return [...dirs.keys()]; },
    async openDir(name, create): Promise<CorpusDir | null> {
      if (!dirs.has(name)) { if (!create) return null; dirs.set(name, new Map()); }
      const files = dirs.get(name)!;
      return {
        async write(n, data) { if (n === failOn) throw new Error('disk full'); files.set(n, data); },
        async readText(n) { const v = files.get(n); return typeof v === 'string' ? v : null; },
      };
    },
  };
  return { root, dirs };
}

const TEXT = 'The harbor opened in 1902. It handled grain and timber.\n\nBy 1950 it was mostly passenger ferries.';
const base = { sourceId: 'src-1', title: 'Harbor History', hash: 'abcdef0123456789', text: TEXT };

describe('naming', () => {
  it('slugs are lowercase ascii, bounded and never empty', () => {
    expect(slugify('  Harbor: History & Más!  ')).toBe('harbor-history-mas');
    expect(slugify('???')).toBe('source');
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
  it('dir name is slug-hash8 and refuses an unusable hash', () => {
    expect(corpusDirName('Harbor History', 'ABCDEF0123456789')).toBe('harbor-history-abcdef01');
    expect(hash8('abc')).toBeNull();
    expect(corpusDirName('x', '')).toBeNull();
  });
  it('finds a dir by hash even after the title changed', () => {
    expect(findCorpusDir(['old-title-abcdef01', 'other-11111111'], 'abcdef0123')).toBe('old-title-abcdef01');
    expect(findCorpusDir(['other-11111111'], 'abcdef01')).toBeNull();
  });
  it('original extension: filename, then media type, then bin', () => {
    expect(originalExtension('Report.PDF')).toBe('pdf');
    expect(originalExtension(undefined, 'text/html; charset=utf-8')).toBe('html');
    expect(originalExtension('noext', 'application/x-weird')).toBe('bin');
  });
});

describe('retainSource', () => {
  it('writes text.md and chunks.ttl, and original bytes unmodified when given', async () => {
    const { root, dirs } = fakeRoot();
    const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
    const r = await retainSource(root, { ...base, original: { bytes, filename: 'a.pdf' } });
    expect(r).toEqual({ status: 'retained', dir: 'harbor-history-abcdef01', files: ['original.pdf', 'text.md', 'chunks.ttl'] });
    const files = dirs.get('harbor-history-abcdef01')!;
    expect(files.get('original.pdf')).toBe(bytes);
    expect(files.get('text.md')).toBe(TEXT);
    expect(String(files.get('chunks.ttl'))).toContain('urn:kbase:source/src-1/chunk/0');
  });
  it('writes no original when there are no bytes', async () => {
    const { root, dirs } = fakeRoot();
    await retainSource(root, base);
    expect([...dirs.get('harbor-history-abcdef01')!.keys()]).toEqual(['text.md', 'chunks.ttl']);
  });
  it('does not retain text the safety gate blocks, and creates nothing', async () => {
    const { root, dirs } = fakeRoot();
    expect(await retainSource(root, { ...base, text: 'BLOCKME synthetic' })).toEqual({ status: 'blocked' });
    expect(dirs.size).toBe(0);
  });
  it('reports a write failure as a result, never an exception', async () => {
    const { root } = fakeRoot('chunks.ttl');
    const r = await retainSource(root, base);
    expect(r).toEqual({ status: 'failed', error: 'disk full' });
  });
  it('skips empty text and unusable hashes without creating anything', async () => {
    const { root, dirs } = fakeRoot();
    expect(await retainSource(root, { ...base, text: '' })).toEqual({ status: 'skipped', reason: 'no-text' });
    expect(await retainSource(root, { ...base, hash: '' })).toEqual({ status: 'skipped', reason: 'no-hash' });
    expect(dirs.size).toBe(0);
  });
});

describe('readRetainedText + evidence', () => {
  it('round-trips, and evidence anchors a real passage from the retained text', async () => {
    const { root } = fakeRoot();
    await retainSource(root, base);
    const text = await readRetainedText(root, base.hash);
    expect(text).toBe(TEXT);
    const ev = deriveEvidence({ sourceTitle: 'Harbor History', excerpt: 'It handled grain and timber.', sourceText: text });
    expect(ev.kind).toBe('anchored');
    if (ev.kind === 'anchored') expect(ev.highlight).toBe('It handled grain and timber.');
  });
  it('returns null for an unknown source or a missing hash', async () => {
    const { root } = fakeRoot();
    expect(await readRetainedText(root, 'ffffffff00')).toBeNull();
    expect(await readRetainedText(root, '')).toBeNull();
  });
});
