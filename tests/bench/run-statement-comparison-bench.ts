import { BM25Index } from '../../src/lib/rdf/bm25.js';
import { aggregateStatements, aggregateStatementChunks, statementClaimKey } from '../../src/lib/rdf/statement-chunks.js';
import { researchFixture } from '../../scripts/starter/research-fixture.js';
export function statementComparisonBenchmark() {
  const documents = researchFixture(), spaces = documents.map(d => ({ id: d.corpus, name: d.corpus, statements: d.claims }));
  const raw = documents.flatMap(d => {
    const chunks: { id: string; text: string; keys: string[] }[] = [];
    for (let i = 0; i < d.text.length; i += 500) { const text = d.text.slice(i, i + 500); chunks.push({ id: `${d.id}:${i}`, text, keys: d.claims.filter(s => text.includes(s.excerpt!)).map(statementClaimKey) }); } return chunks;
  });
  const aggregated = aggregateStatementChunks(spaces, 600).map(c => ({ id: c.id, text: c.text, keys: c.claims.map(k => k.key) }));
  const queries = [ ['aster v1 throughput', 'aster-v1', 'throughput', true], ['aster v1 license', 'aster-v1', 'license', true], ['aster v1 supported language', 'aster-v1', 'supported-language', false], ['aster v2 throughput', 'aster-v2', 'throughput', false] ] as const;
  const results = Object.entries({ raw, aggregated }).map(([arm, chunks]) => {
    const index = new BM25Index(chunks.map(c => ({ id: c.id, subject: '', predicate: '', object: c.text })));
    let found = 0, expected = 0, conflicts = 0, characters = 0;
    for (const [query, subject, predicate, conflict] of queries) {
      const gold = [...new Set(documents.flatMap(d => d.claims).filter(s => s.s.value.endsWith('/' + subject) && s.p.value.endsWith('/' + predicate)).map(statementClaimKey))];
      let budget = 1400; const keys = new Set<string>();
      for (const hit of index.search(query, 3)) { const c = chunks.find(c => c.id === hit.id)!; if (c.text.length > budget) continue; budget -= c.text.length; characters += c.text.length; c.keys.forEach(k => keys.add(k)); }
      found += gold.filter(k => keys.has(k)).length; expected += gold.length; if (conflict && gold.every(k => keys.has(k))) conflicts++;
    }
    return { arm, chunks: chunks.length, claimRecall: found / expected, conflictPairsRetrieved: conflicts, conflictPairsExpected: 2, retrievedCharacters: characters };
  });
  return { documents: documents.length, occurrences: documents.flatMap(d => d.claims).length, uniqueStatements: aggregateStatements(spaces).length, contextBudget: 1400, queryCount: queries.length, results, limitation: 'Synthetic oracle triples; measures retrieval and aggregation, not extraction accuracy, semantic judgment accuracy or real-corpus performance.' };
}
if (process.argv[1]?.endsWith('/run-statement-comparison-bench.ts')) console.log(JSON.stringify(statementComparisonBenchmark(), null, 2));
