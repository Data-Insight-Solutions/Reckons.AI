/**
 * F122.1 DONE WHEN, part 2 — graph publication/export excludes the original document bytes.
 *
 * A synthetic "PDF" with unmistakable marker bytes is retained under a source corpus folder. Every
 * export serializer the app has is then run over a graph that cites that source, and none of their
 * output may contain the marker, its base64, its hex, the original.* filename, or the corpus path.
 * A control assertion proves the original really IS retained, so the exclusion is not vacuous.
 * Passages (text) legitimately travel in a space file (F107.10); the original document does not.
 */
import { describe, it, expect, vi } from 'vitest';
import { toTurtle, toTurtleFull, toNQuads, toTriG } from '../../rdf/serialize';
import { iri, lit, type Source, type Statement } from '../../rdf/types';
import { retainSource, readFoldedCorpora, CORPUS_DIR, type CorpusRoot, type CorpusDir } from '../../ingest/source-corpus';
import { attachAnchors } from '../../ingest/source-chunks';
import { buildSiteFiles } from '../../publish/site-export';

vi.mock('../../storage/db', () => ({ db: {}, KBaseDB: class {}, DEFAULT_SETTINGS: {} }));

const MARKER = 'ORIGINAL-PDF-BYTES-MARKER-7f3a9c';
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new TextEncoder().encode(MARKER), 0x00, 0xff, 0xfe]);
const b64 = btoa(String.fromCharCode(...bytes));
const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
const TEXT = Array.from({ length: 20 }, (_, i) => `Page ${i}. The quay handled grain and timber. ${'Filler words sit here. '.repeat(10)}`).join('\n\n');

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
async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fixture() {
  const hash = await sha256(TEXT);
  const f = fakeRoot();
  await retainSource(f.root, { sourceId: 'src-1', title: 'Quay Ledger', hash, text: TEXT, generatedAt: '2026-10-01T00:00:00.000Z', original: { bytes, filename: 'ledger.pdf', mediaType: 'application/pdf' } });
  const source: Source = { id: 'src-1', title: 'Quay Ledger', uri: 'file://ledger.pdf', kind: 'document', ingestedAt: 1, hash } as Source;
  const base: Statement = {
    id: 's1', s: iri('urn:kbase:concept/quay'), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('Quay'),
    g: iri('urn:kbase:source/src-1'), sourceId: 'src-1', confidence: 0.9, status: 'confirmed', createdAt: 1, updatedAt: 1,
    excerpt: 'Page 7. The quay handled grain', grounded: true,
  };
  const statements = attachAnchors([base], source, TEXT) as Statement[];
  return { f, hash, source, statements };
}

function expectNoOriginal(out: string, label: string) {
  for (const needle of [MARKER, b64, hex, 'original.pdf', 'original.']) {
    expect(out.includes(needle), `${label} must not contain ${needle}`).toBe(false);
  }
  expect(out.includes(`${CORPUS_DIR}/`), `${label} must not point into the corpus folder`).toBe(false);
}

describe('exports exclude the retained original document bytes', () => {
  it('control: the original IS retained in the corpus folder (so the exclusion below means something)', async () => {
    const { f } = await fixture();
    const files = [...f.dirs.values()].flatMap((d) => [...d.entries()]);
    const original = files.find(([n]) => n.startsWith('original.'));
    expect(original).toBeTruthy();
    expect(original![1]).toEqual(bytes);
  });

  it('the fixture statement really carries an anchor (so the anchor export path is exercised)', async () => {
    const { statements } = await fixture();
    expect(statements[0].anchor).toBeDefined();
  });

  it('toTurtleFull (space export) with passages folded in carries text and anchors, never the original', async () => {
    const { f, source, statements } = await fixture();
    const folded = await readFoldedCorpora(f.root, [source]);
    expect(folded.length).toBe(1);
    const ttl = toTurtleFull(statements, [source], { chunks: folded });
    expect(ttl).toContain('The quay handled grain'); // passages travel
    expect(ttl).toContain('http://www.w3.org/ns/oa#hasTarget'); // anchors travel
    expectNoOriginal(ttl, 'toTurtleFull');
  });

  it('toTurtleFull without passages, toTurtle, toNQuads and toTriG never contain the original', async () => {
    const { source, statements } = await fixture();
    expectNoOriginal(toTurtleFull(statements, [source]), 'toTurtleFull (no chunks)');
    expectNoOriginal(toTurtle(statements), 'toTurtle');
    expectNoOriginal(toNQuads(statements), 'toNQuads');
    expectNoOriginal(toTriG(statements), 'toTriG');
  });

  it('the published site file set never contains the original', async () => {
    const { statements } = await fixture();
    const files = buildSiteFiles(statements);
    for (const [path, body] of Object.entries(files)) {
      expect(path.startsWith(`${CORPUS_DIR}/`), path).toBe(false);
      expect(path.startsWith('original.'), path).toBe(false);
      expectNoOriginal(String(body), path);
    }
  });
});
