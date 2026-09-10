import { describe, it, expect } from 'vitest';
import { BM25Index, type BM25Doc } from '../bm25';

/**
 * The vocabulary half of F104, on the app-side index. The measured failure it fixes: a fact
 * recorded under one name is unreachable by every other name the entity answers to, and BM25
 * returns nothing — which reads exactly like the fact not existing.
 */

let n = 0;
const doc = (subject: string, predicate: string, object: string, aliases?: string[]): BM25Doc => ({
  id: `d${++n}`,
  subject,
  predicate,
  object,
  ...(aliases ? { aliases } : {}),
});

describe('BM25 alias expansion', () => {
  it('finds a fact by a name the subject answers to but is not labelled with', () => {
    const withAlias = new BM25Index([
      doc('Ava Growers Market', 'sells', 'heirloom tomatoes', ['Ava Farmers Market']),
    ]);
    const without = new BM25Index([doc('Ava Growers Market', 'sells', 'heirloom tomatoes')]);

    expect(withAlias.search('Ava Farmers Market')).toHaveLength(1);
    // The control: the same query against the same fact, with no thesaurus, finds nothing.
    expect(without.search('farmers')).toHaveLength(0);
  });

  it('reaches the entity OTHER facts through the alias, not just the alias itself', () => {
    // The reason expansion is applied per-document rather than per-query: searching an alias
    // has to surface what the entity DOES, not merely prove the alias exists.
    const index = new BM25Index([
      doc('Ava Growers Market', 'sells', 'heirloom tomatoes', ['Ava Farmers Market']),
      doc('Ava Growers Market', 'opens', 'Saturday', ['Ava Farmers Market']),
    ]);

    const hits = index.search('Ava Farmers Market');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.doc.predicate).sort()).toEqual(['opens', 'sells']);
  });

  it('reports WHICH alias earned the row', () => {
    const index = new BM25Index([
      doc('Ava Growers Market', 'sells', 'tomatoes', ['Ava Farmers Market', 'The Saturday Market']),
    ]);

    expect(index.search('farmers')[0].matchedAliases).toEqual(['Ava Farmers Market']);
  });

  it('leaves attribution absent when the row matched on its own text', () => {
    // kb:node-synonyms: a caller must be able to tell recall that needed the thesaurus from
    // recall that did not. An always-populated field would answer neither question.
    const index = new BM25Index([
      doc('Ava Growers Market', 'sells', 'tomatoes', ['Ava Farmers Market']),
    ]);

    expect(index.search('tomatoes')[0].matchedAliases).toBeUndefined();
  });

  it('does not credit an alias for a token the document already had', () => {
    const index = new BM25Index([
      doc('Ava Growers Market', 'sells', 'tomatoes', ['Ava Farmers Market']),
    ]);

    // "ava" is in the subject and in the alias; the alias did not earn this row.
    expect(index.search('ava')[0].matchedAliases).toBeUndefined();
  });

  it('names every alias that contributed when a query spans two of them', () => {
    const index = new BM25Index([
      doc('Ava Growers Market', 'sells', 'tomatoes', ['Farmers Market', 'Saturday Bazaar']),
    ]);

    expect(index.search('farmers bazaar')[0].matchedAliases).toEqual([
      'Farmers Market',
      'Saturday Bazaar',
    ]);
  });

  it('behaves exactly as before for documents with no aliases', () => {
    const plain = [doc('Octopus', 'has-arms', 'eight'), doc('Squid', 'has-arms', 'ten')];
    const before = new BM25Index(plain).search('arms');
    const after = new BM25Index(plain.map((d) => ({ ...d, aliases: [] }))).search('arms');

    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.matchedAliases === undefined)).toBe(true);
  });

  it('still ranks a direct hit above one reached only through an alias', () => {
    // The precision side of the trade. Expansion must widen the net, not reorder the catch.
    const index = new BM25Index([
      doc('Riverside Market', 'sells', 'bread', ['Ava Farmers Market']),
      doc('Ava Farmers Market', 'sells', 'bread'),
    ]);

    const hits = index.search('Ava Farmers Market');
    expect(hits[0].doc.subject).toBe('Ava Farmers Market');
    expect(hits[0].matchedAliases).toBeUndefined();
  });
});
