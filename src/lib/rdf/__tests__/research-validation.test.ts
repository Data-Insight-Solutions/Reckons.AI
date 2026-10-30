import { describe, it, expect } from 'vitest';
import { aggregateStatements, aggregateStatementChunks } from '../statement-chunks';
import { claimFingerprint, selectNextClaim, parseWebJudgments, evidenceProposals, spaceEvidence, TRIPLE_CHECK_AGENT, type TripleCheckReport } from '../triple-check';
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
  it('keeps a stated contradicting value only when the passage contains it', () => {
    const sources = [{ url: 'https://source.test/a', title: 'A', content: 'The warranty is 10 years.' }];
    expect(parseWebJudgments('[{"index":0,"stance":"contradicts","confidence":0.9,"value":"10 years"}]', sources)[0].statedValue).toBe('10 years');
    expect(parseWebJudgments('[{"index":0,"stance":"contradicts","confidence":0.9,"value":"12 years"}]', sources)[0].statedValue).toBeUndefined();
    expect(parseWebJudgments('[{"index":0,"stance":"supports","confidence":0.9,"value":"10 years"}]', sources)[0].statedValue).toBeUndefined();
  });
  describe('what a check found becomes pending statements, not a panel', () => {
    const claim = { ...docs[0].claims[0], status: 'pending' as const };
    let n = 0; const id = () => `p${n++}`;
    const base: Omit<TripleCheckReport, 'web' | 'spaces'> = { id: 'r', statementId: claim.id, fingerprint: claimFingerprint(claim), configuration: '', claim: 'the claim', checkedAt: 1, state: 'complete', reviewed: false, webAttempted: true, searchedSpaces: 1, warnings: [] };
    const web = (stance: 'supports' | 'contradicts' | 'neutral', extra = {}) => ({ url: `https://${stance}.test/page`, title: `${stance} page`, snippet: 'passage', stance, confidence: 0.9, ...extra });
    it('agreement is the same statement from a new source; disagreement is a separate statement or a question', () => {
      const report: TripleCheckReport = { ...base, spaces: [], web: [web('supports'), web('contradicts', { statedValue: '42' }), { ...web('contradicts'), url: 'https://silent.test/' }, web('neutral'), { ...web('supports'), url: 'https://weak.test/', confidence: 0.4 }] };
      const out = evidenceProposals(claim, report, [claim], 'here', 5, id);
      expect(out).toHaveLength(3);
      const [agree, other, question] = out.map(p => p.statements[0]);
      expect(agree).toMatchObject({ s: claim.s, p: claim.p, o: claim.o, status: 'pending', proposedBy: TRIPLE_CHECK_AGENT, sourceId: out[0].source.id });
      expect(out[0].source).toMatchObject({ uri: 'https://supports.test/page', kind: 'url', trustLevel: 'review' });
      expect(other.o).toEqual({ kind: 'literal', value: '42' });
      expect(question).toMatchObject({ needsObject: true, o: { kind: 'literal', value: '?' } });
      expect(question.question).toContain('the claim');
    });
    it('another space contributes; this space, similar-only matches, copies of one source and compatible values do not', () => {
      const ev = (spaceId: string, relation: 'matches' | 'possible-conflict' | 'similar', extra = {}) => ({ spaceId, spaceName: spaceId, statementId: 'x', entity: claim.s.value, claim: '', relation, provenance: 'different-source' as const, reference: false, object: { kind: 'literal' as const, value: relation === 'matches' ? claim.o.value : '99' }, ...extra });
      const report: TripleCheckReport = { ...base, web: [], spaces: [ev('here', 'possible-conflict'), ev('other', 'matches'), ev('other', 'possible-conflict'), ev('similar', 'similar'), ev('copy', 'matches', { provenance: 'shared-source' }), ev('compatible', 'possible-conflict', { stance: 'neutral' })] };
      const out = evidenceProposals(claim, report, [claim], 'here', 5, id);
      expect(out.map(p => p.source.id)).toEqual(['triple-check-space-other']);
      expect(out[0].statements.map(s => s.o.value)).toEqual([claim.o.value, '99']);
    });
    it('a proposal made before, in any status, is not made again', () => {
      const report: TripleCheckReport = { ...base, spaces: [], web: [web('supports')] };
      const [first] = evidenceProposals(claim, report, [claim], 'here', 5, id);
      expect(evidenceProposals(claim, report, [claim, { ...first.statements[0], status: 'rejected' }], 'here', 6, id)).toEqual([]);
    });
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
