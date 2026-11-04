/**
 * The anchor-resolution script (F122.1.2): a space file whose anchors all resolve passes; one that
 * cites a chunk it does not carry fails with the statement and chunk named. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toTurtleFull } from '../../../src/lib/rdf/serialize';
import { iri, lit, type Source, type Statement } from '../../../src/lib/rdf/types';
import { attachAnchors, chunkText } from '../../../src/lib/ingest/source-chunks';

const HASH = 'ef'.repeat(32);
const TEXT = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. The harbor handled grain. ${'Filler words. '.repeat(20)}`).join('\n\n');
const SOURCE = { id: 'doc1', title: 'T', uri: 'file://t', kind: 'document', ingestedAt: 1, hash: HASH } as Source;
const facts = attachAnchors([{
  id: 's1', s: iri('urn:kbase:concept/a'), p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('A'),
  g: iri('urn:kbase:source/doc1'), sourceId: 'doc1', confidence: 1, status: 'confirmed', createdAt: 1, updatedAt: 1,
  excerpt: 'Paragraph 20. The harbor', grounded: true,
} as Statement], SOURCE, TEXT);

function run(ttl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-res-'));
  try {
    const file = join(dir, 'space.ttl');
    writeFileSync(file, ttl);
    const script = resolve(__dirname, '../anchor-resolution.ts');
    return spawnSync('npx', ['tsx', script, file], { encoding: 'utf8', cwd: resolve(__dirname, '../../..') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('anchor-resolution script', () => {
  it('passes a file whose anchor resolves to a chunk it carries', () => {
    const r = run(toTurtleFull(facts, [SOURCE], { chunks: [{ sourceId: 'doc1', sha256: HASH, generatedAt: '2026-10-01T00:00:00.000Z', chunks: chunkText(TEXT) }] }));
    expect(r.stdout).toContain('1 anchor(s) found, 0 problem(s)');
    expect(r.status).toBe(0);
  }, 60_000);

  it('fails, naming statement and chunk, when the file does not carry the chunk', () => {
    const r = run(toTurtleFull(facts, [SOURCE]));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ s1 -> urn:kbase:source\/doc1\/chunk\/\d+ \(no-such-chunk\)/);
  }, 60_000);
});
