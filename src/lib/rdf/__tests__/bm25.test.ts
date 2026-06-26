import { describe, it, expect } from 'vitest';
import { BM25Index } from '../bm25';
import type { BM25Doc } from '../bm25';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function makeDoc(overrides: Partial<BM25Doc> & Pick<BM25Doc, 'subject' | 'predicate' | 'object'>): BM25Doc {
  return {
    id: `doc-${++_id}`,
    sourceTitle: 'Test Source',
    confidence: 0.9,
    ...overrides,
  };
}

// ── Empty index ───────────────────────────────────────────────────────────────

describe('BM25Index — empty index', () => {
  it('returns empty results for any query', () => {
    const index = new BM25Index([]);
    expect(index.search('anything')).toEqual([]);
  });

  it('returns empty results for an empty query against an empty index', () => {
    const index = new BM25Index([]);
    expect(index.search('')).toEqual([]);
  });
});

// ── Single document ───────────────────────────────────────────────────────────

describe('BM25Index — single document', () => {
  it('matches a doc on its own subject term', () => {
    const doc = makeDoc({ subject: 'coffee', predicate: 'has-property', object: 'caffeine' });
    const index = new BM25Index([doc]);
    const results = index.search('coffee');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(doc.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('matches a doc on its own object term', () => {
    const doc = makeDoc({ subject: 'coffee', predicate: 'has-property', object: 'caffeine' });
    const index = new BM25Index([doc]);
    const results = index.search('caffeine');
    expect(results).toHaveLength(1);
    expect(results[0].doc).toBe(doc);
  });

  it('matches a doc on its own predicate term', () => {
    const doc = makeDoc({ subject: 'alice', predicate: 'knows', object: 'bob' });
    const index = new BM25Index([doc]);
    const results = index.search('knows');
    expect(results).toHaveLength(1);
  });
});

// ── Multiple documents — relevance ordering ───────────────────────────────────

describe('BM25Index — multiple documents', () => {
  it('ranks the most relevant document first', () => {
    const docA = makeDoc({ subject: 'machine learning', predicate: 'is', object: 'a field of ai' });
    const docB = makeDoc({ subject: 'apple', predicate: 'is', object: 'a fruit' });
    const index = new BM25Index([docA, docB]);
    const results = index.search('machine learning');
    expect(results[0].id).toBe(docA.id);
  });

  it('returns the unrelated doc only when it has a matching term', () => {
    const docA = makeDoc({ subject: 'quantum physics', predicate: 'involves', object: 'wave functions' });
    const docB = makeDoc({ subject: 'gardening', predicate: 'requires', object: 'sunlight' });
    const index = new BM25Index([docA, docB]);
    const results = index.search('sunlight');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(docB.id);
  });

  it('returns results in descending score order', () => {
    const docs = [
      makeDoc({ subject: 'neural network', predicate: 'is', object: 'a model' }),
      makeDoc({ subject: 'neural network neural network', predicate: 'neural', object: 'network' }),
      makeDoc({ subject: 'biology', predicate: 'studies', object: 'cells' }),
    ];
    const index = new BM25Index(docs);
    const results = index.search('neural network');
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });
});

// ── No matches ────────────────────────────────────────────────────────────────

describe('BM25Index — no matches', () => {
  it('returns empty array when query has no matching terms', () => {
    const doc = makeDoc({ subject: 'coffee', predicate: 'has', object: 'caffeine' });
    const index = new BM25Index([doc]);
    expect(index.search('zzzzquantumzzzz')).toEqual([]);
  });

  it('returns empty array for a blank query', () => {
    const doc = makeDoc({ subject: 'coffee', predicate: 'has', object: 'caffeine' });
    const index = new BM25Index([doc]);
    // Tokenizer filters tokens shorter than 2 chars, so a single space produces nothing
    expect(index.search('   ')).toEqual([]);
  });
});

// ── Limit parameter ───────────────────────────────────────────────────────────

describe('BM25Index — limit parameter', () => {
  it('caps results to the requested limit', () => {
    const docs = Array.from({ length: 8 }, (_, i) =>
      makeDoc({ subject: `concept${i}`, predicate: 'relates-to', object: 'knowledge' })
    );
    const index = new BM25Index(docs);
    const results = index.search('knowledge', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns all matches when limit exceeds match count', () => {
    const docs = [
      makeDoc({ subject: 'alpha', predicate: 'is', object: 'first' }),
      makeDoc({ subject: 'beta', predicate: 'is', object: 'second' }),
    ];
    const index = new BM25Index(docs);
    // Only one doc matches "alpha"
    const results = index.search('alpha', 100);
    expect(results).toHaveLength(1);
  });

  it('default limit is 10', () => {
    const docs = Array.from({ length: 15 }, (_, i) =>
      makeDoc({ subject: `item${i}`, predicate: 'has', object: 'keyword' })
    );
    const index = new BM25Index(docs);
    // All 15 docs match "keyword" but default limit is 10
    const results = index.search('keyword');
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

// ── Case insensitivity ────────────────────────────────────────────────────────

describe('BM25Index — case insensitivity', () => {
  it('matches regardless of query case', () => {
    const doc = makeDoc({ subject: 'JavaScript', predicate: 'is', object: 'a programming language' });
    const index = new BM25Index([doc]);
    expect(index.search('javascript')).toHaveLength(1);
    expect(index.search('JAVASCRIPT')).toHaveLength(1);
    expect(index.search('JavaScript')).toHaveLength(1);
  });

  it('matches regardless of doc content case', () => {
    const doc = makeDoc({ subject: 'PYTHON', predicate: 'IS', object: 'DYNAMIC' });
    const index = new BM25Index([doc]);
    expect(index.search('python')).toHaveLength(1);
    expect(index.search('dynamic')).toHaveLength(1);
  });
});

// ── Tokenization — spaces split terms ────────────────────────────────────────

describe('BM25Index — tokenization on spaces', () => {
  it('finds a doc via a single word from a multi-word subject', () => {
    const doc = makeDoc({ subject: 'knowledge graph database', predicate: 'stores', object: 'triples' });
    const index = new BM25Index([doc]);
    expect(index.search('graph')).toHaveLength(1);
    expect(index.search('database')).toHaveLength(1);
    expect(index.search('knowledge')).toHaveLength(1);
  });

  it('single-character tokens are filtered out by tokenizer', () => {
    // tokenizer filters tokens with length <= 1
    const doc = makeDoc({ subject: 'a b c', predicate: 'x', object: 'y' });
    const index = new BM25Index([doc]);
    // All terms are length 1 (filtered), so nothing matches
    expect(index.search('a')).toHaveLength(0);
    expect(index.search('b')).toHaveLength(0);
  });
});

// ── Special character stripping ───────────────────────────────────────────────

describe('BM25Index — special character stripping', () => {
  it('strips punctuation from query before matching', () => {
    const doc = makeDoc({ subject: 'climate change', predicate: 'causes', object: 'flooding' });
    const index = new BM25Index([doc]);
    // Punctuation in query is stripped: "climate!" → "climate"
    expect(index.search('climate!')).toHaveLength(1);
    expect(index.search('change?')).toHaveLength(1);
  });

  it('strips punctuation from doc content during indexing', () => {
    const doc = makeDoc({ subject: 'C++', predicate: 'is', object: 'a systems language' });
    const index = new BM25Index([doc]);
    // "C++" is tokenized to "c" (length 1, filtered) — no match for "c" but "systems" matches
    expect(index.search('systems')).toHaveLength(1);
  });

  it('allows hyphens and underscores through tokenizer', () => {
    // tokenizer replaces [^a-z0-9\s\-_] — hyphens/underscores survive
    const doc = makeDoc({ subject: 'well-known', predicate: 'has', object: 'snake_case' });
    const index = new BM25Index([doc]);
    expect(index.search('well-known')).toHaveLength(1);
    expect(index.search('snake_case')).toHaveLength(1);
  });
});

// ── Score ordering — term frequency effect ────────────────────────────────────

describe('BM25Index — score ordering', () => {
  it('doc with more occurrences of query term scores higher', () => {
    const docFew = makeDoc({
      subject: 'knowledge',
      predicate: 'is',
      object: 'information',
    });
    const docMany = makeDoc({
      subject: 'knowledge knowledge',
      predicate: 'knowledge',
      object: 'knowledge base',
    });
    const index = new BM25Index([docFew, docMany]);
    const results = index.search('knowledge');
    expect(results[0].id).toBe(docMany.id);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('doc whose rare term matches outscores doc with common term', () => {
    // "rare" only appears in docA; "common" appears in all docs → lower IDF
    const docA = makeDoc({ subject: 'rare-term', predicate: 'is', object: 'common' });
    const docB = makeDoc({ subject: 'other', predicate: 'is', object: 'common' });
    const docC = makeDoc({ subject: 'another', predicate: 'has', object: 'common' });
    const index = new BM25Index([docA, docB, docC]);
    // Searching "rare-term" — only docA matches; searching "common" all three match
    const rareResults = index.search('rare-term');
    expect(rareResults).toHaveLength(1);
    expect(rareResults[0].id).toBe(docA.id);
  });
});

// ── Source title included in search text ─────────────────────────────────────

describe('BM25Index — sourceTitle in search', () => {
  it('matches a term that appears only in the sourceTitle', () => {
    const doc = makeDoc({
      subject: 'quantum entanglement',
      predicate: 'is',
      object: 'a phenomenon',
      sourceTitle: 'Physics Weekly',
    });
    const index = new BM25Index([doc]);
    // "weekly" appears only in sourceTitle
    const results = index.search('weekly');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(doc.id);
  });

  it('doc with matching sourceTitle scores alongside content matches', () => {
    const docWithTitle = makeDoc({
      subject: 'biology',
      predicate: 'studies',
      object: 'organisms',
      sourceTitle: 'Science Journal',
    });
    const docNoTitle = makeDoc({
      subject: 'chemistry',
      predicate: 'studies',
      object: 'reactions',
      sourceTitle: undefined,
    });
    const index = new BM25Index([docWithTitle, docNoTitle]);
    // "journal" only in docWithTitle's sourceTitle
    const results = index.search('journal');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(docWithTitle.id);
  });

  it('doc with undefined sourceTitle still matches on other fields', () => {
    const doc = makeDoc({
      subject: 'linguistics',
      predicate: 'studies',
      object: 'language',
      sourceTitle: undefined,
    });
    const index = new BM25Index([doc]);
    expect(index.search('linguistics')).toHaveLength(1);
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe('BM25Index — result shape', () => {
  it('result contains id, score, and doc reference', () => {
    const doc = makeDoc({ subject: 'test subject', predicate: 'has', object: 'test object' });
    const index = new BM25Index([doc]);
    const results = index.search('test');
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result).toHaveProperty('id', doc.id);
    expect(result).toHaveProperty('score');
    expect(typeof result.score).toBe('number');
    expect(result).toHaveProperty('doc');
    expect(result.doc).toBe(doc);
  });
});
