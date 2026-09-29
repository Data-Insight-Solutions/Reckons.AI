import { describe, it, expect } from 'vitest';
import {
  readLifecycleRanks, buildFileIndex, isDerived,
  scoreCoverage, scoreStatus, scoreDeps, scoreScope, composite, grade,
  resolveTouchedFeatures, dependencyEdges, type Triple
} from '../alignment';

const KLIFE = 'urn:kbase:lifecycle/';
const NOTATION = 'http://www.w3.org/2004/02/skos/core#notation';
const ORDER = 'urn:reckons:nav/order';
const BROADER = 'http://www.w3.org/2004/02/skos/core#broader';

const vocab: Triple[] = ['speculative','planned','in-progress','scaffolded','functional','production']
  .flatMap((n, i) => ([
    { subject: KLIFE + n, predicate: NOTATION, object: n },
    { subject: KLIFE + n, predicate: ORDER, object: String(i) }
  ]));

const ranks = readLifecycleRanks(vocab);

describe('lifecycle ranks come from the vocabulary, not a hardcoded enum', () => {
  it('reads all SIX statuses', () => {
    expect(ranks.size).toBe(6);
    expect(ranks.get('speculative')).toBe(0);
    expect(ranks.get('production')).toBe(5);
  });

  // AGENTS.md: a session hardcoded five statuses and silently skipped every in-progress
  // feature. 16 features carry it. This is the regression pin for that.
  it('includes in-progress, which the previous scorer omitted', () => {
    expect(ranks.get('in-progress')).toBe(2);
    expect(scoreStatus(['in-progress'], ranks).detail).not.toMatch(/NOT IN VOCABULARY/);
  });

  it('counts a status missing from the vocabulary against the score rather than ignoring it', () => {
    const r = scoreStatus(['invented'], ranks);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/NOT IN VOCABULARY/);
  });
});

describe('coverage uses real file links, not filename similarity', () => {
  const index = buildFileIndex([
    { subject: 'code:llm', predicate: 'urn:kbase:predicate/has-file', object: 'src/lib/llm/providers.ts' },
    { subject: 'urn:reckons:file/cli/src/actor.ts', predicate: 'urn:kbase:predicate/path', object: 'cli/src/actor.ts' },
    { subject: 'urn:reckons:file/cli/src/actor.ts', predicate: BROADER, object: 'code:cli' }
  ]);

  it('maps a file to its module through skos:broader', () => {
    expect(index.get('cli/src/actor.ts')).toBe('code:cli');
    expect(index.get('src/lib/llm/providers.ts')).toBe('code:llm');
  });

  it('scores an unlinked file as uncovered instead of guessing by name', () => {
    const r = scoreCoverage(['src/lib/llm/providers.ts', 'scripts/lib/transcript-dir.ts'], index);
    expect(r.score).toBe(0.5);
    expect(r.unknown).toEqual(['scripts/lib/transcript-dir.ts']);
  });

  it('does not penalise regenerating what the graph itself produces', () => {
    expect(isDerived('content/tips/no-telemetry.md')).toBe(true);
    expect(isDerived('static/docs-search-index.json')).toBe(true);
    expect(isDerived('static/reckons-roadmap.ttl.bak')).toBe(true);
    expect(isDerived('src/app.html')).toBe(false);
  });
});

describe('status scores building against the plan, not against speculation', () => {
  it('rewards advancing planned / in-progress / scaffolded work', () => {
    expect(scoreStatus(['planned'], ranks).score).toBe(1);
    expect(scoreStatus(['in-progress'], ranks).score).toBe(1);
    expect(scoreStatus(['scaffolded'], ranks).score).toBe(1);
  });

  // The old scorer gave speculative a full 1.0 — writing code for work nobody committed to
  // scored as perfect alignment.
  it('costs something to write code for speculative work', () => {
    expect(scoreStatus(['speculative'], ranks).score).toBeLessThan(0.5);
  });

  it('treats production maintenance as legitimate but not advancing', () => {
    expect(scoreStatus(['production'], ranks).score).toBe(0.8);
  });
});

describe('deps is a bounded ratio, scoped to the change', () => {
  const edge = (fromStatus: string, toStatus: string | undefined) =>
    ({ from: 'kb:a', fromStatus, to: 'kb:b', toStatus });

  it('accepts planned work resting on planned work — that is a roadmap', () => {
    expect(scoreDeps([edge('planned', 'planned')], ranks).score).toBe(1);
  });

  it('flags a functional feature resting on something speculative', () => {
    const r = scoreDeps([edge('functional', 'speculative')], ranks);
    expect(r.score).toBe(0);
    expect(r.violations).toHaveLength(1);
  });

  // The old scorer multiplied 0.5 per violation with no floor: three anywhere pinned it at 0.125.
  it('cannot be driven toward zero by unrelated violations', () => {
    const edges = [edge('functional', 'speculative'), ...Array(9).fill(edge('planned', 'planned'))];
    expect(scoreDeps(edges, ranks).score).toBeCloseTo(0.9, 5);
  });

  it('is not scored at all when nothing is declared, rather than a free pass', () => {
    const r = scoreDeps([], ranks);
    expect(r.applicable).toBe(false);
    expect(r.detail).toMatch(/not scored/);
  });
});

describe('scope is independent of coverage', () => {
  const index = buildFileIndex([
    ...['a.ts','b.ts','c.ts'].map(f => ({ subject: `urn:f/${f}`, predicate: 'urn:kbase:predicate/path', object: `src/one/${f}` })),
    ...['a.ts','b.ts','c.ts'].map(f => ({ subject: `urn:f/${f}`, predicate: BROADER, object: 'code:one' })),
    { subject: 'urn:f/z.ts', predicate: 'urn:kbase:predicate/path', object: 'src/two/z.ts' },
    { subject: 'urn:f/z.ts', predicate: BROADER, object: 'code:two' }
  ]);

  it('scores a focused change high', () => {
    expect(scoreScope(['src/one/a.ts', 'src/one/b.ts', 'src/one/c.ts'], index).score).toBe(1);
  });

  // The old formula was scope = 1 - 0.8*(1 - coverage): same inputs, same answer, twice.
  it('differs from coverage on identical input', () => {
    const files = ['src/one/a.ts', 'src/two/z.ts', 'src/unlinked/q.ts'];
    const cov = scoreCoverage(files, index).score;
    const sc = scoreScope(files, index).score;
    expect(sc).not.toBeCloseTo(1 - (1 - cov) * 0.8, 5);
  });
});

describe('composite renormalises over what could actually be measured', () => {
  const d = (score: number, applicable = true) => ({ score, detail: '', applicable });

  it('weights 30/30/20/20 when every dimension applies', () => {
    expect(composite({ coverage: d(1), status: d(1), deps: d(1), scope: d(1) })).toBe(1);
    expect(grade(1)).toBe('EXCELLENT');
    expect(composite({ coverage: d(0.32), status: d(0.74), deps: d(0.13), scope: d(0.45) }))
      .toBeCloseTo(0.434, 3);
  });

  // A tooling change touches no planned feature. Scoring that 1.0 hands out a free 30%;
  // scoring it 0 punishes again what coverage already counted. It is dropped instead.
  it('drops an inapplicable dimension rather than awarding or penalising it', () => {
    const withNA = composite({ coverage: d(0.5), status: d(0, false), deps: d(1), scope: d(1) });
    // 0.5*0.3 + 1*0.2 + 1*0.2 renormalised over 0.7
    expect(withNA).toBeCloseTo((0.5 * 0.3 + 0.2 + 0.2) / 0.7, 5);
    expect(withNA).not.toBe(composite({ coverage: d(0.5), status: d(1), deps: d(1), scope: d(1) }));
  });

  it('returns null when nothing could be measured at all', () => {
    expect(composite({
      coverage: d(0, false), status: d(0, false), deps: d(0, false), scope: d(0, false)
    })).toBeNull();
  });
});

describe('touched features come from graph links, not keyword search', () => {
  const PRED = 'urn:kbase:predicate/';
  const triples: Triple[] = [
    { subject: 'kb:diff', predicate: PRED + 'has-status', object: 'functional' },
    { subject: 'kb:diff', predicate: PRED + 'tested-by', object: 'src/lib/rdf/__tests__/diff.test.ts' },
    { subject: 'kb:offload', predicate: PRED + 'has-status', object: 'in-progress' },
    { subject: 'kb:offload', predicate: PRED + 'touches-module', object: 'code:llm' },
    { subject: 'kb:offload', predicate: PRED + 'depends-on', object: 'kb:providers' },
    { subject: 'kb:providers', predicate: PRED + 'has-status', object: 'production' }
  ];
  const index = buildFileIndex([
    { subject: 'code:llm', predicate: PRED + 'has-file', object: 'src/lib/llm/providers.ts' }
  ]);

  it('finds a feature through kpred:tested-by', () => {
    const t = resolveTouchedFeatures(['src/lib/rdf/__tests__/diff.test.ts'], triples, index);
    expect(t.map(x => x.iri)).toEqual(['kb:diff']);
  });

  it('finds a feature through its module, and keeps in-progress', () => {
    const t = resolveTouchedFeatures(['src/lib/llm/providers.ts'], triples, index);
    expect(t[0].status).toBe('in-progress');
    expect(t[0].via).toContain('touches-module');
  });

  it('returns nothing for a file the graph does not link — an answer, not a guess', () => {
    expect(resolveTouchedFeatures(['src/unknown/thing.ts'], triples, index)).toEqual([]);
  });

  it('resolves both ends of a dependency edge', () => {
    const t = resolveTouchedFeatures(['src/lib/llm/providers.ts'], triples, index);
    const edges = dependencyEdges(t, triples);
    expect(edges).toEqual([{ from: 'kb:offload', fromStatus: 'in-progress', to: 'kb:providers', toStatus: 'production' }]);
    expect(scoreDeps(edges, ranks).score).toBe(1);
  });
});
