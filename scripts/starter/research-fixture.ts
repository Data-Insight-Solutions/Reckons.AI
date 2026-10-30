import type { Statement, Source } from '../../src/lib/rdf/types.js';
export type ResearchDocument = { id: string; corpus: string; title: string; text: string; claims: Statement[] };
export function researchFixture(): ResearchDocument[] {
  return [
    { id: 'lab-a', corpus: 'engineering', title: 'Engineering test A', values: [['aster-v1', 'throughput', '100 units per second'], ['aster-v1', 'supported-language', 'TypeScript']] },
    { id: 'lab-b', corpus: 'independent-lab', title: 'Independent test B', values: [['aster-v1', 'throughput', '80 units per second'], ['aster-v1', 'supported-language', 'Python']] },
    { id: 'briefing', corpus: 'marketing', title: 'Marketing briefing', values: [['aster-v1', 'throughput', '100 units per second'], ['aster-v1', 'license', 'MIT']] },
    { id: 'legal', corpus: 'engineering', title: 'Release license record', values: [['aster-v1', 'license', 'Apache-2.0'], ['aster-v2', 'throughput', '150 units per second']] },
  ].map(d => {
    const claims: Statement[] = d.values.map(([subject, predicate, object], i) => ({ id: `research-${d.id}-${i}`, s: { kind: 'iri', value: `urn:example:research/${subject}` }, p: { kind: 'iri', value: `urn:example:predicate/${predicate}` }, o: { kind: 'literal', value: object }, g: { kind: 'iri', value: `urn:example:source/${d.id}` }, sourceId: d.id, status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1, excerpt: `${subject} ${predicate}: ${object}.`, gloss: 'Synthetic research example; deliberate disagreement, not a real product finding.' }));
    return { ...d, claims, text: `Synthetic ${d.title}. ${claims.map(s => s.excerpt).join(' ')} These are teaching examples for comparing research corpora.` };
  });
}
export const researchSources = (documents: ResearchDocument[]): Source[] => documents.map(d => ({ id: d.id, title: `${d.title} (${d.corpus}, synthetic)`, uri: `note://synthetic-research/${d.id}`, kind: 'document', trustLevel: 'review', ingestedAt: 1 }));
