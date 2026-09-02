/**
 * F136.3 structural grounding — let a new fact know what the graph already depends on, at the
 * moment it is defined.
 *
 * The point is dependency quality: the F139 tree RANKS by dependency, so a fabricated edge is worse
 * than a missing one. Most of these tests are therefore about what gets dropped, and about the one
 * distinction that keeps grounding from becoming a cage — a reference to something this batch
 * introduced is legitimate; a reference to something that exists nowhere is invented.
 */
import { describe, it, expect } from 'vitest';
import {
  selectStructuralContext, buildStructuralSection, validateStructuralClaims, structuralSummary,
  STRUCTURAL_PREDICATES,
} from '../structural-context';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;
function st(s: string, p: string, o: string, literal = true, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: literal ? { kind: 'literal', value: o } : { kind: 'iri', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'confirmed',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

const SETS = 'urn:kbase:concept/entity-sets';
const LEGIBILITY = 'urn:kbase:concept/graph-legibility';
const NVIDIA = 'urn:kbase:concept/nvidia-nemo';

const graph = [
  st(SETS, RDFS_LABEL, 'Entity sets (multi-entity groupings)'),
  st(SETS, `${KPRED}has-status`, 'functional'),
  st(SETS, `${KPRED}depends-on`, LEGIBILITY, false),
  st(SETS, `${KPRED}open-question`, 'Storage: is a set a first-class node, or a saved selection?'),
  st(LEGIBILITY, RDFS_LABEL, 'Graph legibility'),
  st(LEGIBILITY, `${KPRED}has-status`, 'in-progress'),
  st(NVIDIA, RDFS_LABEL, 'NVIDIA NeMo Speech'),
  st(NVIDIA, `${KPRED}has-status`, 'speculative'),
];

describe('selectStructuralContext', () => {
  it('offers existing entities with their REAL dependency edges', () => {
    const ctx = selectStructuralContext(graph, { sourceText: 'entity sets and grouping' });
    const sets = ctx.anchors.find((a) => a.slug === 'entity-sets');
    expect(sets).toBeDefined();
    expect(sets!.dependsOn).toEqual(['graph-legibility']);
    expect(sets!.status).toBe('functional');
  });

  it('ranks by overlap with the source text, not by degree', () => {
    // NVIDIA has fewer facts than entity-sets, but the text is about it — a fact should attach to
    // what the document is about, not to whatever the biggest hub happens to be.
    const ctx = selectStructuralContext(graph, { sourceText: 'NVIDIA NeMo speech transcription' });
    expect(ctx.anchors[0].slug).toBe('nvidia-nemo');
  });

  it('surfaces OPEN questions so a new fact can attach to one', () => {
    const ctx = selectStructuralContext(graph, { sourceText: 'sets storage' });
    expect(ctx.openDecisions).toHaveLength(1);
    expect(ctx.openDecisions[0].slug).toBe('entity-sets');
    expect(ctx.openDecisions[0].question).toContain('first-class node');
  });

  it('RANKS open questions by relevance and drops irrelevant ones — regression, 2026-08-19', () => {
    // The first version took the first N in DOCUMENT order. Observed against the real roadmap: a
    // text about Set View was offered the open questions about NVIDIA NeMo sidecars, Cosmos GPU
    // requirements and Facebook's deprecated API. That is F136's own warning — the wrong subset is
    // worse than no grounding, because an irrelevant question invites the model to attach to it.
    const withIrrelevant = [
      st(NVIDIA, `${KPRED}open-question`, 'Sidecar architecture: Docker Compose or FastAPI?'),
      ...graph,
    ];
    const ctx = selectStructuralContext(withIrrelevant, { sourceText: 'entity sets storage grouping' });
    expect(ctx.openDecisions.map((d) => d.slug)).toEqual(['entity-sets']);
  });

  it('offers no questions rather than padding with irrelevant ones', () => {
    const ctx = selectStructuralContext(graph, { sourceText: 'completely unrelated subject matter' });
    expect(ctx.openDecisions).toEqual([]);
  });

  it('matches a question against its subject label too, not only its own words', () => {
    // A question phrased in different words than the feature it hangs off is still about it.
    const ctx = selectStructuralContext(graph, { sourceText: 'multi-entity groupings' });
    expect(ctx.openDecisions.map((d) => d.slug)).toContain('entity-sets');
  });

  it('skips unlabelled stubs — attaching to one teaches nothing', () => {
    const withStub = [...graph, st('urn:kbase:concept/mystery', `${KPRED}note`, 'no label here')];
    const ctx = selectStructuralContext(withStub, { sourceText: 'mystery' });
    expect(ctx.anchors.map((a) => a.slug)).not.toContain('mystery');
    // It is still a KNOWN slug, so a dependency on it is not treated as invented.
    expect(ctx.knownSlugs.has('mystery')).toBe(true);
  });

  it('ignores rejected and superseded facts', () => {
    const withDead = [
      st('urn:kbase:concept/dropped', RDFS_LABEL, 'Dropped idea', true, { status: 'rejected' }),
    ];
    expect(selectStructuralContext(withDead).anchors).toHaveLength(0);
  });

  it('respects the budgets so a small model is not buried', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      st(`urn:kbase:concept/f${i}`, RDFS_LABEL, `Feature ${i}`),
    );
    expect(selectStructuralContext(many, { anchorBudget: 5 }).anchors).toHaveLength(5);
  });
});

describe('buildStructuralSection', () => {
  it('states what exists, its dependencies, and the open questions', () => {
    const section = buildStructuralSection(selectStructuralContext(graph, { sourceText: 'entity sets' }));
    expect(section).toContain('entity-sets');
    expect(section).toContain('depends-on graph-legibility');
    expect(section).toContain('status functional');
    expect(section).toContain('first-class node');
  });

  it('is PERMISSIVE, not imperative — grounding must not become a cage', () => {
    const section = buildStructuralSection(selectStructuralContext(graph, { sourceText: 'sets' }));
    // Minting a new subject stays explicitly available; a fabricated edge is believed, a missing
    // one is recoverable.
    expect(section).toContain('Minting a new');
    expect(section).toContain('Only when the text says so.');
  });

  it('is EMPTY for a first ingest, so an empty graph pays nothing', () => {
    expect(buildStructuralSection(selectStructuralContext([]))).toBe('');
  });
});

describe('validateStructuralClaims — a fabricated edge would mis-rank the tree', () => {
  const ctx = selectStructuralContext(graph, { sourceText: 'entity sets' });
  const triple = (subject: string, predicate: string, object: string, objectIsLiteral = false) => ({
    subject, predicate, object, objectIsLiteral,
  });

  it('keeps a dependency on something already in the graph', () => {
    const out = validateStructuralClaims([triple('set-view', 'depends-on', 'entity-sets')], ctx);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it('keeps a dependency on something THIS BATCH introduced — new structure must be expressible', () => {
    const out = validateStructuralClaims(
      [
        triple('brand-new-thing', 'has-status', 'planned', true),
        triple('another-new-thing', 'depends-on', 'brand-new-thing'),
      ],
      ctx,
    );
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });

  it('DROPS a dependency on something that exists nowhere', () => {
    const out = validateStructuralClaims([triple('entity-sets', 'depends-on', 'imaginary-feature')], ctx);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped[0].reason).toContain('exists neither in the graph nor in this batch');
    expect(out.dropped[0].reason).toContain('mis-rank the review tree');
  });

  it('DROPS a structural relation pointing at a literal — structure links things, not strings', () => {
    const out = validateStructuralClaims([triple('entity-sets', 'depends-on', 'some prose', true)], ctx);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped[0].reason).toContain('structure links entities, not strings');
  });

  it('leaves DESCRIPTIVE triples alone — an odd object there is a content question, not a shape defect', () => {
    const out = validateStructuralClaims([triple('entity-sets', 'has-status', 'whatever', true)], ctx);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it('accepts the kpred: prefixed form as well as the bare slug', () => {
    const out = validateStructuralClaims([triple('x', 'kpred:depends-on', 'imaginary')], ctx);
    expect(out.dropped).toHaveLength(1);
  });

  it('checks every structural predicate the tree reads', () => {
    for (const pred of STRUCTURAL_PREDICATES) {
      const out = validateStructuralClaims([triple('x', pred, 'imaginary')], ctx);
      expect(out.dropped, `${pred} should be validated`).toHaveLength(1);
    }
  });
});

describe('structuralSummary', () => {
  it('is honest when there is nothing to offer', () => {
    expect(structuralSummary(selectStructuralContext([]))).toContain('first ingest');
  });

  it('reports what was grounded and what was caught', () => {
    const ctx = selectStructuralContext(graph, { sourceText: 'entity sets' });
    const v = validateStructuralClaims(
      [{ subject: 'x', predicate: 'depends-on', object: 'imaginary', objectIsLiteral: false }],
      ctx,
    );
    const s = structuralSummary(ctx, v);
    expect(s).toContain('existing entit');
    expect(s).toContain('1 invented dependency dropped');
  });
});
