/**
 * F122.1.2 — the anchor survives copy and import. A fact with an anchor round-trips; an old file
 * with none imports unchanged; an incomplete one is reported and never becomes a claim; and the
 * script-tier check finds anchors whose chunk is not in the file.
 */
import { describe, it, expect } from 'vitest';
import { importTurtleFull } from '../import-ttl';
import { toTurtleFull } from '../serialize';
import { iri, lit, type Source, type Statement } from '../types';
import { chunkIri, chunkText, corporaFromImported, attachAnchors } from '../../ingest/source-chunks';
import { unresolvedAnchors } from '../../ingest/anchor-resolution';

const HASH = 'cd'.repeat(32);
const TEXT = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. The harbor handled grain and timber. ${'Filler words sit here. '.repeat(10)}`).join('\n\n');
const SOURCE: Source = { id: 'doc1', title: 'Harbor', uri: 'file://h', kind: 'document', ingestedAt: 1, hash: HASH } as Source;
const stmt = (i: number, excerpt: string): Statement => ({
  id: `s${i}`, s: iri(`urn:kbase:concept/e${i}`), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit(`Entity ${i}`),
  g: iri('urn:kbase:source/doc1'), sourceId: 'doc1', confidence: 0.9, status: 'confirmed', createdAt: 1, updatedAt: 1, excerpt, grounded: true,
});
const anchored = () => attachAnchors([stmt(1, 'Paragraph 30. The harbor'), stmt(2, 'Paragraph 3. The harbor'), { ...stmt(3, 'x'), excerpt: undefined, grounded: undefined }], SOURCE, TEXT);
const corpora = () => [{ sourceId: 'doc1', sha256: HASH, generatedAt: '2026-10-01T00:00:00.000Z', chunks: chunkText(TEXT) }];
const stable = (t: string) => t.replace(/^# generated .*\n/m, '');
const P = '@prefix oa: <http://www.w3.org/ns/oa#> . @prefix dcterms: <http://purl.org/dc/terms/> .\n';

describe('anchor round trip (F122.1.2)', () => {
  it('fixture sanity: two facts are anchored and one is not', () => {
    expect(anchored().map((s) => !!s.anchor)).toEqual([true, true, false]);
  });

  it('a fact with an anchor round-trips exactly', async () => {
    const facts = anchored();
    const r = await importTurtleFull(toTurtleFull(facts, [SOURCE], { chunks: corpora() }));
    expect(r.anchorProblems).toBeUndefined();
    expect(r.statements.find((s) => s.id === 's1')!.anchor).toEqual(facts[0].anchor);
    expect(r.statements.find((s) => s.id === 's2')!.anchor).toEqual(facts[1].anchor);
    expect(r.statements.find((s) => s.id === 's3')!.anchor).toBeUndefined();
    expect(r.statements.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('export, import, export is a fixed point with anchors and chunks together', async () => {
    const first = stable(toTurtleFull(anchored(), [SOURCE], { chunks: corpora() }));
    const r = await importTurtleFull(first);
    const second = stable(toTurtleFull(r.statements, r.sources, { chunks: corporaFromImported(r.chunks, r.chunkVersions) }));
    expect(second).toBe(first);
  });

  it('the anchor joins fact and passage inside the one file: its chunk is a chunk node of the same file', async () => {
    const r = await importTurtleFull(toTurtleFull(anchored(), [SOURCE], { chunks: corpora() }));
    expect(unresolvedAnchors(r.statements, r.chunks)).toEqual([]);
    const c = r.chunks.find((k) => k.iri === r.statements[0].anchor!.chunk)!;
    expect(r.statements[0].anchor!.start).toBeGreaterThanOrEqual(c.start);
  });

  it('an old file with no anchors imports unchanged, and anchors never become claims', async () => {
    const old = await importTurtleFull(toTurtleFull([stmt(1, 'q'), stmt(2, 'q')], [SOURCE]));
    expect(old.statements.every((s) => s.anchor === undefined)).toBe(true);
    const withA = await importTurtleFull(toTurtleFull(anchored(), [SOURCE], { chunks: corpora() }));
    expect(withA.statements).toHaveLength(3);
    expect(JSON.stringify(withA.statements)).not.toContain('TextPositionSelector');
  });

  it('a file with anchors and NO chunk section still imports the anchors (they just do not resolve)', async () => {
    const r = await importTurtleFull(toTurtleFull(anchored(), [SOURCE]));
    expect(r.statements.filter((s) => s.anchor)).toHaveLength(2);
    expect(unresolvedAnchors(r.statements, r.chunks).map((p) => p.reason)).toEqual(['no-such-chunk', 'no-such-chunk']);
  });

  it('a fallback (non-SHA-256) hash survives, marked as unverified, and reads back identical', async () => {
    const facts = attachAnchors([stmt(1, 'Paragraph 3. The harbor')], { id: 'doc1', hash: 'deadbeef' }, TEXT);
    const ttl = toTurtleFull(facts, [SOURCE]);
    expect(ttl).toContain('unverified:deadbeef');
    expect((await importTurtleFull(ttl)).statements[0].anchor!.sourceHash).toBe('deadbeef');
  });

  describe('malformed anchors are reported and the fact still imports', () => {
    const fact = (target: string) => `${P}${toTurtleFull([stmt(1, 'q')], [SOURCE]).replace(/(meta:status "confirmed" ;)/, `$1\n    oa:hasTarget ${target} ;`)}`;
    const CH = `<${chunkIri('doc1', 0)}>`;
    const SEL = '[ a oa:TextPositionSelector ; oa:start 10 ; oa:end 20 ]';
    const cases: Array<[string, string, string]> = [
      ['no version', `[ oa:hasSource ${CH} ; oa:hasSelector ${SEL} ]`, 'version'],
      ['no chunk', `[ oa:hasSelector ${SEL} ; dcterms:hasVersion "sha256:${HASH}" ]`, 'chunk IRI'],
      ['no selector', `[ oa:hasSource ${CH} ; dcterms:hasVersion "sha256:${HASH}" ]`, 'selector'],
      ['start after end', `[ oa:hasSource ${CH} ; oa:hasSelector [ oa:start 30 ; oa:end 20 ] ; dcterms:hasVersion "sha256:${HASH}" ]`, 'ends at or before'],
      ['empty span', `[ oa:hasSource ${CH} ; oa:hasSelector [ oa:start 20 ; oa:end 20 ] ; dcterms:hasVersion "sha256:${HASH}" ]`, 'ends at or before'],
      ['negative start', `[ oa:hasSource ${CH} ; oa:hasSelector [ oa:start -5 ; oa:end 20 ] ; dcterms:hasVersion "sha256:${HASH}" ]`, 'integers'],
      ['text offset', `[ oa:hasSource ${CH} ; oa:hasSelector [ oa:start "abc" ; oa:end 20 ] ; dcterms:hasVersion "sha256:${HASH}" ]`, 'integers'],
      ['not a node', `<urn:x:y>`, 'not a node'],
    ];
    for (const [name, target, reason] of cases) {
      it(name, async () => {
        const r = await importTurtleFull(fact(target));
        expect(r.statements).toHaveLength(1);
        expect(r.statements[0].anchor).toBeUndefined();
        expect(r.anchorProblems).toHaveLength(1);
        expect(r.anchorProblems![0].reason).toContain(reason);
      });
    }
    it('the same anchor written twice is one anchor; two different ones keep the first and are reported', async () => {
      const good = `[ oa:hasSource ${CH} ; oa:hasSelector ${SEL} ; dcterms:hasVersion "sha256:${HASH}" ]`;
      const twice = await importTurtleFull(fact(`${good}, ${good}`));
      expect(twice.statements[0].anchor).toEqual({ chunk: chunkIri('doc1', 0), start: 10, end: 20, sourceHash: HASH });
      expect(twice.anchorProblems).toBeUndefined();
      const other = `[ oa:hasSource ${CH} ; oa:hasSelector [ oa:start 11 ; oa:end 20 ] ; dcterms:hasVersion "sha256:${HASH}" ]`;
      const differ = await importTurtleFull(fact(`${good}, ${other}`));
      expect(differ.statements[0].anchor!.start).toBe(10);
      expect(differ.anchorProblems).toHaveLength(1);
    });
    it('anchor triples never leak into the plain-Turtle fallback as claims', async () => {
      const r = await importTurtleFull(`${P}<urn:x:thing> oa:hasTarget [ oa:hasSource ${CH} ] .`);
      // No annotated fact: the fallback runs, and it sees the stray triples exactly as it always did.
      expect(r.statements.every((s) => s.p.value !== 'http://www.w3.org/ns/oa#hasSource' || s.s.kind !== 'iri' || !s.s.value.startsWith('urn:kbase:stmt/'))).toBe(true);
    });
  });

  describe('unresolvedAnchors', () => {
    const chunk = { iri: chunkIri('doc1', 0), sourceId: 'doc1', start: 0, end: 100 };
    const fact = (anchor: Statement['anchor'], sourceId = 'doc1') => ({ id: 'f', sourceId, anchor });
    it('passes a resolving anchor and ignores facts without one', () => {
      expect(unresolvedAnchors([fact({ chunk: chunk.iri, start: 10, end: 20, sourceHash: 'h' }), fact(undefined)], [chunk])).toEqual([]);
    });
    it('names a missing chunk, a chunk of another document, and a start outside the chunk', () => {
      const r = unresolvedAnchors([
        fact({ chunk: chunkIri('doc1', 9), start: 1, end: 2, sourceHash: 'h' }),
        fact({ chunk: chunk.iri, start: 1, end: 2, sourceHash: 'h' }, 'doc2'),
        fact({ chunk: chunk.iri, start: 100, end: 120, sourceHash: 'h' }),
      ], [chunk]);
      expect(r.map((p) => p.reason)).toEqual(['no-such-chunk', 'other-source', 'start-outside-chunk']);
    });
  });
});
