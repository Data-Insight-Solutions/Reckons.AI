/**
 * Search weighting — the guard on what sets cost search.
 *
 * This is the LIVE path: every kb_search, kb_check_plan, kb_reckoning and kb_compress call ranks
 * through bm25Search. The weighting it tests was added after measurement, not before: over the
 * 17,098-quad corpus (scripts/offline/set-complexity.ts), membership rows appeared in the top 10
 * of 11 of 25 member-name queries and displaced a real fact in 5 of them.
 *
 * Duplicated from the app's src/lib/rdf/__tests__/bm25.test.ts on purpose — the two search
 * implementations are deliberately separate so the server pulls nothing from the browser bundle,
 * and two implementations with one test is how one of them quietly stops agreeing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { bm25Search, invalidateCache, structuralWeight } from '../search.js';
import type { Triple } from '../kb-reader.js';

const t = (subject: string, predicate: string, object: string): Triple =>
  ({ subject, predicate, object, objectIsLiteral: false });

const SKOS_MEMBER = 'http://www.w3.org/2004/02/skos/core#member';

describe('bm25Search — structural weighting', () => {
  // The module caches tokenization by array identity; a stale cache across cases would make one
  // test's corpus answer another test's query.
  beforeEach(() => invalidateCache());

  it('a membership row does not outrank a real fact about the same entity', () => {
    const triples = [
      t('urn:kbase:concept/shortlist', SKOS_MEMBER, 'urn:kbase:concept/aprimo'),
      t('urn:kbase:concept/aprimo', 'urn:kbase:predicate/is-a', 'dam-vendor'),
    ];
    const [top] = bm25Search(triples, 'aprimo', 10);
    expect(top.triple.predicate).toBe('urn:kbase:predicate/is-a');
  });

  it('order machinery ranks below membership, which ranks below a fact', () => {
    expect(structuralWeight('urn:kbase:predicate/member-order'))
      .toBeLessThan(structuralWeight(SKOS_MEMBER));
    expect(structuralWeight(SKOS_MEMBER)).toBeLessThan(1);
    expect(structuralWeight('urn:kbase:predicate/is-a')).toBe(1);
  });

  it('weights both spellings of membership identically', () => {
    expect(structuralWeight('urn:kbase:predicate/has-member')).toBe(structuralWeight(SKOS_MEMBER));
  });

  it('still FINDS a membership row when it is the only match', () => {
    const triples = [t('urn:kbase:concept/shortlist', SKOS_MEMBER, 'urn:kbase:concept/aprimo')];
    expect(bm25Search(triples, 'aprimo', 10)).toHaveLength(1);
  });
});
