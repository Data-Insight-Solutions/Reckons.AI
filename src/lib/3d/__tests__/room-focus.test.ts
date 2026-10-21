import { describe, it, expect } from 'vitest';
import {
  scaleFromSlider, sliderFromScale, roomCentreWorld, rayToRoomLocal, pickOnRay, formatFocal, SCALE_LOG_MIN, SCALE_LOG_MAX,
} from '../room-focus';
import { backgroundSettingsFrom, BG_FOCAL_PREDICATE, SPACE_SUBJECT, placementWorld, type Vec3 } from '../splat';
import { layoutSpread, formatSpread } from '../layout-metrics';
import type { Statement } from '$lib/rdf/types';

const meta = (p: string, v: string): Statement => ({
  id: p + v, s: { kind: 'iri', value: SPACE_SUBJECT }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: v },
  g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: 1, updatedAt: 1,
} as Statement);

describe('log scale slider', () => {
  it('covers 0.001 to 1000 with the same travel per decade', () => {
    expect(scaleFromSlider(0)).toBe(0.001);
    expect(scaleFromSlider(1)).toBe(1000);
    expect(scaleFromSlider(0.5)).toBe(1);
    expect(scaleFromSlider(1 / 6)).toBe(0.01);
    expect(SCALE_LOG_MAX - SCALE_LOG_MIN).toBe(6);
  });
  it('round-trips, and clamps what is out of range', () => {
    for (const s of [0.001, 0.05, 0.4, 1, 3.8, 26, 1000]) expect(scaleFromSlider(sliderFromScale(s))).toBeCloseTo(s, 2);
    expect(sliderFromScale(1e9)).toBe(1);
    expect(sliderFromScale(0)).toBe(0);
    expect(scaleFromSlider(-3)).toBe(0.001);
    expect(scaleFromSlider(7)).toBe(1000);
  });
});

describe('focal point as an offset', () => {
  it('with no focal point the room sits at the graph centre plus the offset, as before', () => {
    expect(roomCentreWorld([1, 2, 3], [0.5, 0, -1], [0, 0, 0], 10, 40)).toEqual([1.5, 2, 2]);
  });
  it('puts the focal point at the graph centre: the room shifts the opposite way, scaled', () => {
    const c = roomCentreWorld([0, 0, 0], [0, 0, 0], [2, 1, -3], 10, 0);
    expect(c[0]).toBeCloseTo(-20); expect(c[1]).toBeCloseTo(-10); expect(c[2]).toBeCloseTo(30);
  });
  it('the focal point lands on the graph centre whatever the yaw', () => {
    const focal: Vec3 = [1.5, 0.5, -2];
    for (const yaw of [0, 33, 90, -140]) {
      const centre = roomCentreWorld([4, 1, -2], [0, 0, 0], focal, 6, yaw);
      // The room's own placement maths: a point at `focal` in room units is where in the world?
      const w = placementWorld({ at: focal, scale: 1, yaw: 0 }, { centre, scale: 6, yaw }).pos;
      expect(w[0]).toBeCloseTo(4); expect(w[1]).toBeCloseTo(1); expect(w[2]).toBeCloseTo(-2);
    }
  });
  it('is read from the space meta triple, defaulting to the room centre, and ignores malformed text', () => {
    expect(backgroundSettingsFrom([]).focal).toEqual([0, 0, 0]);
    expect(backgroundSettingsFrom([meta(BG_FOCAL_PREDICATE, formatFocal([1.2345678, -2, 0.5]))]).focal).toEqual([1.235, -2, 0.5]);
    expect(backgroundSettingsFrom([meta(BG_FOCAL_PREDICATE, 'left of the sofa')]).focal).toEqual([0, 0, 0]);
  });
});

describe('picking the focal point', () => {
  // A wall of points at z = -5 (x, y from -2 to 2), and a floor at y = -2.
  const wall: number[] = [];
  for (let x = -2; x <= 2; x += 0.1) for (let y = -2; y <= 2; y += 0.1) wall.push(x, y, -5);

  it('hits the surface under the ray, not a point behind or beside it', () => {
    const hit = pickOnRay(wall, [0, 0, 0], [0.2 / 5, 0.5 / 5, -1], -2)!;
    expect(hit.hit).toBe('splat');
    expect(hit.point[2]).toBeCloseTo(-5, 0);
    expect(hit.point[0]).toBeCloseTo(0.2, 0);
    expect(hit.point[1]).toBeCloseTo(0.5, 0);
  });
  it('takes the nearest surface when two lie on the ray, ignoring a lone floater in front', () => {
    const pts = [...wall];
    for (let x = -2; x <= 2; x += 0.04) for (let y = -2; y <= 2; y += 0.04) pts.push(x, y, -3); // a nearer, denser surface
    pts.push(0, 0, -1); // one floater
    const hit = pickOnRay(pts, [0, 0, 0], [0, 0, -1], -2)!;
    expect(hit.point[2]).toBeCloseTo(-3, 0);
  });
  it('falls back to the floor plane when nothing is under the click, and says so', () => {
    const hit = pickOnRay(wall, [0, 1, 0], [0, -1, -1], -2)!; // aimed below the wall's points
    expect(hit.hit).toBe('plane');
    expect(hit.point[1]).toBe(-2);
    expect(hit.point[2]).toBeCloseTo(-3);
  });
  it('refuses a floor-plane pick that lands far outside the room', () => {
    // A shallow ray meets the plane 400 units away: not a pick when the room is 10 across.
    expect(pickOnRay([], [0, 1, 0], [0, -0.0025, -1], -2, 0.03, 15)).toBeNull();
    expect(pickOnRay([], [0, 1, 0], [0, -1, -1], -2, 0.03, 15)!.hit).toBe('plane');
  });
  it('returns null looking up with nothing there', () => {
    expect(pickOnRay(wall, [0, 0, 0], [0, 1, 0.01], -2)).toBeNull();
    expect(pickOnRay(wall, [0, 0, 0], [0, 0, 0], -2)).toBeNull();
  });
  it('brings a world ray into room units, undoing the yaw, scale and centre', () => {
    const r = rayToRoomLocal([10, 0, 0], [1, 0, 0], { centre: [0, 0, 0], scale: 5, yaw: 90 });
    expect(r.origin[0]).toBeCloseTo(0, 5);
    expect(r.origin[2]).toBeCloseTo(2, 5); // 10 world units along +x, turned back by 90 degrees, over a scale of 5
    const picked = pickOnRay(wall, [0, 0, 0], [0, 0, -1], 0)!;
    expect(picked.hit).toBe('splat');
  });
});

describe('layout spread metrics', () => {
  it('mean nearest-neighbour distance and overlap count, by hand', () => {
    const pts = [
      { x: 0, y: 0, z: 0, r: 0.5 }, { x: 1, y: 0, z: 0, r: 0.5 }, // 1 apart, touching but not overlapping (1 < 1 is false)
      { x: 10, y: 0, z: 0, r: 0.5 },
    ];
    const s = layoutSpread(pts);
    expect(s.meanNearest).toBeCloseTo((1 + 1 + 9) / 3);
    expect(s.overlaps).toBe(0);
    expect(layoutSpread([{ x: 0, y: 0, z: 0, r: 0.6 }, { x: 1, y: 0, z: 0, r: 0.6 }]).overlaps).toBe(1);
    expect(formatSpread(s)).toBe('n=3 nn=3.667 overlap=0');
  });
  it('a single node or none has nothing to measure', () => {
    expect(layoutSpread([])).toEqual({ n: 0, meanNearest: 0, overlaps: 0 });
    expect(layoutSpread([{ x: 1, y: 1, z: 1, r: 1 }]).meanNearest).toBe(0);
  });
});
