/**
 * ALIAS EXPANSION IN kb_search — the vocabulary half of F104.
 *
 * The coverage half was fixed by symlinking every graph into the MCP workspace. What remained
 * was measured on 2026-07-19: "BM25 indexes subjectSlug + predicateSlug + object with no
 * expansion, so a synonym gap is fatal". These tests pin the fix and, as importantly, pin the
 * ATTRIBUTION — kb:node-synonyms holds that unexplained recall is worse than silence because
 * it looks like it worked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { bm25Search, buildAliasIndex, invalidateCache } from '../search.js';
import type { Triple } from '../kb-reader.js';

const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const t = (subject: string, predicate: string, object: string, objectIsLiteral = true): Triple => ({
  subject,
  predicate,
  object,
  objectIsLiteral,
});

const GRAPH = 'urn:kbase:concept/knowledge-graph';

// Every search below runs against a freshly built index: the module caches tokenization by
// array identity AND expansion mode, and a stale cache would make these tests lie.
beforeEach(() => invalidateCache());

describe('buildAliasIndex', () => {
  it('collects altLabel values per subject', () => {
    const index = buildAliasIndex([
      t(GRAPH, SKOS_ALT_LABEL, 'knowledge base'),
      t(GRAPH, SKOS_ALT_LABEL, 'KB'),
      t(GRAPH, RDFS_LABEL, 'Knowledge Graph'),
    ]);
    expect(index.get(GRAPH)).toEqual(['knowledge base', 'KB']);
  });

  it('deduplicates case-insensitively', () => {
    const index = buildAliasIndex([
      t(GRAPH, SKOS_ALT_LABEL, 'KB'),
      t(GRAPH, SKOS_ALT_LABEL, 'kb'),
    ]);
    expect(index.get(GRAPH)).toEqual(['KB']);
  });

  it('ignores an altLabel whose object is an IRI', () => {
    // Malformed SKOS. Indexing the IRI would inject slug noise into every triple of the entity.
    const index = buildAliasIndex([
      t(GRAPH, SKOS_ALT_LABEL, 'urn:kbase:concept/other', false),
    ]);
    expect(index.has(GRAPH)).toBe(false);
  });

  it('ignores blank alias values', () => {
    expect(buildAliasIndex([t(GRAPH, SKOS_ALT_LABEL, '   ')]).has(GRAPH)).toBe(false);
  });
});

describe('bm25Search with alias expansion', () => {
  const corpus = (): Triple[] => [
    t(GRAPH, RDFS_LABEL, 'Knowledge Graph'),
    t(GRAPH, SKOS_ALT_LABEL, 'knowledge base'),
    t(GRAPH, 'urn:kbase:predicate/has-status', 'production'),
    t('urn:kbase:concept/octopus', RDFS_LABEL, 'Octopus'),
    t('urn:kbase:concept/octopus', 'urn:kbase:predicate/has-arms', 'eight'),
  ];

  it('reaches an entity facts through a name it is not labelled with', () => {
    const hits = bm25Search(corpus(), 'knowledge base status', 10);
    const statusHit = hits.find((h) => h.triple.predicate.endsWith('has-status'));
    expect(statusHit).toBeDefined();
    expect(statusHit!.matchedAliases).toEqual(['knowledge base']);
  });

  it('finds nothing for that query with expansion off — the control arm', () => {
    invalidateCache();
    const hits = bm25Search(corpus(), 'knowledge base status', 10, { expandAliases: false });
    const statusHit = hits.find((h) => h.triple.predicate.endsWith('has-status'));
    // Without the thesaurus the has-status triple is reachable only by "status", never by the
    // name the user actually typed for the entity.
    expect(statusHit?.matchedAliases).toBeUndefined();
    expect(hits.every((h) => h.matchedAliases === undefined)).toBe(true);
  });

  it('does not attribute an alias when the row matched on its own text', () => {
    const hits = bm25Search(corpus(), 'octopus arms', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matchedAliases === undefined)).toBe(true);
  });

  it('does not credit an alias for a token the triple already carried', () => {
    const hits = bm25Search(corpus(), 'knowledge', 10);
    const labelHit = hits.find((h) => h.triple.predicate === RDFS_LABEL);
    // "knowledge" is in the subject slug and in the alias; the alias did not earn this row.
    expect(labelHit?.matchedAliases).toBeUndefined();
  });

  it('returns identical rankings to the unexpanded index when nothing has an alias', () => {
    const plain = [
      t('urn:kbase:concept/octopus', 'urn:kbase:predicate/has-arms', 'eight'),
      t('urn:kbase:concept/squid', 'urn:kbase:predicate/has-arms', 'ten'),
    ];
    invalidateCache();
    const on = bm25Search(plain, 'arms', 10).map((r) => r.triple.subject);
    invalidateCache();
    const off = bm25Search(plain, 'arms', 10, { expandAliases: false }).map((r) => r.triple.subject);
    expect(on).toEqual(off);
  });

  it('does not serve an expanded index to a caller that asked for the plain one', () => {
    // The cache is keyed by array identity; before expandAliases joined the key, the second
    // call here silently reused the first call's tokens and reported the wrong arm.
    const c = corpus();
    const expanded = bm25Search(c, 'knowledge base status', 10, { expandAliases: true });
    const plain = bm25Search(c, 'knowledge base status', 10, { expandAliases: false });
    expect(expanded.some((h) => h.matchedAliases)).toBe(true);
    expect(plain.every((h) => h.matchedAliases === undefined)).toBe(true);
  });

  it('ranks a direct hit above a row reached only through an alias', () => {
    // WHY ALIAS TOKENS ARE DISCOUNTED (ALIAS_TERM_WEIGHT). Plain BM25 got this backwards:
    // its length normalisation ranked the SHORT `mentions` triple — which matches only
    // because expansion put "knowledge base" on it — ABOVE the entity actually named that,
    // because the short document looked denser. Recall is not worth inverting the ranking.
    const c: Triple[] = [
      t('urn:kbase:concept/other', 'urn:kbase:predicate/mentions', 'x'),
      t('urn:kbase:concept/other', SKOS_ALT_LABEL, 'knowledge base'),
      t('urn:kbase:concept/knowledge-base', RDFS_LABEL, 'knowledge base'),
    ];
    const hits = bm25Search(c, 'knowledge base', 10);

    const direct = hits.findIndex((h) => h.triple.subject === 'urn:kbase:concept/knowledge-base');
    const viaAlias = hits.findIndex((h) => h.triple.predicate.endsWith('mentions'));
    expect(direct).toBeGreaterThanOrEqual(0);
    expect(viaAlias).toBeGreaterThan(direct);
    expect(hits[viaAlias].matchedAliases).toEqual(['knowledge base']);
    // The altLabel record itself is NOT an alias hit — its object states the queried text, so
    // it matches directly and ties with the labelled entity. Attribution says so.
    const record = hits.find((h) => h.triple.predicate === SKOS_ALT_LABEL);
    expect(record?.matchedAliases).toBeUndefined();
  });

  it('weights alias evidence below primary text, and the weight is adjustable', () => {
    const c: Triple[] = [
      t('urn:kbase:concept/other', 'urn:kbase:predicate/mentions', 'x'),
      t('urn:kbase:concept/other', SKOS_ALT_LABEL, 'knowledge base'),
    ];
    invalidateCache();
    const heavy = bm25Search(c, 'knowledge base', 10, { aliasWeight: 1 });
    invalidateCache();
    const light = bm25Search(c, 'knowledge base', 10, { aliasWeight: 0.2 });

    const scoreOf = (rs: typeof heavy) =>
      rs.find((h) => h.triple.predicate.endsWith('mentions'))!.score;
    expect(scoreOf(light)).toBeLessThan(scoreOf(heavy));
  });
});
