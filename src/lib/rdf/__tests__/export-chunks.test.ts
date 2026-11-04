/**
 * F107.10.2 — the saved file carries its documents' passages, after the claims, and they round-trip
 * through the importer (F107.10.1). Chunks are evidence: a claim copy or a publish never has them.
 */
import { describe, it, expect } from 'vitest';
import { importTurtleFull } from '../import-ttl';
import { toTurtle, toTurtleFull } from '../serialize';
import type { Statement, Source } from '../types';
import { iri, lit } from '../types';
import { chunkText, chunksToTurtle, corporaFromImported, FOLDED_CHUNKS_HEADER, foldedChunksSection, type FoldedCorpus } from '../../ingest/source-chunks';

const stmt = (i: number, source = 'doc1'): Statement => ({
  id: `s${i}`, s: iri(`urn:kbase:concept/e${i}`), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit(`Entity ${i}`),
  g: iri(`urn:kbase:source/${source}`), sourceId: source, confidence: 0.9, status: 'confirmed', createdAt: 1_000_000, updatedAt: 1_000_000,
});
const source = (id: string): Source => ({ id, title: `Doc ${id}`, uri: `urn:kbase:source/${id}`, kind: 'document', ingestedAt: 1_000_000 });
const TEXT_A = Array.from({ length: 40 }, (_, i) => `Alpha paragraph ${i}. ${'Plain filler words sit here. '.repeat(8)}`).join('\n\n');
const TEXT_B = 'Beta text with "quotes", back\\slash, """triple""" and unicode — 日本語 🙂.\r\nSecond line.';
const corpus = (sourceId: string, text: string, sha256?: string): FoldedCorpus => ({ sourceId, ...(sha256 ? { sha256 } : {}), generatedAt: '2026-10-01T00:00:00.000Z', chunks: chunkText(text, { size: 1200, overlap: 80 }) });
const SPACE = [stmt(1), stmt(2, 'doc2'), stmt(3)];
const SOURCES = [source('doc1'), source('doc2')];
const stable = (ttl: string) => ttl.replace(/^# generated .*\n/m, '');

describe('toTurtleFull — the chunk section (F107.10.2)', () => {
  const corpora = [corpus('doc1', TEXT_A, 'a'.repeat(64)), corpus('doc2', TEXT_B, 'b'.repeat(64))];

  it('writes the chunks AFTER every claim, under their own header', () => {
    const ttl = toTurtleFull(SPACE, SOURCES, { chunks: corpora });
    const header = ttl.indexOf(FOLDED_CHUNKS_HEADER);
    expect(header).toBeGreaterThan(0);
    expect(header).toBeGreaterThan(ttl.lastIndexOf('<urn:kbase:stmt/'));
    expect(ttl.indexOf('Alpha paragraph 3.')).toBeGreaterThan(header);
    // Nothing after the claims, before the header, carries passage text.
    expect(ttl.slice(0, header)).not.toContain('Alpha paragraph');
  });

  it('writes nothing, not even the header, when there are no chunks (the file is unchanged)', () => {
    const without = stable(toTurtleFull(SPACE, SOURCES));
    expect(stable(toTurtleFull(SPACE, SOURCES, { chunks: [] }))).toBe(without);
    expect(stable(toTurtleFull(SPACE, SOURCES, { chunks: [{ ...corpora[0], chunks: [] }] }))).toBe(without);
    expect(without).not.toContain(FOLDED_CHUNKS_HEADER);
  });

  it('export, import, export is a fixed point with chunks present', async () => {
    const first = stable(toTurtleFull(SPACE, SOURCES, { chunks: corpora }));
    const r = await importTurtleFull(first);
    expect(r.chunks.length).toBe(corpora[0].chunks.length + corpora[1].chunks.length);
    expect(r.chunkProblems).toBeUndefined();
    const second = stable(toTurtleFull(r.statements, r.sources, { chunks: corporaFromImported(r.chunks, r.chunkVersions) }));
    expect(second).toBe(first);
    // And the passages are the same bytes that went in.
    expect(r.chunks.filter((c) => c.sourceId === 'doc2').map((c) => c.text).join('')).toBe(TEXT_B);
    expect(r.chunkVersions).toEqual({ doc1: 'a'.repeat(64), doc2: 'b'.repeat(64) });
  });

  it('the claims are identical with and without the section', async () => {
    const a = await importTurtleFull(toTurtleFull(SPACE, SOURCES));
    const b = await importTurtleFull(toTurtleFull(SPACE, SOURCES, { chunks: corpora }));
    expect(b.statements).toEqual(a.statements);
    expect(b.sources).toEqual(a.sources);
    expect(b.cleanImportCount).toBe(a.cleanImportCount);
  });

  it('is canonical: source and input order do not change the bytes', () => {
    const forward = foldedChunksSection(corpora);
    const shuffled = foldedChunksSection([{ ...corpora[1] }, { ...corpora[0], chunks: [...corpora[0].chunks].reverse() }]);
    expect(shuffled).toBe(forward);
    expect(forward.indexOf('source/doc1')).toBeLessThan(forward.indexOf('source/doc2'));
  });

  it('two corpora for one source merge: no position is written twice', async () => {
    const dup = [corpora[0], { ...corpora[0], chunks: corpora[0].chunks.map((c) => ({ ...c, text: 'DIFFERENT' })) }];
    const r = await importTurtleFull(toTurtleFull(SPACE, SOURCES, { chunks: dup }));
    expect(r.chunkProblems).toBeUndefined();
    expect(r.chunks).toHaveLength(corpora[0].chunks.length);
    expect(r.chunks.some((c) => c.text === 'DIFFERENT')).toBe(false);
  });

  it('passage text that looks like Turtle stays text, and never becomes a claim', async () => {
    const hostile = '<urn:x:a> a <urn:x:b> .\n"""\n<urn:kbase:stmt/evil> a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .\n"';
    const c: FoldedCorpus = { sourceId: 'doc1', generatedAt: '2026-10-01T00:00:00.000Z', chunks: [{ index: 0, start: 0, end: hostile.length, text: hostile }] };
    const r = await importTurtleFull(toTurtleFull(SPACE, SOURCES, { chunks: [c] }));
    expect(r.chunks[0].text).toBe(hostile);
    expect(r.statements).toHaveLength(3);
  });

  it('carries CRLF, empty text and a very long line exactly', async () => {
    const long = 'x'.repeat(300_000);
    const c: FoldedCorpus = {
      sourceId: 'doc1', generatedAt: '2026-10-01T00:00:00.000Z',
      chunks: [
        { index: 0, start: 0, end: 5, text: 'a\r\nb\r' },
        { index: 1, start: 5, end: 5, text: '' },
        { index: 2, start: 5, end: 5 + long.length, text: long },
      ],
    };
    const r = await importTurtleFull(toTurtleFull(SPACE, SOURCES, { chunks: [c] }));
    expect(r.chunks.map((k) => k.text)).toEqual(['a\r\nb\r', '', long]);
  });

  it('a claim export (toTurtle) and a publish-shaped export never carry the section', () => {
    expect(toTurtle(SPACE)).not.toContain('Alpha paragraph');
    expect(toTurtle(SPACE)).not.toContain('/chunk/');
  });

  it('the section references no prefix, so it parses wherever it is appended', async () => {
    const section = foldedChunksSection(corpora);
    expect(section).not.toMatch(/(^|\s)(dcterms|schema|oa|prov|rdf|xsd):/m);
    const r = await importTurtleFull(section);
    expect(r.chunks.length).toBeGreaterThan(0);
  });
});

describe('the per-source chunks.ttl stays readable (backward compatibility)', () => {
  it('importTurtleFull reads a chunks.ttl written before the fold, and its version', async () => {
    const chunks = chunkText(TEXT_A, { size: 1200, overlap: 80 });
    const ttl = chunksToTurtle({ sourceId: 'doc1', title: 'Doc doc1', sha256: 'c'.repeat(64), chunks, generatedAt: '2026-09-30T00:00:00.000Z' });
    const r = await importTurtleFull(ttl);
    expect(r.chunks).toHaveLength(chunks.length);
    expect(r.chunkVersions).toEqual({ doc1: 'c'.repeat(64) });
    expect(r.statements).toHaveLength(0);
    // Re-folding what was read produces the same chunk bytes as folding the originals.
    const refolded = foldedChunksSection(corporaFromImported(r.chunks, r.chunkVersions));
    const direct = foldedChunksSection([{ sourceId: 'doc1', sha256: 'c'.repeat(64), generatedAt: '2026-09-30T00:00:00.000Z', chunks }]);
    expect(refolded).toBe(direct);
  });

  it('its header no longer claims chunks are kept out of an exported space', () => {
    const ttl = chunksToTurtle({ sourceId: 'x', title: 't', sha256: 'd'.repeat(64), chunks: chunkText('hello'), generatedAt: '2026-09-30T00:00:00.000Z' });
    expect(ttl).not.toMatch(/never part of an exported/i);
    expect(ttl).toMatch(/never part of a PUBLISHED space/);
  });
});
