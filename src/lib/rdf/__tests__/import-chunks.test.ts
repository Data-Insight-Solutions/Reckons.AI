/**
 * F107.10.1 — the importer reads chunk nodes instead of dropping them. Chunks are evidence, never
 * claims: they come back in `chunks`, and the statements, the sources and the plain-Turtle
 * fallback are exactly what they were without them.
 */
import { describe, it, expect } from 'vitest';
import { importTurtleFull } from '../import-ttl';
import { toTurtleFull } from '../serialize';
import type { Statement, Source } from '../types';
import { iri, lit } from '../types';
import { chunkText, chunksToTurtle } from '../../ingest/source-chunks';

function stmt(i: number): Statement {
  return {
    id: `s${i}`, s: iri(`urn:kbase:concept/e${i}`), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit(`Entity ${i}`),
    g: iri('urn:kbase:source/doc1'), sourceId: 'doc1', confidence: 0.9, status: 'confirmed', createdAt: 1_000_000, updatedAt: 1_000_000,
  };
}
const SOURCE: Source = { id: 'doc1', title: 'A document', uri: 'urn:kbase:source/doc1', kind: 'document', ingestedAt: 1_000_000 };

/** A synthetic source long enough to cut into 12 chunks. */
const TEXT = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}. ${'Plain filler words sit here. '.repeat(10)}`).join('\n\n');
const CHUNKS = chunkText(TEXT, { size: 1650, overlap: 100 });
const chunkTtl = (sourceId = 'doc1', chunks = CHUNKS) =>
  chunksToTurtle({ sourceId, title: 'A document', sha256: 'ab'.repeat(32), chunks, generatedAt: '2026-10-01T00:00:00.000Z' });

const base = () => toTurtleFull([stmt(1), stmt(2), stmt(3)], [SOURCE]);
/** A space file with folded chunks: claims first, then the chunk section. */
const withChunks = (extra = chunkTtl()) => `${base()}\n# ---- source passages ----\n${extra}`;

describe('importTurtleFull — chunk nodes (F107.10.1)', () => {
  it('fixture sanity: the synthetic text cuts into 12 chunks', () => {
    expect(CHUNKS.length).toBe(12);
  });

  it('3 statements and 12 chunks import as 3 statements and 12 chunks', async () => {
    const r = await importTurtleFull(withChunks());
    expect(r.statements).toHaveLength(3);
    expect(r.chunks).toHaveLength(12);
    expect(r.chunkProblems).toBeUndefined();
    const c = r.chunks[5];
    expect(c.sourceId).toBe('doc1');
    expect(c.index).toBe(5);
    expect(c.text).toBe(CHUNKS[5].text);
    expect([c.start, c.end]).toEqual([CHUNKS[5].start, CHUNKS[5].end]);
    expect(c.generatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('chunks never become claims: statements, sources and cleanImportCount are identical with and without them', async () => {
    const without = await importTurtleFull(base());
    const withC = await importTurtleFull(withChunks());
    expect(withC.statements).toEqual(without.statements);
    expect(withC.sources).toEqual(without.sources);
    expect(withC.cleanImportCount).toBe(without.cleanImportCount);
    for (const st of withC.statements) expect(JSON.stringify(st)).not.toContain('/chunk/');
    expect(without.chunks).toEqual([]);
  });

  it('a file with chunks and no annotated statements does not turn the chunks into plain-Turtle claims', async () => {
    const r = await importTurtleFull(chunkTtl());
    expect(r.chunks).toHaveLength(12);
    expect(r.statements).toHaveLength(0);
    expect(r.cleanImportCount).toBe(0);
  });

  it('plain Turtle beside chunks still imports its own triples, and only those', async () => {
    const plain = `@prefix ex: <http://example.org/> .\nex:a ex:knows ex:b .\n${chunkTtl()}`;
    const r = await importTurtleFull(plain);
    expect(r.cleanImportCount).toBe(1);
    expect(r.statements).toHaveLength(1);
    expect(r.chunks).toHaveLength(12);
  });

  it('a claim that merely mentions a chunk is still a claim (the chunk node is consumed, the mention is not)', async () => {
    const plain = `@prefix ex: <http://example.org/> .\nex:note ex:cites <urn:kbase:source/doc1/chunk/0> .\n${chunkTtl()}`;
    const r = await importTurtleFull(plain);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].s).toEqual(iri('http://example.org/note'));
    expect(r.chunks).toHaveLength(12);
  });

  it('is order independent: chunks before the claims read the same', async () => {
    const a = await importTurtleFull(withChunks());
    const b = await importTurtleFull(`${chunkTtl()}\n${base()}`);
    expect(b.chunks).toEqual(a.chunks);
    expect(b.statements).toEqual(a.statements);
  });

  it('chunks come back in canonical order, source then position, whatever order the file wrote them', async () => {
    const tail = CHUNKS.slice(9, 12).reverse();
    const r = await importTurtleFull(`${chunkTtl('zeta', tail.slice(0, 2))}\n${chunkTtl('alpha', tail)}`);
    expect(r.chunks.map((c) => `${c.sourceId}/${c.index}`)).toEqual(['alpha/9', 'alpha/10', 'alpha/11', 'zeta/10', 'zeta/11']);
  });

  it('keeps awkward text exactly: quotes, backslashes, newlines, triple quotes, unicode', async () => {
    const text = 'He said "hi" and \\o/ then """ended""".\nSecond line\twith tab — ünïcödé 日本語 🙂\r\nend"';
    const r = await importTurtleFull(chunkTtl('doc1', [{ index: 0, start: 0, end: text.length, contextStart: 0, text }]));
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].text).toBe(text);
  });

  it('an empty passage text is a valid chunk, not a problem', async () => {
    const r = await importTurtleFull(chunkTtl('doc1', [{ index: 0, start: 0, end: 0, contextStart: 0, text: '' }]));
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].text).toBe('');
  });

  it('extra predicates on a chunk node are tolerated and the chunk is still read', async () => {
    const extra = chunkTtl().replace('schema:position 0 ;', 'schema:position 0 ; rdf:type prov:Entity ;');
    const r = await importTurtleFull(extra);
    expect(r.chunks).toHaveLength(12);
    expect(r.statements).toHaveLength(0);
  });

  describe('malformed chunk nodes are reported, not thrown', () => {
    const P = '@prefix dcterms: <http://purl.org/dc/terms/> . @prefix schema: <https://schema.org/> . @prefix oa: <http://www.w3.org/ns/oa#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n';
    const S = '<urn:kbase:source/doc1>';
    const C = (n: number) => `<urn:kbase:source/doc1/chunk/${n}>`;
    const SEL = '[ a oa:TextPositionSelector ; oa:start 0 ; oa:end 4 ]';
    const cases: Array<[string, string, string]> = [
      ['no text', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector ${SEL} .`, 'no text'],
      ['only a part-of and a position', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 .`, 'no text'],
      ['no position', `${C(0)} dcterms:isPartOf ${S} ; oa:hasSelector ${SEL} ; rdf:value "abcd" .`, 'no position'],
      ['no selector', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; rdf:value "abcd" .`, 'no text position selector'],
      ['negative position', `${C(0)} dcterms:isPartOf ${S} ; schema:position -1 ; oa:hasSelector ${SEL} ; rdf:value "abcd" .`, 'non-negative integer'],
      ['non-numeric position', `${C(0)} dcterms:isPartOf ${S} ; schema:position "first" ; oa:hasSelector ${SEL} ; rdf:value "abcd" .`, 'non-negative integer'],
      ['selector ends before it starts', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector [ oa:start 9 ; oa:end 4 ] ; rdf:value "abcd" .`, 'ends before'],
      ['negative selector end', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector [ oa:start 0 ; oa:end -1 ] ; rdf:value "abcd" .`, 'start/end'],
      ['selector missing end', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector [ oa:start 0 ] ; rdf:value "abcd" .`, 'start/end'],
      ['two texts', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector ${SEL} ; rdf:value "abcd", "efgh" .`, 'single literal'],
      ['text is an IRI', `${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector ${SEL} ; rdf:value <urn:x:y> .`, 'single literal'],
      ['part of two sources', `${C(0)} dcterms:isPartOf ${S}, <urn:kbase:source/other> ; schema:position 0 ; oa:hasSelector ${SEL} ; rdf:value "abcd" .`, 'more than one source'],
    ];
    for (const [name, ttl, reason] of cases) {
      it(name, async () => {
        const r = await importTurtleFull(`${base()}\n${P}${ttl}`);
        expect(r.chunks).toHaveLength(0);
        expect(r.chunkProblems).toHaveLength(1);
        expect(r.chunkProblems![0].iri).toBe('urn:kbase:source/doc1/chunk/0');
        expect(r.chunkProblems![0].reason).toContain(reason);
        expect(r.statements).toHaveLength(3);
      });
    }

    it('a malformed chunk does not hide the good ones beside it', async () => {
      const bad = `${P}${C(99)} dcterms:isPartOf ${S} ; schema:position 99 .`;
      const r = await importTurtleFull(`${chunkTtl()}\n${bad}`);
      expect(r.chunks).toHaveLength(12);
      expect(r.chunkProblems).toHaveLength(1);
    });

    it('a duplicate position keeps the first and reports the second', async () => {
      const dup = `${P}${C(100)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector [ oa:start 0 ; oa:end 1 ] ; rdf:value "x" .`;
      const r = await importTurtleFull(`${chunkTtl()}\n${dup}`);
      expect(r.chunks).toHaveLength(12);
      expect(r.chunks[0].text).toBe(CHUNKS[0].text);
      expect(r.chunkProblems).toHaveLength(1);
      expect(r.chunkProblems![0].reason).toContain('duplicate');
    });

    it('a malformed chunk does not leak into the plain-Turtle fallback as claims', async () => {
      const r = await importTurtleFull(`${P}${C(0)} dcterms:isPartOf ${S} ; schema:position 0 ; oa:hasSelector ${SEL} .`);
      expect(r.statements).toHaveLength(0);
      expect(r.chunkProblems).toHaveLength(1);
    });
  });

  it('a Turtle syntax error inside a chunk (unterminated literal) still rejects the whole file, as any syntax error does', async () => {
    await expect(importTurtleFull(`${chunkTtl()}\n<urn:x:a> <urn:x:b> """never closed .`)).rejects.toThrow();
  });

  it('a node that is merely part of something (a space in a set) is not mistaken for a chunk', async () => {
    const ttl = `${base()}\n<urn:reckons:kb> <http://purl.org/dc/terms/isPartOf> <urn:reckons:set/one> .`;
    const r = await importTurtleFull(ttl);
    expect(r.chunks).toEqual([]);
    expect(r.chunkProblems).toBeUndefined();
  });

  it('re-exporting the imported statements carries no passage text (a publish path never sees chunks)', async () => {
    const r = await importTurtleFull(withChunks());
    const again = toTurtleFull(r.statements, r.sources);
    expect(again).not.toContain('Paragraph 5.');
    expect(again).not.toContain('/chunk/');
  });
});
