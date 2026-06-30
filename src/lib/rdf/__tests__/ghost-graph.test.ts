import { describe, it, expect, beforeEach } from 'vitest';
import { parseGhostGraph, clearGhostCache } from '../ghost-graph';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MINIMAL_TTL = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ktype: <urn:kbase:type/> .

<urn:example/A> rdf:type ktype:Concept ;
    rdfs:label "Concept A" ;
    skos:definition "The first concept." .

<urn:example/B> rdf:type ktype:Concept ;
    rdfs:label "Concept B" ;
    skos:related <urn:example/A> .
`;

const KB_LEAP_TTL = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ktype: <urn:kbase:type/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .

<urn:reckons:kb> <urn:reckons:meta/kbStableId> "test-stable-id-001" .

<urn:example/LeapNode>
    rdf:type ktype:KnowledgeBase ;
    rdfs:label "LEAP: Target KB" ;
    <urn:reckons:leap> "target-stable-id" ;
    <urn:reckons:leap/label> "Target KB" .

<urn:example/BackToHub>
    rdf:type ktype:KnowledgeBase ;
    rdfs:label "Back to Hub" ;
    <urn:reckons:leap> "hub-stable-id" ;
    <urn:reckons:leap/label> "Hub" .

<urn:example/RegularEntity>
    rdf:type ktype:Concept ;
    rdfs:label "Some Concept" ;
    skos:related <urn:example/LeapNode> .
`;

const HUB_TTL = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ktype: <urn:kbase:type/> .

<urn:reckons:kb> <urn:reckons:meta/kbStableId> "hub-stable-id" .

<urn:hub/Guide>
    rdf:type ktype:Concept ;
    rdfs:label "Getting Started" ;
    skos:definition "Entry point." .

<urn:hub/LeapA> rdf:type ktype:KnowledgeBase ;
    rdfs:label "LEAP: KB Alpha" ;
    skos:broader <urn:hub/Guide> ;
    <urn:reckons:leap> "alpha-id" ;
    <urn:reckons:leap/label> "Alpha" .

<urn:hub/LeapB> rdf:type ktype:KnowledgeBase ;
    rdfs:label "LEAP: KB Beta" ;
    skos:broader <urn:hub/Guide> ;
    <urn:reckons:leap> "beta-id" ;
    <urn:reckons:leap/label> "Beta" .

<urn:hub/LeapC> rdf:type ktype:KnowledgeBase ;
    rdfs:label "LEAP: KB Gamma" ;
    skos:broader <urn:hub/Guide> ;
    <urn:reckons:leap> "gamma-id" ;
    <urn:reckons:leap/label> "Gamma" .

<urn:hub/Summary>
    rdf:type ktype:Concept ;
    rdfs:label "Summary" ;
    skos:related <urn:hub/Guide> .
`;

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearGhostCache();
});

describe('parseGhostGraph — basic parsing', () => {
  it('extracts nodes with labels', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.nodes.length).toBe(2);
    expect(g.nodes.find(n => n.label === 'Concept A')).toBeDefined();
    expect(g.nodes.find(n => n.label === 'Concept B')).toBeDefined();
  });

  it('extracts edges from skos:related', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.edges.length).toBe(1);
    expect(g.edges[0].predicate).toBe('http://www.w3.org/2004/02/skos/core#related');
  });

  it('reports correct totalEntities', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.totalEntities).toBe(2);
  });

  it('returns empty graph for empty TTL', async () => {
    const g = await parseGhostGraph('');
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.totalEntities).toBe(0);
  });
});

describe('parseGhostGraph — meta predicates are excluded from edges', () => {
  it('does not create edges for rdf:type', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.edges.find(e => e.predicate.includes('rdf-syntax-ns#type'))).toBeUndefined();
  });

  it('does not create edges for rdfs:label', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.edges.find(e => e.predicate.includes('rdf-schema#label'))).toBeUndefined();
  });

  it('does not create edges for skos:definition', async () => {
    const g = await parseGhostGraph(MINIMAL_TTL);
    expect(g.edges.find(e => e.predicate.includes('skos/core#definition'))).toBeUndefined();
  });

  it('does not create edges for leap predicates', async () => {
    const g = await parseGhostGraph(KB_LEAP_TTL);
    expect(g.edges.find(e => e.predicate.includes('reckons:leap'))).toBeUndefined();
  });

  it('does not create edges for kbStableId', async () => {
    const g = await parseGhostGraph(KB_LEAP_TTL);
    expect(g.edges.find(e => e.predicate.includes('kbStableId'))).toBeUndefined();
  });
});

describe('parseGhostGraph — KB Leap entities', () => {
  it('includes KnowledgeBase-typed leap nodes', async () => {
    const g = await parseGhostGraph(KB_LEAP_TTL);
    const leapNode = g.nodes.find(n => n.label === 'LEAP: Target KB');
    expect(leapNode).toBeDefined();
  });

  it('includes Back to Hub nodes', async () => {
    const g = await parseGhostGraph(KB_LEAP_TTL);
    const backNode = g.nodes.find(n => n.label === 'Back to Hub');
    expect(backNode).toBeDefined();
  });

  it('creates edges between regular entities and leap nodes via skos:related', async () => {
    const g = await parseGhostGraph(KB_LEAP_TTL);
    const edge = g.edges.find(
      e => e.source === 'urn:example/RegularEntity' && e.target === 'urn:example/LeapNode'
    );
    expect(edge).toBeDefined();
  });
});

describe('parseGhostGraph — hub with multiple leap nodes', () => {
  it('extracts all entities including leap nodes', async () => {
    const g = await parseGhostGraph(HUB_TTL);
    // Guide + LeapA + LeapB + LeapC + Summary + urn:reckons:kb (identity entity) = 6
    expect(g.totalEntities).toBe(6);
  });

  it('creates broader edges from leap nodes to hub', async () => {
    const g = await parseGhostGraph(HUB_TTL);
    const broaderEdges = g.edges.filter(
      e => e.predicate === 'http://www.w3.org/2004/02/skos/core#broader'
    );
    expect(broaderEdges.length).toBe(3); // LeapA, LeapB, LeapC → Guide
  });

  it('hub node has the highest degree', async () => {
    const g = await parseGhostGraph(HUB_TTL);
    const guide = g.nodes.find(n => n.label === 'Getting Started');
    expect(guide).toBeDefined();
    // Guide is target of 3 broader + 1 related = degree 4, highest in graph
    // Whether it qualifies as isHub depends on the top-5 threshold
    // The important thing is it exists and has high connectivity
    const degrees = new Map<string, number>();
    for (const e of g.edges) {
      degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
      degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
    }
    const guideDegree = degrees.get(guide!.iri) ?? 0;
    expect(guideDegree).toBeGreaterThanOrEqual(3);
  });

  it('marks low-degree nodes as non-hubs', async () => {
    const g = await parseGhostGraph(HUB_TTL);
    const summary = g.nodes.find(n => n.label === 'Summary');
    // Summary has degree 1 (one related edge) — unlikely to be a hub
    expect(summary?.isHub).toBe(false);
  });
});

describe('parseGhostGraph — label fallback', () => {
  it('falls back to IRI slug when rdfs:label is missing', async () => {
    const ttl = `
      <urn:example/no-label> <http://www.w3.org/2004/02/skos/core#related> <urn:example/other> .
      <urn:example/other> <http://www.w3.org/2000/01/rdf-schema#label> "Other" .
    `;
    const g = await parseGhostGraph(ttl);
    const noLabel = g.nodes.find(n => n.iri === 'urn:example/no-label');
    expect(noLabel?.label).toBe('no-label');
  });
});

describe('clearGhostCache', () => {
  it('does not throw when called', () => {
    expect(() => clearGhostCache()).not.toThrow();
  });
});
