/**
 * Multi-graph store adapter (F91/F94).
 *
 * The only property worth a browser-shaped test here is PARTIAL SUCCESS. One graph failing to
 * open must not lose the graphs that answered, and must not vanish — those are the two ways a
 * federated read lies, and they look identical to a working query from the outside.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Dexie mock ───────────────────────────────────────────────────────────────
let stored: Record<string, unknown[]> = {};
let failOpen: Set<string> = new Set();
const opened: string[] = [];
const closed: string[] = [];

vi.mock('../db', () => ({
  KBaseDB: class {
    name: string;
    statements: { toArray: () => Promise<unknown[]> };
    constructor(name?: string) {
      this.name = name ?? '__working__';
      opened.push(this.name);
      this.statements = {
        toArray: async () => {
          if (failOpen.has(this.name)) throw new Error(`database ${this.name} is locked`);
          return stored[this.name] ?? [];
        },
      };
    }
    close() { closed.push(this.name); }
  },
}));

const { loadGraphsForQuery } = await import('../multi-graph-store');
const { createKb, updateKbEntry, registerStableId } = await import('../kb-registry');
const { queryGraphs, describeMultiGraphResult } = await import('$lib/rdf/multi-graph-query');
import type { Statement, NamedNode, Term } from '$lib/rdf/types';

const iri = (v: string): NamedNode => ({ kind: 'iri', value: v });
const lit = (v: string): Term => ({ kind: 'literal', value: v });
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;
const st = (s: string, p: string, o: Term, status: Statement['status'] = 'confirmed'): Statement => ({
  id: `s${n++}`, s: iri(s), p: iri(p), o, g: iri('urn:g'),
  sourceId: 'x', confidence: 1, status, createdAt: 0, updatedAt: 0,
});

const ALEX = 'urn:kbase:concept/alex';

/**
 * The registry seeds a "Default Graph" (`kbase`) on first read, and it IS a real queryable graph.
 * Tests therefore pass explicit `ids` wherever the assertion is about which graphs came back, so
 * they measure the adapter rather than the seeding.
 */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stored = {};
  failOpen = new Set();
  opened.length = 0;
  closed.length = 0;
});

describe('reading many graphs', () => {
  it('returns every graph that could be read', async () => {
    const a = createKb('Work').id;
    const b = createKb('Home').id;
    stored[a] = [st(ALEX, LABEL, lit('Alex'))];
    stored[b] = [st(ALEX, LABEL, lit('Alex'))];

    const { graphs, unavailable } = await loadGraphsForQuery({ ids: [a, b] });
    expect(graphs.map((g) => g.name).sort()).toEqual(['Home', 'Work']);
    expect(unavailable).toEqual([]);
  });

  it('drops rejected and superseded facts before they reach the merge', async () => {
    const a = createKb('Work').id;
    stored[a] = [
      st(ALEX, LABEL, lit('Alex')),
      st(ALEX, LABEL, lit('Old'), 'superseded'),
      st(ALEX, LABEL, lit('Wrong'), 'rejected'),
    ];
    const { graphs } = await loadGraphsForQuery({ ids: [a] });
    expect(graphs[0].statements).toHaveLength(1);
  });

  it('excludes archive graphs by default', async () => {
    // An archive holds a copy of its parent's facts. Letting it answer beside its parent would
    // present ONE fact as two graphs agreeing — false corroboration.
    const parent = createKb('Work').id;
    const archive = createKb('Work (archives)').id;
    // stableId is registered lazily (registerStableId), so it is undefined right after createKb.
    // Linking to it here would set archiveOf to undefined and silently disable the exclusion —
    // which is exactly what this test exists to prove happens.
    registerStableId(parent, 'stable-work');
    updateKbEntry(archive, { archiveOf: 'stable-work' });
    stored[parent] = [st(ALEX, LABEL, lit('Alex'))];
    stored[archive] = [st(ALEX, LABEL, lit('Alex'))];

    const { graphs } = await loadGraphsForQuery({ ids: [parent, archive] });
    expect(graphs.map((g) => g.name)).toEqual(['Work']);

    const withArchives = await loadGraphsForQuery({ ids: [parent, archive], excludeArchives: false });
    expect(withArchives.graphs).toHaveLength(2);
  });

  it('reads only the ids asked for', async () => {
    const a = createKb('Work').id;
    createKb('Home');
    const { graphs } = await loadGraphsForQuery({ ids: [a] });
    expect(graphs.map((g) => g.name)).toEqual(['Work']);
  });

  it('includes the default graph when no ids are given — it is a real graph', async () => {
    createKb('Work');
    const { graphs } = await loadGraphsForQuery();
    expect(graphs.map((g) => g.name)).toContain('Default Graph');
  });

  it('caps how many graphs one query opens, and says so', async () => {
    for (let i = 0; i < 5; i++) createKb(`Graph ${i}`);
    const { graphs, capped } = await loadGraphsForQuery({ maxGraphs: 3 });
    expect(graphs).toHaveLength(3);
    expect(capped).toBe(true);
  });
});

describe('partial success is reported, never hidden', () => {
  it('keeps the graphs that answered when one fails', async () => {
    const ok = createKb('Work').id;
    const broken = createKb('Locked').id;
    stored[ok] = [st(ALEX, LABEL, lit('Alex'))];
    failOpen.add(broken);

    const { graphs, unavailable } = await loadGraphsForQuery({ ids: [ok, broken] });
    expect(graphs.map((g) => g.name)).toEqual(['Work']);
    expect(unavailable).toEqual([
      { id: broken, name: 'Locked', reason: `database ${broken} is locked` },
    ]);
  });

  it('closes every database it opened, including the one that threw', async () => {
    const ok = createKb('Work').id;
    const broken = createKb('Locked').id;
    failOpen.add(broken);

    await loadGraphsForQuery({ ids: [ok, broken] });
    // A leaked connection wedges the NEXT query — the failure that turns one bad graph into a
    // permanently broken federation.
    expect(closed.sort()).toEqual(opened.sort());
  });

  it('makes the incompleteness reach the sentence a user reads', async () => {
    const ok = createKb('Work').id;
    const broken = createKb('Locked').id;
    stored[ok] = [st(ALEX, LABEL, lit('Alex'))];
    failOpen.add(broken);

    const { graphs, unavailable } = await loadGraphsForQuery({ ids: [ok, broken] });
    const result = queryGraphs(graphs, { entities: [ALEX] }, unavailable);

    expect(result.answers).toHaveLength(1);
    expect(describeMultiGraphResult(result)).toContain('Locked');
    expect(describeMultiGraphResult(result)).toContain('incomplete');
  });

  it('reports every failure when nothing can be read at all', async () => {
    const a = createKb('One').id;
    const b = createKb('Two').id;
    failOpen.add(a); failOpen.add(b);

    const { graphs, unavailable } = await loadGraphsForQuery({ ids: [a, b] });
    expect(graphs).toEqual([]);
    expect(unavailable).toHaveLength(2);

    // "No results" from two dead graphs must not read like "no results" from two live ones.
    const result = queryGraphs(graphs, { text: 'alex' }, unavailable);
    expect(describeMultiGraphResult(result)).toContain('could not be read');
  });
});
