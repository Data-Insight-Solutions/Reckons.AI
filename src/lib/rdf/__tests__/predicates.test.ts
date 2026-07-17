/**
 * Predicate manager (kb:predicate-manager) — list, rename, merge.
 *
 * Marked `production`, no tests, logic inline in a Svelte component. Three real defects
 * were living in it. These are the tests that would have caught each one.
 */
import { describe, it, expect } from 'vitest';
import {
  listPredicates,
  planRename,
  planMerge,
  slugifyPredicate,
  predicateSlug,
  isOwnPredicate,
} from '../predicates';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const KP = 'urn:kbase:predicate/';
const KM = 'urn:kbase:meta/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';

let n = 0;
function st(
  subject: string,
  predicate: string,
  object: string,
  opts: { literal?: boolean; status?: Statement['status'] } = {},
): Statement {
  return {
    id: `s${++n}`,
    s: iri(`urn:kbase:concept/${subject}`),
    p: iri(predicate),
    o: opts.literal ? lit(object) : iri(`urn:kbase:concept/${object}`),
    g: iri('urn:kbase:source/test'),
    sourceId: 'src',
    confidence: 1,
    status: opts.status ?? 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('listPredicates', () => {
  it('counts active statements, most-used first, and ignores rejected/superseded', () => {
    const list = listPredicates([
      st('a', `${KP}likes`, 'b'),
      st('c', `${KP}likes`, 'd'),
      st('e', `${KP}knows`, 'f'),
      st('g', `${KP}likes`, 'h', { status: 'rejected' }),   // ignored
      st('i', `${KP}knows`, 'j', { status: 'superseded' }), // ignored
    ]);

    expect(list.map((p) => [p.slug, p.count])).toEqual([['likes', 2], ['knows', 1]]);
  });

  it('flags predicates that are NOT ours', () => {
    const list = listPredicates([st('a', RDFS_LABEL, 'x', { literal: true }), st('b', `${KP}likes`, 'c')]);
    expect(list.find((p) => p.iri === RDFS_LABEL)?.isExternal).toBe(true);
    expect(list.find((p) => p.slug === 'likes')?.isExternal).toBe(false);
  });

  it('displays a readable name for hash-separated IRIs', () => {
    expect(predicateSlug(RDFS_LABEL)).toBe('label');
    expect(predicateSlug(`${KP}has-status`)).toBe('has-status');
    expect(isOwnPredicate(RDFS_LABEL)).toBe(false);
    expect(isOwnPredicate(`${KM}icon`)).toBe(true);
  });
});

describe('slugifyPredicate', () => {
  it('normalizes free text into a slug', () => {
    expect(slugifyPredicate('  Has  Status! ')).toBe('has-status');
    expect(slugifyPredicate('!!!')).toBe('');
  });
});

// ── BUG 1: rename destroyed standard vocabulary ──────────────────────────────
describe('planRename — standard vocabulary is not ours to rename', () => {
  it('REFUSES to rename rdfs:label', () => {
    // The old code computed the new IRI as `isMeta ? META : PREDICATE` with no third
    // case — so renaming rdfs:label rewrote it to urn:kbase:predicate/label, silently
    // converting an interoperable standard term into a private one. The graph would
    // stop meaning what it said, and no export would carry that meaning anywhere.
    const stmts = [st('a', RDFS_LABEL, 'Alice', { literal: true })];
    const plan = planRename(stmts, RDFS_LABEL, 'name');

    expect(plan.ok).toBe(false);
    expect(plan.blocked).toBe('external-vocabulary');
    expect(plan.newIri).toBeUndefined();
  });

  it('REFUSES to rename skos:broader', () => {
    const plan = planRename([st('a', SKOS_BROADER, 'b')], SKOS_BROADER, 'parent');
    expect(plan.blocked).toBe('external-vocabulary');
  });

  it('allows renaming our own predicates', () => {
    const plan = planRename([st('a', `${KP}writes`, 'b')], `${KP}writes`, 'authored');
    expect(plan.ok).toBe(true);
    expect(plan.newIri).toBe(`${KP}authored`);
    expect(plan.affected).toHaveLength(1);
  });

  it('keeps a meta predicate in the meta namespace', () => {
    const plan = planRename([st('a', `${KM}icon`, 'x', { literal: true })], `${KM}icon`, 'symbol');
    expect(plan.newIri).toBe(`${KM}symbol`);
  });

  it('rejects an empty slug and no-ops an unchanged one', () => {
    expect(planRename([st('a', `${KP}x`, 'b')], `${KP}x`, '!!!').blocked).toBe('empty');
    expect(planRename([st('a', `${KP}x`, 'b')], `${KP}x`, 'x').unchanged).toBe(true);
  });
});

// ── BUG 2: rename onto an existing predicate silently merged ─────────────────
describe('planRename — a collision is a MERGE, and must be said out loud', () => {
  it('flags the collision instead of quietly collapsing two predicates', () => {
    const stmts = [
      st('a', `${KP}writes`, 'b'),
      st('c', `${KP}authored`, 'd'),
      st('e', `${KP}authored`, 'f'),
    ];
    const plan = planRename(stmts, `${KP}writes`, 'authored');

    // Not refused — merging may be exactly what the user wants — but never silent.
    expect(plan.ok).toBe(true);
    expect(plan.collidesWith?.slug).toBe('authored');
    expect(plan.collidesWith?.count).toBe(2);
  });

  it('reports the duplicate statements the collision would create', () => {
    const stmts = [
      st('alice', `${KP}writes`, 'book'),   // becomes (alice, authored, book)…
      st('alice', `${KP}authored`, 'book'), // …which already exists
    ];
    const plan = planRename(stmts, `${KP}writes`, 'authored');
    expect(plan.duplicates).toHaveLength(1);
  });
});

// ── BUG 3: merge created duplicate statements ────────────────────────────────
describe('planMerge — must not double the graph', () => {
  it('identifies statements that would become exact twins', () => {
    const stmts = [
      st('alice', `${KP}likes`, 'tea'),  // twin: (alice, loves, tea) already exists
      st('alice', `${KP}loves`, 'tea'),
      st('bob', `${KP}likes`, 'coffee'), // no twin — a real rewrite
    ];
    const plan = planMerge(stmts, `${KP}likes`, `${KP}loves`);

    expect(plan.ok).toBe(true);
    expect(plan.affected).toHaveLength(2);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].s.value).toContain('alice');
  });

  it('catches twins created WITHIN the merged batch itself', () => {
    // Two source statements folding onto the same target triple: one survives, one is
    // a duplicate. A naive merge writes both.
    const stmts = [
      st('alice', `${KP}likes`, 'tea'),
      st('alice', `${KP}likes`, 'tea'), // same triple, different statement id
    ];
    const plan = planMerge(stmts, `${KP}likes`, `${KP}loves`);
    expect(plan.duplicates).toHaveLength(1); // exactly one is redundant, not both
  });

  it('distinguishes a literal object from an IRI of the same text', () => {
    const stmts = [
      st('a', `${KP}likes`, 'tea', { literal: true }),
      st('a', `${KP}loves`, 'tea'), // IRI, not the same object
    ];
    expect(planMerge(stmts, `${KP}likes`, `${KP}loves`).duplicates).toHaveLength(0);
  });

  it('refuses to merge away a standard vocabulary term', () => {
    const plan = planMerge([st('a', RDFS_LABEL, 'x', { literal: true })], RDFS_LABEL, `${KP}name`);
    expect(plan.ok).toBe(false);
    expect(plan.blocked).toBe('external-vocabulary');
  });

  it('refuses a no-op merge into itself', () => {
    expect(planMerge([st('a', `${KP}x`, 'b')], `${KP}x`, `${KP}x`).blocked).toBe('same-predicate');
  });
});
