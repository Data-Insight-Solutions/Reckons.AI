/**
 * Graph grounding — offline agents query the graph (has-file ownership + purpose) before judging.
 * The lookups take injectable quads so they test without touching static/*.ttl.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { ownerOfFile, groundFile, FILE_PREDS } from '../graph-grounding';

const TTL = `
@prefix kb:    <urn:kbase:concept/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .

kb:merge-band a ktype:Feature ;
  rdfs:label "Merge band" ;
  kpred:has-status "scaffolded" ;
  kpred:description "One confidence rule for merge, link and predicate-sameness." ;
  kpred:has-file "src/lib/rdf/merge-band.ts" ;
  kpred:tested-by "src/lib/rdf/__tests__/merge-band.test.ts" .
`;
const quads = new Parser().parse(TTL);

describe('ownerOfFile', () => {
  it('finds the entity that declares a file via has-file, with its purpose and status', () => {
    const o = ownerOfFile('src/lib/rdf/merge-band.ts', quads);
    expect(o?.label).toBe('Merge band');
    expect(o?.status).toBe('scaffolded');
    expect(o?.via).toBe('has-file');
    expect(o?.description).toMatch(/confidence rule/);
  });

  it('also matches via tested-by', () => {
    expect(ownerOfFile('src/lib/rdf/__tests__/merge-band.test.ts', quads)?.via).toBe('tested-by');
  });

  it('matches a repo-relative path passed with a ./ prefix', () => {
    expect(ownerOfFile('./src/lib/rdf/merge-band.ts', quads)?.label).toBe('Merge band');
  });

  it('returns null for a file the graph knows nothing about', () => {
    expect(ownerOfFile('src/lib/rdf/nonexistent.ts', quads)).toBeNull();
  });
});

describe('groundFile', () => {
  it('produces a compact grounding block naming the owner, status and purpose', () => {
    const g = groundFile('src/lib/rdf/merge-band.ts', quads);
    expect(g).toContain('Merge band');
    expect(g).toContain('scaffolded');
    expect(g).toContain('what it is for');
  });

  it('is empty (harmless) when the graph knows nothing about the file', () => {
    expect(groundFile('src/lib/rdf/nonexistent.ts', quads)).toBe('');
  });
});

describe('FILE_PREDS', () => {
  it('covers has-file and tested-by', () => {
    expect(FILE_PREDS.some((p) => p.endsWith('has-file'))).toBe(true);
    expect(FILE_PREDS.some((p) => p.endsWith('tested-by'))).toBe(true);
  });
});
