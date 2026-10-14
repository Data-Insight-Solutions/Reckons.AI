/**
 * F107.10.3 — a space's .ttl copied ALONE into a clean profile still shows its passages.
 *
 * Profile A retains a synthetic source and exports its space file with the passages folded in.
 * Profile B is empty: no sources/ folder, nothing but that one file. After the same import path
 * workspace sync and the Spaces page use (populateKbFromTtl), the Source View's reader finds the
 * source's text and every passage, each with its statements. What B does NOT have is the original
 * document: only text and passages travel.
 */
import { describe, it, expect, vi } from 'vitest';
import { toTurtleFull } from '../../rdf/serialize';
import { iri, lit, type Source, type Statement } from '../../rdf/types';
import { retainSource, readRetainedText, readFoldedCorpora, adoptPassages, type CorpusRoot, type CorpusDir } from '../../ingest/source-corpus';
import { corporaFromImported } from '../../ingest/source-chunks';
import { deriveSourceDocument } from '../../ingest/source-document';

vi.mock('../../storage/db', () => ({ db: {}, KBaseDB: class {}, DEFAULT_SETTINGS: {} }));
vi.mock('../../safety/content-policy', async (orig) => ({
  ...(await orig<typeof import('../../safety/content-policy')>()),
  classifyText: (t: string) => ({ rating: t.includes('BLOCKME') ? 'blocked' : 'none', flags: [] }),
}));

function fakeRoot() {
  const dirs = new Map<string, Map<string, string | Uint8Array>>();
  const root: CorpusRoot = {
    async listDirs() { return [...dirs.keys()]; },
    async openDir(name, create): Promise<CorpusDir | null> {
      if (!dirs.has(name)) { if (!create) return null; dirs.set(name, new Map()); }
      const files = dirs.get(name)!;
      return { async write(n, d) { files.set(n, d); }, async readText(n) { const v = files.get(n); return typeof v === 'string' ? v : null; } };
    },
  };
  return { root, dirs };
}
async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// FakeDB, as in kb-import-roundtrip.test.ts
class FakeTable {
  rows = new Map<string, any>();
  async toArray() { return [...this.rows.values()]; }
  async put(r: any) { this.rows.set(r.id, r); }
  async bulkPut(rs: any[]) { for (const r of rs) this.rows.set(r.id, r); }
  async bulkDelete(ks: string[]) { for (const k of ks) this.rows.delete(k); }
  async clear() { this.rows.clear(); }
  async get(k: string) { return this.rows.get(k); }
  where(field: string) { return { equals: (v: any) => ({ toArray: async () => [...this.rows.values()].filter((r) => r[field] === v) }) }; }
}
class FakeDB {
  name = 'kbase';
  statements = new FakeTable(); sources = new FakeTable(); settings = new FakeTable(); entityGifs = new FakeTable();
  glbOverrides = new FakeTable(); icon2dOverrides = new FakeTable(); kbSnapshots = new FakeTable();
  async transaction(_m: string, _t: unknown, cb: () => Promise<unknown>) { return cb(); }
}

const TEXT = Array.from({ length: 30 }, (_, i) => `Passage paragraph ${i}. ${'The harbor handled grain and timber. '.repeat(12)}`).join('\n\n');

async function profileA() {
  const hash = await sha256(TEXT);
  const a = fakeRoot();
  await retainSource(a.root, {
    sourceId: 'src-1', title: 'Harbor History', hash, text: TEXT, generatedAt: '2026-10-01T00:00:00.000Z',
    original: { bytes: new Uint8Array([1, 2, 3]), filename: 'harbor.pdf', mediaType: 'application/pdf' },
  });
  const source: Source = { id: 'src-1', title: 'Harbor History', uri: 'file://harbor.pdf', kind: 'document', ingestedAt: 1_000_000, hash } as Source;
  const excerpt = 'Passage paragraph 20.';
  const statements: Statement[] = [{
    id: 's1', s: iri('urn:kbase:concept/harbor'), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('Harbor'),
    g: iri('urn:kbase:source/src-1'), sourceId: 'src-1', confidence: 0.9, status: 'confirmed', createdAt: 1, updatedAt: 1, excerpt, grounded: true,
  }];
  return { a, hash, source, statements };
}

describe('a space file copied alone keeps its passages (F107.10.3)', () => {
  it('profile B, with only the .ttl, reads the source text and every passage with its statements', async () => {
    const { a, hash, source, statements } = await profileA();
    const folded = await readFoldedCorpora(a.root, [source]);
    const ttl = toTurtleFull(statements, [source], { chunks: folded });

    const b = fakeRoot();
    vi.doMock('../source-corpus', () => ({
      adoptSpacePassages: async (chunks: any, versions: any, srcs: Array<{ id: string; title: string }>) =>
        adoptPassages(b.root, corporaFromImported(chunks, versions), Object.fromEntries(srcs.map((s) => [s.id, s.title]))),
    }));
    const { populateKbFromTtl } = await import('../kb-import');
    const target = new FakeDB();
    const written = await populateKbFromTtl(target as never, 'Copied space', 'file://copied.ttl', ttl, new Map());
    expect(written).toBe(1);

    // The Source View's reader: text by hash, then the derived passages.
    const text = await readRetainedText(b.root, hash);
    expect(text).toBe(TEXT);
    const doc = deriveSourceDocument(text, [...target.statements.rows.values()]);
    expect(doc.kind).toBe('document');
    if (doc.kind !== 'document') return;
    expect(doc.passages.length).toBeGreaterThan(1);
    expect(doc.passages.map((p) => p.text).join('')).toBe(TEXT);
    expect(doc.passages.flatMap((p) => p.statements).map((s) => s.id)).toEqual(['s1']);
    expect(doc.unplaced).toHaveLength(0);

    // Passages, not the original document: B holds no original bytes.
    const names = [...b.dirs.values()].flatMap((d) => [...d.keys()]);
    expect(names.sort()).toEqual(['chunks.ttl', 'text.md']);
    expect([...a.dirs.values()].flatMap((d) => [...d.keys()]).some((n) => n.startsWith('original.'))).toBe(true);
    vi.doUnmock('../source-corpus');
  });

  describe('adoptPassages refuses what it cannot verify, and says why', () => {
    const base = async () => {
      const hash = await sha256(TEXT);
      const { chunkText } = await import('../../ingest/source-chunks');
      return { hash, corpus: { sourceId: 'src-1', sha256: hash, generatedAt: '2026-10-01T00:00:00.000Z', chunks: chunkText(TEXT) } };
    };
    it('adopts a faithful corpus', async () => {
      const { corpus } = await base();
      const r = await adoptPassages(fakeRoot().root, [corpus], { 'src-1': 'Harbor History' });
      expect(r.adopted).toEqual(['src-1']);
    });
    it('a same-length alteration in transit no longer hashes to its version: skipped', async () => {
      const { corpus } = await base();
      const bad = { ...corpus, chunks: corpus.chunks.map((c, i) => (i === 1 ? { ...c, text: c.text.replace('harbor', 'Harbor') } : c)) };
      const f = fakeRoot();
      const r = await adoptPassages(f.root, [bad], { 'src-1': 'Harbor History' });
      expect(r.adopted).toEqual([]);
      expect(r.skipped[0].reason).toMatch(/hash/);
      expect(f.dirs.size).toBe(0);
    });
    it('a missing passage leaves a gap: skipped', async () => {
      const { corpus } = await base();
      const r = await adoptPassages(fakeRoot().root, [{ ...corpus, chunks: corpus.chunks.filter((_, i) => i !== 1) }], { 'src-1': 'x' });
      expect(r.skipped[0].reason).toMatch(/cover/);
    });
    it('no version named: skipped', async () => {
      const { corpus } = await base();
      const r = await adoptPassages(fakeRoot().root, [{ ...corpus, sha256: undefined }], {});
      expect(r.skipped[0].reason).toMatch(/version/);
    });
    it('a source already retained here is left alone (an original wins)', async () => {
      const { hash, corpus } = await base();
      const f = fakeRoot();
      await retainSource(f.root, { sourceId: 'src-1', title: 'Harbor History', hash, text: TEXT, original: { bytes: new Uint8Array([9]), filename: 'o.pdf' } });
      const before = JSON.stringify([...f.dirs.entries()].map(([k, v]) => [k, [...v.keys()]]));
      const r = await adoptPassages(f.root, [corpus], { 'src-1': 'Harbor History' });
      expect(r.alreadyHere).toEqual(['src-1']);
      expect(JSON.stringify([...f.dirs.entries()].map(([k, v]) => [k, [...v.keys()]]))).toBe(before);
    });
    it('an upper-case version is the same version (hex case is not identity)', async () => {
      const { corpus } = await base();
      const f = fakeRoot();
      const r = await adoptPassages(f.root, [{ ...corpus, sha256: corpus.sha256!.toUpperCase() }], { 'src-1': 'T' });
      expect(r.adopted).toEqual(['src-1']);
      expect([...f.dirs.keys()][0]).toMatch(/-[0-9a-f]{8}$/);
    });
    it('a title with path separators never leaves the corpus root', async () => {
      const { corpus } = await base();
      const f = fakeRoot();
      await adoptPassages(f.root, [corpus], { 'src-1': '../../../etc/passwd' });
      expect([...f.dirs.keys()].every((k) => !k.includes('/') && !k.includes('..'))).toBe(true);
    });
    it('astral characters count in UTF-16 units, as the chunker wrote them', async () => {
      const { chunkText } = await import('../../ingest/source-chunks');
      const text = `${'🙂 emoji and 日本語 text. '.repeat(400)}`;
      const hash = await sha256(text);
      const r = await adoptPassages(fakeRoot().root, [{ sourceId: 's', sha256: hash, generatedAt: 'x', chunks: chunkText(text) }], { s: 't' });
      expect(r.adopted).toEqual(['s']);
    });
    it('shuffled passages are put in order before they are checked', async () => {
      const { corpus } = await base();
      const r = await adoptPassages(fakeRoot().root, [{ ...corpus, chunks: [...corpus.chunks].reverse() }], { 'src-1': 'T' });
      expect(r.adopted).toEqual(['src-1']);
    });
    it('an empty corpus list adopts nothing and reports nothing', async () => {
      expect(await adoptPassages(fakeRoot().root, [], {})).toEqual({ adopted: [], alreadyHere: [], skipped: [] });
    });
    it('text the content gate blocks is not kept', async () => {
      const text = `${TEXT}\nBLOCKME`;
      const { chunkText } = await import('../../ingest/source-chunks');
      const hash = await sha256(text);
      const r = await adoptPassages(fakeRoot().root, [{ sourceId: 's', sha256: hash, generatedAt: 'x', chunks: chunkText(text) }], { s: 't' });
      expect(r.skipped[0].reason).toMatch(/gate/);
    });
  });
});
