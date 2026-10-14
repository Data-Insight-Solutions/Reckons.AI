/**
 * F58.9.8: background settings are meta triples with defaults; the up axis, level and yaw compose
 * into one rotation; Level the floor recovers a known tilt from synthetic points.
 */
import { describe, it, expect } from 'vitest';
import {
  backgroundSettingsFrom, backgroundQuaternion, upAxisQuaternion, qRotate, qBetween, qAboutY, fitFloor, levelQuaternion, rotatePoints,
  BACKGROUND_DEFAULTS, SPACE_SUBJECT, BG_MODE_PREDICATE, BG_UP_PREDICATE, BG_YAW_PREDICATE, BG_SCALE_PREDICATE, BG_OFFSET_PREDICATE,
  BG_OPACITY_PREDICATE, BG_LEVEL_PREDICATE, BG_EXTENT_PREDICATE, UP_AXES, type Vec3, type Quat,
} from '../splat';
import type { Statement } from '../../rdf/types';

const meta = (p: string, v: string, o: Partial<Statement> = {}): Statement => ({
  id: p + v, s: { kind: 'iri', value: SPACE_SUBJECT }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: v },
  g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: 1, updatedAt: 1, ...o,
});
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => { for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps); };

describe('backgroundSettingsFrom', () => {
  it('is the F58.9.3 behaviour when nothing is set', () => {
    expect(backgroundSettingsFrom([])).toEqual(BACKGROUND_DEFAULTS);
  });

  it('reads each setting and the newest live value wins', () => {
    const s = backgroundSettingsFrom([
      meta(BG_MODE_PREDICATE, 'surround'), meta(BG_UP_PREDICATE, '-y'), meta(BG_YAW_PREDICATE, '30'),
      meta(BG_SCALE_PREDICATE, '2', { updatedAt: 1 }), meta(BG_SCALE_PREDICATE, '3', { updatedAt: 5 }),
      meta(BG_SCALE_PREDICATE, '9', { updatedAt: 9, status: 'rejected' }),
      meta(BG_OFFSET_PREDICATE, '1 2 3'), meta(BG_OPACITY_PREDICATE, '0.25'), meta(BG_LEVEL_PREDICATE, '0 0 0 2'),
    ]);
    expect(s).toMatchObject({ mode: 'surround', up: '-y', yaw: 30, scale: 3, offset: [1, 2, 3], opacity: 0.25 });
    expect(s.level).toEqual([0, 0, 0, 1]); // normalised
  });

  it('falls back on malformed values instead of throwing', () => {
    const s = backgroundSettingsFrom([
      meta(BG_MODE_PREDICATE, 'orbit'), meta(BG_UP_PREDICATE, 'sideways'), meta(BG_YAW_PREDICATE, 'abc'), meta(BG_SCALE_PREDICATE, '-4'),
      meta(BG_OFFSET_PREDICATE, '1 2'), meta(BG_OPACITY_PREDICATE, '7'), meta(BG_LEVEL_PREDICATE, 'x'),
    ]);
    expect(s).toMatchObject({ mode: 'backdrop', up: '+y', yaw: 0, scale: 1, offset: [0, 0, 0], opacity: 1, level: null });
  });

  it('only reads the space subject, and a surround room defaults to full opacity', () => {
    const other = meta(BG_MODE_PREDICATE, 'surround', { s: { kind: 'iri', value: 'urn:other' } });
    expect(backgroundSettingsFrom([other]).mode).toBe('backdrop');
    expect(backgroundSettingsFrom([meta(BG_MODE_PREDICATE, 'surround')]).opacity).toBe(1);
    expect(backgroundSettingsFrom([]).opacity).toBe(0.5);
  });
});

describe('surround scale is not assumed to be metres', () => {
  it('fits the measured extent to 10 units unless a scale is set', () => {
    const ext = meta(BG_EXTENT_PREDICATE, '38.7');
    expect(backgroundSettingsFrom([meta(BG_MODE_PREDICATE, 'surround'), ext]).scale).toBeCloseTo(10 / 38.7, 6);
    expect(backgroundSettingsFrom([meta(BG_MODE_PREDICATE, 'surround'), ext, meta(BG_SCALE_PREDICATE, '0.5')]).scale).toBe(0.5);
    expect(backgroundSettingsFrom([ext]).scale).toBe(1); // a backdrop sizes itself
    expect(backgroundSettingsFrom([meta(BG_MODE_PREDICATE, 'surround')]).scale).toBe(1); // no measurement (SPZ): say so, do not guess
  });
});

describe('orientation', () => {
  it('every up axis is turned to +y', () => {
    const axis: Record<string, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    for (const a of UP_AXES) close(qRotate(upAxisQuaternion(a), axis[a]), [0, 1, 0]);
  });

  it('composes up axis, level and yaw, in that order', () => {
    const q = backgroundQuaternion({ up: '-y', level: null, yaw: 90 });
    close(qRotate(q, [0, -1, 0]), [0, 1, 0]); // up stays up under yaw
    const flat = backgroundQuaternion({ up: '+y', level: null, yaw: 90 });
    close(qRotate(flat, [1, 0, 0]), [0, 0, -1]); // a quarter turn about the vertical
    const tilt = qBetween([0, 1, 0], [0.2, Math.sqrt(1 - 0.04), 0]);
    close(qRotate(backgroundQuaternion({ up: '+y', level: tilt, yaw: 0 }), [0, 1, 0]), [0.2, Math.sqrt(1 - 0.04), 0], 1e-6);
  });
});

/** A room-ish cloud: a floor tilted by `tiltDeg` about z with noise, plus walls and clutter. */
function tiltedRoom(tiltDeg: number, seed = 7) {
  let a = seed;
  const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const pts: number[] = [];
  const t = (tiltDeg * Math.PI) / 180;
  const q: Quat = [0, 0, Math.sin(t / 2), Math.cos(t / 2)];
  const push = (p: Vec3) => { const v = qRotate(q, p); pts.push(v[0], v[1], v[2]); };
  for (let i = 0; i < 4000; i++) push([r() * 6 - 3, (r() - 0.5) * 0.01, r() * 6 - 3]); // floor
  for (let i = 0; i < 1500; i++) push([r() * 6 - 3, r() * 2.5, -3 + (r() - 0.5) * 0.01]); // wall (vertical)
  for (let i = 0; i < 1500; i++) push([-3 + (r() - 0.5) * 0.01, r() * 2.5, r() * 6 - 3]); // wall
  for (let i = 0; i < 500; i++) push([r() * 6 - 3, r() * 2.5, r() * 6 - 3]); // clutter
  return Float32Array.from(pts);
}

describe('fitFloor', () => {
  it('recovers a known tilt and levelling takes the floor flat', () => {
    for (const tilt of [0, 4, 12, -9]) {
      const pts = tiltedRoom(tilt);
      const fit = fitFloor(pts)!;
      expect(fit).not.toBeNull();
      expect(fit.tiltDeg).toBeGreaterThan(Math.abs(tilt) - 0.5);
      expect(fit.tiltDeg).toBeLessThan(Math.abs(tilt) + 0.5);
      expect(fit.fraction).toBeGreaterThan(0.4);
      const flat = rotatePoints(pts, levelQuaternion(fit));
      const again = fitFloor(flat)!;
      expect(again.tiltDeg).toBeLessThan(0.3);
    }
  });

  it('is deterministic', () => {
    const pts = tiltedRoom(6);
    expect(fitFloor(pts)).toEqual(fitFloor(pts));
  });

  it('is not fooled into a floor by a vertical wall, and says so for a cloud with no plane', () => {
    const wall: number[] = [];
    for (let i = 0; i < 3000; i++) wall.push((i % 60) / 10, Math.floor(i / 60) / 10, 0);
    expect(fitFloor(wall)).toBeNull(); // the only plane is vertical: outside the tilt window
    let a = 3;
    const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
    const cloud = Array.from({ length: 6000 }, () => r() * 10);
    expect(fitFloor(cloud)).toBeNull();
    expect(fitFloor([0, 0, 0, 1, 1, 1])).toBeNull(); // too few
  });

  it('a half turn about any axis is a valid rotation between opposite vectors', () => {
    const q = qBetween([0, -1, 0], [0, 1, 0]);
    close(qRotate(q, [0, -1, 0]), [0, 1, 0]);
    close(qRotate(qAboutY(0), [1, 2, 3]), [1, 2, 3]);
  });
});
