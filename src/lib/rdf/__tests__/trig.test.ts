/**
 * TriG export (F75) — the format that does not throw provenance away.
 *
 * The app's data model says the graph term IS the provenance ("which document, which URL,
 * when it was learned"). Turtle cannot carry a graph term, so toTurtle DROPS it: ingest
 * five PDFs, build a graph, export it, and "where did this fact come from?" becomes
 * unanswerable — which for a product whose pitch is provenance is not a small thing.
 *
 * The test that matters is the ROUND TRIP: parse our own output back and check the source
 * survived. Anything less is checking that we can write text.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { toTriG, toTurtle } from '../serialize';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const SRC_A = 'urn:kbase:source/paper-a';
const SRC_B = 'urn:kbase:source/paper-b';

let n = 0;
const st = (subject: string, object: string, graph: string): Statement => ({
  id: `s${++n}`,
  s: iri(`urn:kbase:concept/${subject}`),
  p: iri('urn:kbase:predicate/states'),
  o: lit(object),
  g: iri(graph),
  sourceId: graph,
  confidence: 1,
  status: 'confirmed',
  createdAt: 0,
  updatedAt: 0,
});

const facts = [
  st('climate', 'warming is accelerating', SRC_A),
  st('climate', 'sea level is rising', SRC_A),
  st('economy', 'inflation eased', SRC_B),
];

describe('toTriG', () => {
  it('emits one named graph per SOURCE', () => {
    const trig = toTriG(facts);
    expect(trig).toContain('src:paper-a {');
    expect(trig).toContain('src:paper-b {');
  });

  it('is valid TriG — a reference parser accepts it', () => {
    expect(() => new Parser({ format: 'TriG' }).parse(toTriG(facts))).not.toThrow();
  });

  it('ROUND-TRIPS provenance: every fact still knows which source it came from', () => {
    const quads = new Parser({ format: 'TriG' }).parse(toTriG(facts));

    expect(quads).toHaveLength(3);
    const bySource = new Map<string, string[]>();
    for (const q of quads) {
      const list = bySource.get(q.graph.value) ?? [];
      list.push(q.object.value);
      bySource.set(q.graph.value, list);
    }

    expect(bySource.get(SRC_A)).toEqual(
      expect.arrayContaining(['warming is accelerating', 'sea level is rising']),
    );
    expect(bySource.get(SRC_B)).toEqual(['inflation eased']);
  });

  it('toTurtle CANNOT do this — the graph term is gone (the bug TriG exists to fix)', () => {
    // Not a criticism of the Turtle serializer: Turtle is a triples-only format and
    // structurally has nowhere to put `g`. This test pins the LOSS so nobody mistakes
    // toTurtle for a lossless export.
    const quads = new Parser({ format: 'TriG' }).parse(
      toTurtle(facts, { includeProvenance: false }),
    );
    expect(quads).toHaveLength(3);
    // Every quad landed in the DEFAULT graph. The sources did not survive.
    expect(new Set(quads.map((q: (typeof quads)[number]) => q.graph.value))).toEqual(
      new Set(['']),
    );
  });

  it('filters by status when asked', () => {
    const mixed = [...facts, { ...st('x', 'unreviewed', SRC_A), status: 'pending' as const }];
    const trig = toTriG(mixed, { includeStatuses: ['confirmed'] });
    expect(trig).not.toContain('unreviewed');
  });

  it('handles an empty graph without emitting garbage', () => {
    expect(() => new Parser({ format: 'TriG' }).parse(toTriG([]))).not.toThrow();
  });
});
