import { describe, it, expect } from 'vitest';
import { aggregateStatements, aggregateStatementChunks } from '../statement-chunks';
import { claimFingerprint, selectNextClaim, parseWebJudgments, evidenceEstimate, spaceEvidence, type TripleCheckReport } from '../triple-check';
import { projectSpaceView } from '../space-view';
import { purposeOrganization } from '../purpose-organization';
import { repositoryProfiles, repositoryOverlap } from '../repository-comparison';
import { researchFixture } from '../../../../scripts/starter/research-fixture';
import { statementComparisonBenchmark } from '../../../../tests/bench/run-statement-comparison-bench';
const docs = researchFixture(), spaces = docs.map(d => ({ id: d.id, name: d.title, statements: d.claims }));
describe('statement-first research validation', () => {
  it('deduplicates across corpora while retaining all occurrence citations', () => {
    const claims = aggregateStatements(spaces); expect(claims).toHaveLength(7);
    const repeated = claims.find(c => c.occurrences.length === 2)!;
    expect(repeated.occurrences.map(o => o.sourceId).sort()).toEqual(['briefing', 'lab-a']);
    const chunks = aggregateStatementChunks(spaces, 80);
    expect(chunks.flatMap(c => c.claims)).toHaveLength(7);
    expect(chunks.find(c => c.claims.some(k => k.key === repeated.key))?.text).toContain('briefing');
    expect(aggregateStatements([{ ...spaces[0], statements: spaces[0].statements.map(s => ({ ...s, status: 'rejected' })) }])).toEqual([]);
  });
  it('invalidates edits/configuration and checks a repeated claim only once', () => {
    const claim = docs[0].claims[0], duplicate = { ...claim, id: 'copy', sourceId: 'other' };
    const report = { fingerprint: claimFingerprint(claim), configuration: 'a', checkedAt: 100, state: 'complete', warnings: [] } as unknown as TripleCheckReport;
    expect(selectNextClaim([duplicate], [report], 200, 'a')).toBeUndefined();
    expect(selectNextClaim([{ ...claim, o: { kind: 'literal', value: '80' } }], [report], 200, 'a')).toBeDefined();
    expect(selectNextClaim([claim], [report], 200, 'b')).toBeDefined();
    expect(selectNextClaim([{ ...claim, status: 'rejected' }], [], 200, 'a')).toBeUndefined();
  });
  it('finds conflicting observations within the same space and excludes the original duplicate', () => {
    const claim = docs[0].claims[0];
    const result = spaceEvidence(claim, [{ id: 'here', name: 'Here', statements: docs.flatMap(d => d.claims) }], 'here');
    expect(result.evidence.some(e => e.relation === 'possible-conflict' && e.claim.includes('80 units'))).toBe(true);
    expect(result.evidence.some(e => e.relation === 'matches')).toBe(false);
  });
  it('binds model output to retrieved citations and fails on partial, repeated or invented indexes', () => {
    const sources = [{ url: 'https://source.test/actual', title: 'Actual source', content: 'Actual passage' }];
    expect(parseWebJudgments('[{"index":0,"stance":"supports","confidence":0.9,"url":"https://invented.test"}]', sources)[0].url).toBe(sources[0].url);
    for (const raw of ['[]', '[{"index":0,"stance":"true","confidence":1}]', '[{"index":2,"stance":"supports","confidence":1}]', '[{"index":0,"stance":"supports","confidence":2}]']) expect(() => parseWebJudgments(raw, sources)).toThrow();
    expect(() => parseWebJudgments('[{"index":0,"stance":"neutral","confidence":1},{"index":0,"stance":"neutral","confidence":1}]', [...sources, ...sources])).toThrow();
  });
  it('requires distinct strong passages for a qualitative likely-false assessment', () => {
    const s = { url: 'https://one.test/a', title: 'Source', snippet: 'copied passage', stance: 'contradicts' as const, confidence: 0.9 };
    expect(evidenceEstimate([s, { ...s, url: 'https://two.test/a' }, { ...s, url: 'https://three.test/a' }])).toContain('Not enough');
    expect(evidenceEstimate([s, { ...s, url: 'https://two.test/a', snippet: 'second evidence' }, { ...s, url: 'https://three.test/a', snippet: 'third evidence' }])).toContain('Likely false');
  });
  it('retrieves both conflict sides under equal budgets without claiming extraction accuracy', () => {
    const result = statementComparisonBenchmark();
    expect(result.results.find(r => r.arm === 'aggregated')).toMatchObject({ claimRecall: 1, conflictPairsRetrieved: 2 });
    expect(result.limitation).toContain('not extraction'); expect(result.results.every(r => r.retrievedCharacters <= result.contextBudget * result.queryCount)).toBe(true);
  });
  it('projects a bounded graph with no dangling edges and preserves all underlying facts', () => {
    const initial = docs.flatMap(d => d.claims), copy = structuredClone(initial);
    const result = projectSpaceView(initial, { limit: 1 }); expect(result.entities.size).toBe(1);
    expect(result.statements.every(s => result.entities.has(s.s.value) && (s.o.kind !== 'iri' || result.entities.has(s.o.value)))).toBe(true);
    expect(initial).toEqual(copy);
    const saved = projectSpaceView(initial, { view: { id: 'v', name: 'Precise', entities: [initial[0].s.value], predicates: [], statementIds: [initial[0].id] } });
    expect(saved.statements.map(s => s.id)).toEqual([initial[0].id]);
  });
  it('applies organization without settling pending members, rejecting invalid model assignments', () => {
    const initial = docs[0].claims.map(s => ({ ...s, status: 'pending' as const })), copy = structuredClone(initial);
    const result = purposeOrganization(['Research'], [{ purpose: 'Research', statementIds: initial.map(s => s.id) }], initial, 'action', 2);
    expect(initial).toEqual(copy); expect(result.filter(s => s.p.value.endsWith('#member'))).toHaveLength(1);
    for (const groups of [[], [{ purpose: 'Invented', statementIds: initial.map(s => s.id) }], [{ purpose: 'Research', statementIds: [initial[0].id] }], [{ purpose: 'Research', statementIds: [initial[0].id, initial[0].id] }]]) expect(() => purposeOrganization(['Research'], groups, initial, 'action', 2)).toThrow();
  });
  it('keeps rejected repository claims out of comparisons and unknown overlap distinct from zero', () => {
    const profile = (id: string, status: 'confirmed' | 'rejected') => ({ ...docs[0].claims[0], s: { kind: 'iri' as const, value: `https://github.com/example/${id}` }, status });
    const profiles = repositoryProfiles([profile('a', 'confirmed'), profile('b', 'confirmed'), profile('secret', 'rejected')]);
    expect(profiles).toHaveLength(2); expect(repositoryOverlap(profiles[0], profiles[1]).score).toBeNull();
  });
});
