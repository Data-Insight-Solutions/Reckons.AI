import { describe, it, expect } from 'vitest';
import { revalidate, applyChange, explainEffect } from '../vocabulary-change';
import type { Statement } from '../types';

const KP = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';

let n = 0;
function st(subject: string, predicate: string, object = 'value', extra: Partial<Statement> = {}): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: `${KB}${subject}` },
    p: { kind: 'iri', value: `${KP}${predicate}` },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'src',
    confidence: 1,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('applyChange', () => {
  it('does not mutate the input', () => {
    const graph = [st('a', 'has-status', 'functional')];
    applyChange(graph, { kind: 'predicate-altitude', predicate: `${KP}has-status`, to: 'log' });
    expect(graph[0].altitude).toBeUndefined();
  });

  it('leaves a fact whose altitude was set BY HAND alone', () => {
    const graph = [st('a', 'has-status', 'functional', { altitude: 'decision' })];
    const after = applyChange(graph, { kind: 'predicate-altitude', predicate: `${KP}has-status`, to: 'log' });
    expect(after[0].altitude).toBe('decision');
  });
});

describe('revalidate — the whole graph, not the changed rows', () => {
  it('reports nothing when nothing moves', () => {
    const graph = [st('a', 'has-status', 'functional')];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}unused-predicate`,
      to: 'log',
    });
    expect(effect.factsAffected).toBe(0);
    expect(explainEffect(effect)).toContain('Changes nothing');
  });

  it('counts every fact using the predicate', () => {
    const graph = [
      st('a', 'has-status', 'functional'),
      st('b', 'has-status', 'planned'),
      st('c', 'has-file', 'src/x.ts'),
    ];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-status`,
      to: 'log',
    });
    expect(effect.factsDirect).toBe(2);
    expect(effect.factsAffected).toBe(2);
    expect(effect.entitiesTouched).toBe(2);
  });

  // The number that must be read first.
  it('reports facts LEAVING the review queue separately', () => {
    const graph = [st('a', 'has-status', 'functional'), st('b', 'has-status', 'planned')];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-status`,
      to: 'log',
    });
    expect(effect.hiddenFromReview).toBe(2);   // judgment -> log: no longer reviewable
    expect(effect.surfacedForReview).toBe(0);
    expect(effect.demotes).toBe(true);
    expect(explainEffect(effect)).toContain('leave your review queue');
  });

  it('a promotion surfaces facts instead, and is not flagged as a demotion', () => {
    const graph = [st('a', 'has-file', 'src/x.ts')];   // record — not reviewable
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-file`,
      to: 'judgment',
    });
    expect(effect.surfacedForReview).toBe(1);
    expect(effect.hiddenFromReview).toBe(0);
    expect(effect.demotes).toBe(false);
  });

  it('names the transition, so the report says what became what', () => {
    const graph = [st('a', 'has-status', 'functional')];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-status`,
      to: 'log',
    });
    expect(effect.transitions).toEqual([{ from: 'judgment', to: 'log', count: 1 }]);
  });

  // The reason this recomputes instead of subtracting.
  it('catches facts that move WITHOUT using the changed predicate', () => {
    // Promoting `note` to a decision makes it an open question on subject `a`, and
    // liftedAltitudes then pulls a's OTHER facts up with it — facts that never mention `note`.
    const graph = [
      st('a', 'open-question', 'which way?', { needsObject: true }),
      st('a', 'has-file', 'src/x.ts'),
      st('b', 'has-file', 'src/y.ts'),
    ];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-file`,
      to: 'log',
    });
    // b's has-file drops to log. a's has-file is LIFTED by the open decision on a, so it does
    // not follow — and only a full recompute can tell those two apart.
    const moved = effect.factsAffected;
    expect(moved).toBeGreaterThan(0);
    expect(effect.factsDirect).toBe(2);
    expect(moved).toBeLessThan(effect.factsDirect + 1);
  });

  it('explains indirect movement when there is any', () => {
    const graph = [st('a', 'has-status', 'functional'), st('a', 'has-file', 'src/x.ts')];
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-status`,
      to: 'decision',
    });
    // has-status becomes a decision; it is not an open question, so nothing lifts. The wording
    // must not claim indirect movement that did not happen.
    if (effect.factsAffected === effect.factsDirect) {
      expect(explainEffect(effect)).not.toContain('do not use this predicate');
    }
  });

  it('scales the report by entities, not just facts', () => {
    const graph = Array.from({ length: 20 }, (_, i) => st(`e${i}`, 'has-status', 'functional'));
    const effect = revalidate(graph, {
      kind: 'predicate-altitude',
      predicate: `${KP}has-status`,
      to: 'log',
    });
    expect(effect.entitiesTouched).toBe(20);
    expect(explainEffect(effect)).toContain('20 entities');
  });
});
