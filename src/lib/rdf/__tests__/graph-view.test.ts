/**
 * Graph legibility (F83).
 *
 * The roadmap has 1,888 triples but only 233 real entities. It was rendering as ~1,234
 * nodes because every object became one — including 265-character descriptions. Unusable
 * on a phone, and the roadmap is the first graph anyone opens.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGraphView,
  categoryLiterals,
  isNodeTerm,
  predicateFacets,
  timeRange,
  topByDegree,
  MAX_CATEGORY_LITERAL_LENGTH,
} from '../graph-view';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const KP = 'urn:kbase:predicate/';
const KB = 'urn:kbase:concept/';

let n = 0;
function st(subject: string, predicate: string, object: string | { literal: string }, createdAt = 0): Statement {
  return {
    id: `s${++n}`,
    s: iri(`${KB}${subject}`),
    p: iri(`${KP}${predicate}`),
    o: typeof object === 'string' ? iri(`${KB}${object}`) : lit(object.literal),
    g: iri('urn:kbase:source/test'),
    sourceId: 'src',
    confidence: 1,
    status: 'confirmed',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('categoryLiterals — a literal EARNS a node by being shared', () => {
  it('promotes a value that many subjects share', () => {
    // "production" is what 53 features have in common. That is real structure.
    const cats = categoryLiterals([
      st('a', 'has-status', { literal: 'production' }),
      st('b', 'has-status', { literal: 'production' }),
      st('c', 'has-status', { literal: 'production' }),
    ]);
    expect(cats.has('production')).toBe(true);
  });

  it('REFUSES a value that appears once — it connects nothing', () => {
    // 96% of the roadmap's distinct literal values appear exactly once. Each one is a
    // leaf that can never link anything to anything.
    const cats = categoryLiterals([st('a', 'description', { literal: 'a unique sentence' })]);
    expect(cats.has('a unique sentence')).toBe(false);
  });

  it('REFUSES prose even when two subjects share it verbatim', () => {
    // A paragraph is not a category, however many things say it.
    const essay = 'x'.repeat(MAX_CATEGORY_LITERAL_LENGTH + 1);
    const cats = categoryLiterals([
      st('a', 'description', { literal: essay }),
      st('b', 'description', { literal: essay }),
    ]);
    expect(cats.has(essay)).toBe(false);
  });
});

describe('isNodeTerm', () => {
  it('entities are always nodes; literals only when they are categories', () => {
    const cats = new Set(['production']);
    expect(isNodeTerm(iri(`${KB}thing`), cats)).toBe(true);
    expect(isNodeTerm(lit('production'), cats)).toBe(true);
    expect(isNodeTerm(lit('some unique description'), cats)).toBe(false);
  });
});

describe('buildGraphView — attributes leave the canvas, structure stays', () => {
  it('separates what is DRAWN from what is READ', () => {
    const stmts = [
      st('feature-a', 'depends-on', 'core'),                                  // edge
      st('feature-a', 'has-status', { literal: 'production' }),               // shared → edge
      st('feature-b', 'has-status', { literal: 'production' }),               // shared → edge
      st('feature-a', 'description', { literal: 'a long unique explanation' }), // attribute
    ];

    const view = buildGraphView(stmts);

    expect(view.edges).toHaveLength(3);
    expect(view.categories.has('production')).toBe(true);

    // The description does not vanish — it moves to the node panel, where it is readable.
    // (attributes are keyed by termKey(), which prefixes IRIs with `i:`)
    const attrs = view.attributes.get(`i:${KB}feature-a`);
    expect(attrs).toHaveLength(1);
    expect(attrs![0].o.value).toBe('a long unique explanation');
  });

  it('the whole point: a 1888-triple graph is not a 1234-node graph', () => {
    // 20 entities, each with a unique description and a shared status.
    const stmts: Statement[] = [];
    for (let i = 0; i < 20; i++) {
      stmts.push(st(`f${i}`, 'has-status', { literal: 'production' }));
      stmts.push(st(`f${i}`, 'description', { literal: `a unique essay about feature ${i}` }));
      stmts.push(st(`f${i}`, 'depends-on', 'core'));
    }

    const view = buildGraphView(stmts);

    // 20 descriptions become attributes, not 20 dangling text nodes.
    expect(view.attributes.size).toBe(20);
    expect(view.edges).toHaveLength(40); // status + depends-on, per feature
    expect(view.edges.every((e) => e.p.value !== `${KP}description`)).toBe(true);
  });

  it('categoryNodes:false drops literal nodes entirely — pure entity structure', () => {
    const stmts = [
      st('a', 'has-status', { literal: 'production' }),
      st('b', 'has-status', { literal: 'production' }),
      st('a', 'depends-on', 'core'),
    ];
    const view = buildGraphView(stmts, { categoryNodes: false });
    expect(view.edges).toHaveLength(1); // only the entity→entity edge
    expect(view.categories.size).toBe(0);
  });

  it('filters by predicate — "just show me the dependency graph"', () => {
    const stmts = [
      st('a', 'depends-on', 'core'),
      st('a', 'relates-to', 'b'),
      st('a', 'description', { literal: 'noise' }),
    ];
    const view = buildGraphView(stmts, { predicates: new Set([`${KP}depends-on`]) });
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0].p.value).toBe(`${KP}depends-on`);
  });

  it('filters by time window', () => {
    const stmts = [
      st('a', 'depends-on', 'core', 1_000),
      st('b', 'depends-on', 'core', 5_000),
      st('c', 'depends-on', 'core', 9_000),
    ];
    expect(buildGraphView(stmts, { since: 4_000 }).edges).toHaveLength(2);
    expect(buildGraphView(stmts, { since: 4_000, until: 6_000 }).edges).toHaveLength(1);
  });
});

describe('predicateFacets', () => {
  it('surfaces the structural predicates first, so the user can find them', () => {
    const facets = predicateFacets([
      st('a', 'depends-on', 'x'),
      st('b', 'depends-on', 'y'),
      st('c', 'description', { literal: 'z' }),
    ]);
    expect(facets[0]).toMatchObject({ label: 'depends-on', count: 2 });
  });
});

describe('timeRange', () => {
  it('bounds the slider, and copes with an empty graph', () => {
    expect(timeRange([st('a', 'p', 'b', 100), st('c', 'p', 'd', 900)])).toEqual({ min: 100, max: 900 });
    expect(timeRange([])).toBeNull();
  });
});

describe('topByDegree — progressive disclosure', () => {
  it('keeps the most-connected nodes and the edges among them', () => {
    // hub is connected to 5 leaves; a lone pair sits off to the side.
    const stmts = [
      ...Array.from({ length: 5 }, (_, i) => st(`leaf${i}`, 'depends-on', 'hub')),
      st('lonely-a', 'depends-on', 'lonely-b'),
    ];

    const top = topByDegree(stmts, 3);
    // hub survives; so do its two best-connected neighbours. The lonely pair is dropped.
    expect(top.every((e) => e.o.value.endsWith('hub') || e.s.value.endsWith('hub'))).toBe(true);
  });

  it('never draws an edge into a node it has hidden', () => {
    // The failure this guards: keep the top-N nodes but keep every edge, and the canvas
    // shows edges vanishing into empty space.
    const stmts = [
      st('a', 'depends-on', 'hub'),
      st('b', 'depends-on', 'hub'),
      st('c', 'depends-on', 'far-away'),
    ];
    const top = topByDegree(stmts, 2);
    const kept = new Set(top.flatMap((e) => [e.s.value, e.o.value]));
    for (const e of top) {
      expect(kept.has(e.s.value)).toBe(true);
      expect(kept.has(e.o.value)).toBe(true);
    }
  });

  it('is a no-op on an empty graph', () => {
    expect(topByDegree([], 10)).toEqual([]);
  });
});
