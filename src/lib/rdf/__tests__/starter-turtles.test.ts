/**
 * THE SHIPPED STARTER GRAPH AND THE USER-PATHS DOC, ASSERTED.
 *
 * Both are DATA rather than code, which is exactly why they need a test: nothing else fails when a
 * hand-edited TTL file drifts. Two real defects from the session that created them are pinned here.
 *
 *  1. The user-paths graph referenced feat:CompareDiff, feat:KnowledgeGraph, feat:MultiGraph and
 *     feat:SourceTrust — FOUR dead links, because the names were guessed instead of looked up. A
 *     cross-reference to a feature that does not exist makes the document worse than no document,
 *     since it reads as authoritative.
 *  2. The turtle story used `kpred:` where the file declares `p:`, so the whole graph failed to
 *     parse. graph-lint catches that; this suite catches it in the same run as everything else.
 *
 * The turtle assertions are about SHAPE, not content — that the taxonomy really is a tree, that
 * coordinates really place, that the story really moves between layouts. Those are the properties
 * the graph exists to demonstrate, so they are what a regression would destroy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Parser } from 'n3';
import { buildHierarchy } from '../hierarchy';
import { buildMapLayout, mapCoverageSummary } from '../map-layout';
import type { Statement } from '../types';

const TURTLES = 'static/starter-turtles.ttl';
const PATHS = 'static/docs-user-paths.ttl';
const FEATURES = 'static/docs-features.ttl';

/** n3's Quad is a namespace rather than a type here, so the shape is named locally. */
type ParsedQuad = {
  subject: { value: string; termType: string };
  predicate: { value: string };
  object: { value: string; termType: string };
};

const parse = (file: string): ParsedQuad[] =>
  new Parser().parse(readFileSync(file, 'utf8')) as unknown as ParsedQuad[];

describe('starter-turtles.ttl — the beginner graph', () => {
  it('parses', () => {
    expect(parse(TURTLES).length).toBeGreaterThan(200);
  });

  it('is a single-rooted taxonomy four levels deep — the point of the hierarchy step', () => {
    const roots = buildHierarchy(statements());
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('Testudines');

    const depth = (n: { children?: unknown[] }): number =>
      1 + Math.max(0, ...((n.children ?? []) as { children?: unknown[] }[]).map(depth));
    // order -> suborder -> family -> species
    expect(depth(roots[0])).toBe(4);
  });

  it('places nodes on a map, with some inherited from a linked beach', () => {
    const layout = buildMapLayout(statements());
    expect(layout.anchors.size).toBeGreaterThanOrEqual(8);
    expect(layout.inheritedCount).toBeGreaterThan(0);
    expect(mapCoverageSummary(layout)).toContain('via a linked place');
  });

  it('puts the Costa Rican beaches near each other and Australia far east', () => {
    // A projection bug that transposed lat/lon would still "place" everything; only relative
    // geography catches it.
    const layout = buildMapLayout(statements());
    const at = (slug: string) => layout.anchors.get(`urn:kbase:concept/${slug}`)!;
    expect(at('tortuguero')).toBeDefined();
    expect(Math.abs(at('tortuguero').x - at('ostional').x)).toBeLessThan(3);
    expect(at('mon-repos').x).toBeGreaterThan(at('zakynthos').x);
    expect(at('mon-repos').y).toBeLessThan(at('tortuguero').y);
  });

  it('has an eight-step story that moves between at least four layouts', () => {
    const quads = parse(TURTLES);
    const steps = quads.filter((q) => q.object.value === 'urn:reckons:story/Step');
    expect(steps).toHaveLength(8);

    const layouts = new Set(
      quads.filter((q) => q.predicate.value === 'urn:reckons:story/layout').map((q) => q.object.value),
    );
    // The graph's whole reason to exist is that different questions want different views.
    expect(layouts.size).toBeGreaterThanOrEqual(4);
    expect(layouts.has('hierarchy')).toBe(true);
    expect(layouts.has('timeline')).toBe(true);
  });

  it('NAMES ONLY LAYOUTS PRODUCTION ACTUALLY SHIPS', () => {
    /*
     * This graph is handed to people to import into reckons.ai. A story:layout naming something
     * production does not have silently does nothing, and a step that does nothing reads as a
     * broken story rather than as an unreleased feature. `map` is built locally and NOT deployed,
     * which is why step 3 says 'focus' and carries p:pending-layout instead.
     *
     * When kb:map-layout ships, add 'map' here in the same commit that changes the step.
     */
    const shipped = ['force', 'focus', 'source', 'type', 'hub', 'timeline', 'order', 'hierarchy'];
    const used = [
      ...new Set(
        parse(TURTLES)
          .filter((q) => q.predicate.value === 'urn:reckons:story/layout')
          .map((q) => q.object.value),
      ),
    ];
    const unshipped = used.filter((l) => !shipped.includes(l));
    expect(unshipped, `story names unreleased layouts: ${unshipped.join(', ')}`).toEqual([]);
  });

  it('ends on an open question rather than a summary', () => {
    const quads = parse(TURTLES);
    const open = quads.filter((q) => q.predicate.value === 'urn:kbase:predicate/open-question');
    // A tutorial that only shows answers teaches the opposite of this project's thesis.
    expect(open.length).toBeGreaterThanOrEqual(2);
  });

  it('sources its claims', () => {
    const quads = parse(TURTLES);
    const sourced = quads.filter((q) => q.predicate.value === 'urn:kbase:predicate/source');
    expect(sourced.length).toBeGreaterThanOrEqual(8);
  });
});

describe('docs-user-paths.ttl — every cross-reference resolves', () => {
  it('parses', () => {
    expect(parse(PATHS).length).toBeGreaterThan(100);
  });

  it('names at least five paths', () => {
    const quads = parse(PATHS);
    const paths = quads.filter(
      (q) => q.predicate.value.endsWith('core#broader') && q.object.value === 'urn:reckons:path/UserPaths',
    );
    expect(paths.length).toBeGreaterThanOrEqual(5);
  });

  it('EVERY kpred:uses points at a feature that actually exists', () => {
    // The bug this pins: four of eleven were dead on the first pass, guessed rather than looked up.
    const featureIris = new Set(
      parse(FEATURES)
        .map((q) => q.subject.value)
        .filter((v) => v.startsWith('urn:reckons:feature/')),
    );
    const used = [
      ...new Set(
        parse(PATHS)
          .filter((q) => q.predicate.value === 'urn:kbase:predicate/uses')
          .map((q) => q.object.value),
      ),
    ];
    expect(used.length).toBeGreaterThan(0);
    const dead = used.filter((u) => !featureIris.has(u));
    expect(dead, `dead feature references: ${dead.join(', ')}`).toEqual([]);
  });

  it('every path admits its own status', () => {
    // kb:honest-status: a journey doc describing a frictionless flow that does not exist is the
    // most expensive lie available here, because someone will follow it.
    const quads = parse(PATHS);
    const paths = quads
      .filter((q) => q.predicate.value.endsWith('core#broader') && q.object.value === 'urn:reckons:path/UserPaths')
      .map((q) => q.subject.value)
      // The overlap node is commentary, not a journey, so it carries no status.
      .filter((iri) => !iri.endsWith('PathsOverlap'));

    const withStatus = new Set(
      quads.filter((q) => q.predicate.value === 'urn:kbase:predicate/has-status').map((q) => q.subject.value),
    );
    const withNote = new Set(
      quads.filter((q) => q.predicate.value === 'urn:kbase:predicate/honest-note').map((q) => q.subject.value),
    );
    for (const p of paths) {
      expect(withStatus.has(p), `${p} has no has-status`).toBe(true);
      expect(withNote.has(p), `${p} has no honest-note`).toBe(true);
    }
  });
});

/**
 * The turtle graph as Statements.
 *
 * Built straight from the parsed quads rather than through importTurtleFull, which is async and
 * would make every assertion here a promise for no gain: this file is plain Turtle with no
 * reification, so the importer's only contribution would be minting ids. Cached because six tests
 * read the same file.
 */
function statements(): Statement[] {
  if (!cached) {
    cached = parse(TURTLES).map((q, i) => ({
      id: `t${i}`,
      s: { kind: 'iri', value: q.subject.value },
      p: { kind: 'iri', value: q.predicate.value },
      o: q.object.termType === 'Literal'
        ? { kind: 'literal', value: q.object.value }
        : { kind: 'iri', value: q.object.value },
      g: { kind: 'iri', value: 'urn:kbase:source/starter-turtles' },
      sourceId: 'starter-turtles',
      status: 'confirmed',
      createdAt: i,
      updatedAt: i,
    })) as Statement[];
  }
  return cached;
}
let cached: Statement[] | null = null;
