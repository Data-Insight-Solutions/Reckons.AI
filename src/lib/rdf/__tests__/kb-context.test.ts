/**
 * buildKBContext — the shared summarizer extracted from 3 chat/explore copies. The two behaviour
 * differences the copies had are preserved as options; this pins both so the consolidation is proven
 * behaviour-preserving.
 */
import { describe, it, expect } from 'vitest';
import { buildKBContext } from '../kb-context';
import type { Statement } from '../types';

let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: o.startsWith('urn:') ? { kind: 'iri', value: o } : { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: extra.sourceId ?? 'x',
    confidence: 1,
    status: extra.status ?? 'confirmed',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HUB = 'urn:kbase:concept/hub';
const LEAF = 'urn:kbase:concept/leaf';
const P = 'urn:kbase:predicate/rel';

// hub has many edges (high degree); leaf has few. hub is typed, leaf is untyped.
const confirmed = [
  st(HUB, RDF_TYPE, 'urn:kbase:type/Thing'),
  st(HUB, P, 'urn:kbase:concept/a'),
  st(HUB, P, 'urn:kbase:concept/b'),
  st(HUB, P, 'urn:kbase:concept/c'),
  st(LEAF, P, 'one value'),
];
const typeLabelOf = (t: string) => (t === 'urn:kbase:type/Thing' ? 'Thing' : null);

describe('buildKBContext', () => {
  it('counts statements, sources, and manual statements', () => {
    const all = [...confirmed, st('urn:x', P, 'manual one', { sourceId: 'manual', status: 'confirmed' })];
    const ctx = buildKBContext({ confirmed, all, sourceCount: 2, typeLabelOf });
    expect(ctx.statementCount).toBe(confirmed.length);
    expect(ctx.sourceCount).toBe(2);
    expect(ctx.manualStatementCount).toBe(1);
    expect(ctx.typesPresent).toContain('Thing');
  });

  it('untyped-first by default (chat panels): the leaf outranks the typed hub', () => {
    const ctx = buildKBContext({ confirmed, all: confirmed, sourceCount: 1, typeLabelOf });
    expect(ctx.sampleEntities[0].iri).toBe(LEAF); // untyped comes first
    // default: no degree prefix, up to 4 predicates
    expect(ctx.sampleEntities.every((e) => !e.predicates.some((p) => p.startsWith('degree:')))).toBe(true);
  });

  it('hubFirst puts the high-degree hub first (ExplorePanel behaviour)', () => {
    const ctx = buildKBContext({ confirmed, all: confirmed, sourceCount: 1, typeLabelOf, hubFirst: true });
    expect(ctx.sampleEntities[0].iri).toBe(HUB); // degree wins over untyped
  });

  it('includeDegree prefixes each entity with degree:N (ExplorePanel behaviour)', () => {
    const ctx = buildKBContext({ confirmed, all: confirmed, sourceCount: 1, typeLabelOf, hubFirst: true, includeDegree: true });
    const hub = ctx.sampleEntities.find((e) => e.iri === HUB)!;
    expect(hub.predicates[0]).toMatch(/^degree:\d+$/);
  });
});
