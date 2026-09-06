/**
 * MAP LAYOUT — and the point of most of these is what it REFUSES to place.
 *
 * The timeline shipped a bug where undated nodes were placed at their ingestion time, which put 165
 * of 177 nodes in a wall at import day and crushed the real dates into a sliver. A map has the same
 * trap with a worse failure: a node defaulted to (0, 0) lands at Null Island in the Gulf of Guinea
 * and reads as a location the graph is asserting. So the assertions below are mostly about
 * `unplaced` staying a first-class answer.
 */
import { describe, it, expect } from 'vitest';
import {
  parseLatLon,
  statedCoordinates,
  placeNodes,
  buildMapLayout,
  mapExtent,
  mercatorY,
  mapCoverageSummary,
} from '../map-layout';
import type { Statement } from '../types';

const P = 'urn:kbase:predicate/';
const C = 'urn:kbase:concept/';

let seq = 0;
const st = (s: string, p: string, o: string, literal = true): Statement =>
  ({
    id: `m${seq++}`,
    s: { kind: 'iri', value: s.startsWith('urn:') ? s : C + s },
    p: { kind: 'iri', value: p.startsWith('urn:') ? p : P + p },
    o: literal ? { kind: 'literal', value: o } : { kind: 'iri', value: o.startsWith('urn:') ? o : C + o },
    g: { kind: 'iri', value: 'urn:kbase:source/x' },
    sourceId: 'x',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  }) as Statement;

describe('parseLatLon', () => {
  it('parses the format the shipped graphs actually use', () => {
    // static/knowledge.ttl and starter-everyday.ttl both store "lat, lon" as one literal.
    expect(parseLatLon('37.7716, -119.0715')).toEqual({ lat: 37.7716, lon: -119.0715 });
  });

  it('accepts the variants people paste from mapping tools', () => {
    expect(parseLatLon('37.7716,-119.0715')).toEqual({ lat: 37.7716, lon: -119.0715 });
    expect(parseLatLon('  37.7716 -119.0715 ')).toEqual({ lat: 37.7716, lon: -119.0715 });
    expect(parseLatLon('geo:37.7716,-119.0715')).toEqual({ lat: 37.7716, lon: -119.0715 });
    expect(parseLatLon('(37.7716, -119.0715)')).toEqual({ lat: 37.7716, lon: -119.0715 });
  });

  it('REFUSES degrees-minutes-seconds rather than half-parsing it', () => {
    // Guessing at a hemisphere letter risks silently flipping a sign, and a wrong coordinate is
    // worse than a missing one because it looks like knowledge.
    expect(parseLatLon(`40°26'46"N 79°58'56"W`)).toBeNull();
    expect(parseLatLon('37.7716 N, 119.0715 W')).toBeNull();
  });

  it('REFUSES out-of-range values instead of clamping them somewhere plausible', () => {
    expect(parseLatLon('200, 30')).toBeNull();
    expect(parseLatLon('45, 400')).toBeNull();
  });

  it('refuses anything that is not two numbers', () => {
    expect(parseLatLon('somewhere near the coast')).toBeNull();
    expect(parseLatLon('37.7716')).toBeNull();
    expect(parseLatLon('')).toBeNull();
    expect(parseLatLon('1, 2, 3')).toBeNull();
  });
});

describe('statedCoordinates', () => {
  it('reads a combined literal', () => {
    const got = statedCoordinates([st('beach', 'coordinates', '21.65, -87.05')]);
    expect(got.get(`${C}beach`)).toEqual({ lat: 21.65, lon: -87.05 });
  });

  it('reads split latitude/longitude predicates', () => {
    const got = statedCoordinates([st('beach', 'latitude', '21.65'), st('beach', 'longitude', '-87.05')]);
    expect(got.get(`${C}beach`)).toEqual({ lat: 21.65, lon: -87.05 });
  });

  it('requires BOTH halves — a lone latitude is a line, not a point', () => {
    const got = statedCoordinates([st('beach', 'latitude', '21.65')]);
    expect(got.size).toBe(0);
  });

  it('ignores rejected and superseded statements', () => {
    const rejected = { ...st('beach', 'coordinates', '21.65, -87.05'), status: 'rejected' } as Statement;
    expect(statedCoordinates([rejected]).size).toBe(0);
  });
});

describe('placeNodes — inheritance is one hop and clearly labelled', () => {
  const beach = st('tortuguero', 'coordinates', '10.54, -83.50');

  it('marks a stated coordinate as stated', () => {
    const p = placeNodes([beach]);
    expect(p.get(`${C}tortuguero`)?.origin).toBe('stated');
  });

  it('places a thing at the place it links to, and says the placement was inherited', () => {
    const p = placeNodes([beach, st('nesting-event', 'location', 'tortuguero', false)]);
    const ev = p.get(`${C}nesting-event`);
    expect(ev?.origin).toBe('inherited');
    expect(ev?.via).toBe(`${C}tortuguero`);
    expect(ev?.lat).toBeCloseTo(10.54);
  });

  it('a stated coordinate always beats an inherited one', () => {
    const p = placeNodes([
      beach,
      st('nesting-event', 'location', 'tortuguero', false),
      st('nesting-event', 'coordinates', '1.0, 2.0'),
    ]);
    expect(p.get(`${C}nesting-event`)?.origin).toBe('stated');
    expect(p.get(`${C}nesting-event`)?.lat).toBe(1.0);
  });

  it('does NOT chain transitively — a country centroid is a point nobody chose', () => {
    const p = placeNodes([
      beach,
      st('nesting-event', 'location', 'tortuguero', false),
      st('turtle-watch-trip', 'location', 'nesting-event', false),
    ]);
    expect(p.has(`${C}turtle-watch-trip`)).toBe(false);
  });
});

describe('buildMapLayout', () => {
  const graph = [
    st('tortuguero', 'coordinates', '10.54, -83.50'),
    st('ras-al-jinz', 'coordinates', '22.43, 59.83'),
    st('mon-repos', 'coordinates', '-24.80, 152.44'),
    st('a-turtle-fact', 'label', 'Turtles have existed for 200 million years'),
  ];

  it('places what it can and leaves the rest UNPLACED rather than at Null Island', () => {
    const l = buildMapLayout(graph);
    expect(l.anchors.size).toBe(3);
    expect(l.unplaced).toContain(`${C}a-turtle-fact`);
    // The critical assertion: nothing without coordinates got a position at all.
    expect(l.anchors.has(`${C}a-turtle-fact`)).toBe(false);
  });

  it('keeps east of west and north of south', () => {
    const l = buildMapLayout(graph);
    const tortuguero = l.anchors.get(`${C}tortuguero`)!; // lon -83
    const rasAlJinz = l.anchors.get(`${C}ras-al-jinz`)!; // lon +59
    const monRepos = l.anchors.get(`${C}mon-repos`)!; // lat -24, southernmost
    expect(tortuguero.x).toBeLessThan(rasAlJinz.x);
    expect(monRepos.y).toBeLessThan(tortuguero.y);
  });

  it('does not produce NaN for a SINGLE point — a zero-span extent is not a divisor', () => {
    // One node gives a zero-width and zero-height extent. Dividing by it yields Infinity and every
    // node lands at NaN, which a force simulation never recovers from.
    const l = buildMapLayout([st('only', 'coordinates', '10.54, -83.50')]);
    const a = l.anchors.get(`${C}only`)!;
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
  });

  it('does not produce NaN for points sharing one latitude', () => {
    const l = buildMapLayout([
      st('a', 'coordinates', '10.0, -80.0'),
      st('b', 'coordinates', '10.0, -70.0'),
    ]);
    for (const a of l.anchors.values()) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.y)).toBe(true);
    }
  });

  it('returns a null extent and no anchors when nothing has coordinates', () => {
    const l = buildMapLayout([st('fact', 'label', 'no location here')]);
    expect(l.extent).toBeNull();
    expect(l.anchors.size).toBe(0);
  });
});

describe('mercatorY', () => {
  it('is zero at the equator and increases northward', () => {
    expect(mercatorY(0)).toBeCloseTo(0);
    expect(mercatorY(45)).toBeGreaterThan(0);
    expect(mercatorY(-45)).toBeLessThan(0);
  });

  it('clamps at the poles, where the projection is undefined', () => {
    expect(Number.isFinite(mercatorY(90))).toBe(true);
    expect(Number.isFinite(mercatorY(-90))).toBe(true);
  });
});

describe('mapCoverageSummary — say it before the map looks broken', () => {
  it('says plainly when there is no location data', () => {
    const l = buildMapLayout([st('fact', 'label', 'x')]);
    expect(mapCoverageSummary(l)).toContain('no location data');
  });

  it('reports the fraction placed and how many were inferred', () => {
    const l = buildMapLayout([
      st('tortuguero', 'coordinates', '10.54, -83.50'),
      st('nesting', 'location', 'tortuguero', false),
      st('fact', 'label', 'x'),
    ]);
    const s = mapCoverageSummary(l);
    expect(s).toMatch(/2 of \d+ nodes placed/);
    expect(s).toContain('via a linked place');
  });

  it('handles an empty graph without dividing by zero', () => {
    expect(mapCoverageSummary(buildMapLayout([]))).toBe('nothing to place');
  });
});

describe('the antimeridian — found by the trans-Pacific turtle migrations', () => {
  const pacific = [
    st('japan', 'coordinates', '30.33, 130.50'),
    st('kuroshio', 'coordinates', '35.00, 160.00'),
    st('baja', 'coordinates', '26.00, -113.50'),
  ];

  it('takes the short way round instead of drawing back across Africa', () => {
    // Japan 130 to Baja -113 is 254 degrees the naive way and 106 across the Pacific. Without the
    // unwrap the loggerhead's route renders backwards through the wrong ocean.
    const extent = mapExtent(placeNodes(pacific))!;
    expect(extent.wrapped).toBe(true);
    expect(extent.maxLon - extent.minLon).toBeLessThan(180);
  });

  it('keeps the crossing in the right ORDER — Japan east, Baja west of it going forward', () => {
    const l = buildMapLayout(pacific);
    const at = (s: string) => l.anchors.get(`${C}${s}`)!.x;
    // Travelling east from Japan: Japan -> Kuroshio -> (dateline) -> Baja, monotonically.
    expect(at('japan')).toBeLessThan(at('kuroshio'));
    expect(at('kuroshio')).toBeLessThan(at('baja'));
  });

  it('leaves a normal extent alone', () => {
    // Two Costa Rican beaches must not be unwrapped — the naive span is already the short one.
    const extent = mapExtent(
      placeNodes([st('tortuguero', 'coordinates', '10.54, -83.50'), st('ostional', 'coordinates', '9.99, -85.70')]),
    )!;
    expect(extent.wrapped).toBeFalsy();
    expect(extent.minLon).toBeLessThan(0);
  });

  it('does not unwrap when the graph genuinely spans the globe', () => {
    // Points evenly spread give >180 either way; the wrap is not tighter, so it is not taken.
    const extent = mapExtent(
      placeNodes([
        st('a', 'coordinates', '0, -170'),
        st('b', 'coordinates', '0, -60'),
        st('c', 'coordinates', '0, 60'),
        st('d', 'coordinates', '0, 170'),
      ]),
    )!;
    expect(extent.wrapped).toBeFalsy();
  });
});
