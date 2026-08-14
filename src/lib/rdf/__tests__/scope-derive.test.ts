import { describe, it, expect } from 'vitest';
import {
  deriveScope,
  checkEstimate,
  suggestEstimate,
  blastRadius,
  estimateFromFiles,
  highBlastFiles,
  type ModuleFacts,
} from '../scope-derive';
import {
  JUSTIFICATION_KINDS,
  isAccountable,
  routeForJudgement,
  followUp,
  describeJustification,
  type ScopeJustification,
} from '../scope-justification';

const rdf: ModuleFacts = {
  iri: 'urn:reckons:code/rdf',
  label: 'RDF Engine',
  files: Array.from({ length: 24 }, (_, i) => `src/lib/rdf/f${i}.ts`),
};
const stores: ModuleFacts = {
  iri: 'urn:reckons:code/stores',
  label: 'Svelte Stores',
  files: Array.from({ length: 22 }, (_, i) => `src/lib/stores/s${i}.ts`),
};

describe('deriveScope', () => {
  it('gives an upper bound from the modules named', () => {
    const d = deriveScope([rdf, stores]);
    expect(d.upperBound).toBe(46);
  });

  it('deduplicates files shared between modules', () => {
    const a: ModuleFacts = { iri: 'a', files: ['x.ts', 'y.ts'] };
    const b: ModuleFacts = { iri: 'b', files: ['y.ts', 'z.ts'] };
    expect(deriveScope([a, b]).upperBound).toBe(3);
  });

  it('takes a lower bound from explicitly named files', () => {
    const d = deriveScope([rdf], ['src/lib/rdf/f1.ts', 'src/lib/rdf/f2.ts']);
    expect(d.lowerBound).toBe(2);
  });
});

describe('checkEstimate — the graph catching a bad number', () => {
  it('accepts an estimate inside the bounds', () => {
    expect(checkEstimate(6, deriveScope([rdf])).kind).toBe('plausible');
  });

  it('FLAGS an estimate above the file universe as a design that has not named every module', () => {
    // The interesting reading is not "the number is too big" — it is that the design has
    // probably not listed everywhere it will actually go.
    const v = checkEstimate(40, deriveScope([rdf]));
    expect(v.kind).toBe('exceeds-universe');
    if (v.kind === 'exceeds-universe') expect(v.message).toMatch(/has not yet named every module/);
  });

  it('flags an estimate below the files already named', () => {
    const v = checkEstimate(1, deriveScope([rdf], ['a.ts', 'b.ts', 'c.ts']));
    expect(v.kind).toBe('below-named');
  });

  it('reports UNDERIVABLE when no module is named, rather than passing silently', () => {
    // An unchecked estimate that looks identical to a checked one is how a guess acquires
    // false authority — which is exactly what the first three estimates were.
    const v = checkEstimate(6, deriveScope([]));
    expect(v.kind).toBe('underivable');
    if (v.kind === 'underivable') expect(v.message).toMatch(/still a guess/);
  });
});

describe('suggestEstimate', () => {
  it('suggests a fraction of the universe, not the whole of it', () => {
    // A feature touching a module almost never touches every file in it.
    const s = suggestEstimate(deriveScope([rdf]))!;
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(24);
  });

  it('never suggests fewer files than the design already names', () => {
    const named = Array.from({ length: 20 }, (_, i) => `n${i}.ts`);
    expect(suggestEstimate(deriveScope([rdf], named))).toBeGreaterThanOrEqual(20);
  });

  it('returns null when nothing can be derived', () => {
    expect(suggestEstimate(deriveScope([]))).toBeNull();
  });
});

// ── Justification ────────────────────────────────────────────────────────────

function j(p: Partial<ScopeJustification> = {}): ScopeJustification {
  return {
    design: 'kb:source-reference-copy',
    kind: 'discovery-through-use',
    rationale: 'I used the initial version and it now clearly needs this other thing.',
    decision: 'open',
    at: 1,
    ...p,
  };
}

describe('scope justification — raising judgement to someone accountable', () => {
  it('does NOT treat a decision without a decider as settled', () => {
    expect(isAccountable(j({ decision: 'accepted' }))).toBe(false);
    expect(isAccountable(j({ decision: 'accepted', decidedBy: '  ' }))).toBe(false);
    expect(isAccountable(j({ decision: 'accepted', decidedBy: 'Matt' }))).toBe(true);
  });

  it('leaves an undecided increase OPEN — silence is not consent', () => {
    expect(isAccountable(j())).toBe(false);
    expect(describeJustification(j())).toMatch(/OPEN/);
  });

  it('routes contestable-but-legitimate calls to the council', () => {
    expect(routeForJudgement(j({ kind: 'discovery-through-use' }))).toBe('council');
    expect(routeForJudgement(j({ kind: 'consistency-maintenance' }))).toBe('council');
  });

  it('routes anything illegitimate to a HUMAN, never a council', () => {
    // Accepting work that does not belong to a design is an accountability decision, not a
    // technical one, so a model must not be the last word.
    expect(routeForJudgement(j({ kind: 'unrelated-work' }))).toBe('human');
  });

  it('routes process problems to a human too', () => {
    expect(routeForJudgement(j({ kind: 'blocking-defect' }))).toBe('human');
  });

  it('turns an accepted design-refining increase into an amendment', () => {
    const f = followUp(j({ kind: 'discovery-through-use', decision: 'accepted', decidedBy: 'Matt' }));
    expect(f).toMatch(/Amend kb:source-reference-copy/);
  });

  it('says a process problem must be recorded SEPARATELY, not absorbed', () => {
    const f = followUp(j({ kind: 'blocking-defect', decision: 'accepted', decidedBy: 'Matt' }));
    expect(f).toMatch(/separately/);
  });

  it('produces no follow-up for work that was split out or reverted', () => {
    expect(followUp(j({ decision: 'split-out', decidedBy: 'Matt' }))).toBeNull();
    expect(followUp(j({ decision: 'reverted', decidedBy: 'Matt' }))).toBeNull();
  });

  it('marks only unrelated-work as illegitimate', () => {
    const illegit = Object.entries(JUSTIFICATION_KINDS).filter(([, m]) => !m.legitimate);
    expect(illegit.map(([k]) => k)).toEqual(['unrelated-work']);
  });

  it('keeps BOTH the structured kind and the prose rationale', () => {
    // Free text alone tells a story once and nothing thereafter; the kind is what makes
    // repeated causes countable.
    const s = describeJustification(j({ decision: 'accepted', decidedBy: 'Matt' }));
    expect(s).toMatch(/revealed what it still needed/);
    expect(s).toMatch(/clearly needs this other thing/);
    expect(s).toMatch(/decided by Matt/);
  });
});

// ── File-granular estimate ───────────────────────────────────────────────────

describe('blastRadius', () => {
  // types.ts <- kb.svelte.ts <- review page;  types.ts <- serialize.ts
  const idx = new Map<string, Set<string>>([
    ['types.ts', new Set(['kb.svelte.ts', 'serialize.ts'])],
    ['kb.svelte.ts', new Set(['review.svelte'])],
  ]);

  it('finds direct dependents', () => {
    expect(blastRadius(['types.ts'], idx).direct.sort()).toEqual(['kb.svelte.ts', 'serialize.ts']);
  });

  it('walks upward for the transitive set', () => {
    expect(blastRadius(['types.ts'], idx).transitive.sort()).toEqual([
      'kb.svelte.ts',
      'review.svelte',
      'serialize.ts',
    ]);
  });

  it('EXCLUDES the seed, so an estimate never double-counts what it is already changing', () => {
    const r = blastRadius(['types.ts', 'kb.svelte.ts'], idx);
    expect(r.direct).not.toContain('kb.svelte.ts');
    expect(r.transitive).not.toContain('types.ts');
  });

  it('returns nothing for a file nobody imports', () => {
    expect(blastRadius(['orphan.ts'], idx).transitive).toEqual([]);
  });

  it('terminates on an import cycle', () => {
    const cyclic = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['a.ts'])],
    ]);
    expect(blastRadius(['a.ts'], cyclic).transitive).toEqual(['b.ts']);
  });
});

describe('estimateFromFiles', () => {
  const idx = new Map<string, Set<string>>([
    ['types.ts', new Set(['kb.svelte.ts', 'serialize.ts'])],
    ['kb.svelte.ts', new Set(['review.svelte'])],
  ]);

  it('floors at the files the design named', () => {
    expect(estimateFromFiles(['types.ts'], idx).floor).toBe(1);
  });

  it('uses only DIRECT dependents for the likely figure', () => {
    // The transitive closure through a hub reaches most of the repo and would make every
    // estimate meaningless; a change usually stops at the first ring.
    const e = estimateFromFiles(['types.ts'], idx);
    expect(e.likely).toBe(3);
    expect(e.ceiling).toBe(4);
  });

  it('keeps the ceiling as the honest worst case', () => {
    const e = estimateFromFiles(['types.ts'], idx);
    expect(e.ceiling).toBeGreaterThanOrEqual(e.likely);
  });
});

describe('highBlastFiles', () => {
  it('names the files worth warning about', () => {
    const idx = new Map<string, Set<string>>([
      ['hub.ts', new Set(Array.from({ length: 50 }, (_, i) => `f${i}.ts`))],
      ['quiet.ts', new Set(['one.ts'])],
    ]);
    const hot = highBlastFiles(idx, 40);
    expect(hot).toHaveLength(1);
    expect(hot[0]).toMatchObject({ file: 'hub.ts', dependents: 50 });
  });
});
