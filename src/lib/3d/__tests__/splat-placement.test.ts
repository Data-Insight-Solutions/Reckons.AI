/**
 * F58.9.9: placement is a setting of the space. Parsing, the room-to-world transform and its
 * inverse, the default "in front of the camera, on the floor" and the adjustment steps are pure.
 */
import { describe, it, expect } from 'vitest';
import {
  placementsFrom, placementWorld, worldToRoom, defaultPlacement, adjustPlacement, formatPlacementAt, backgroundSettingsFrom,
  PLACED_AT_PREDICATE, PLACED_SCALE_PREDICATE, PLACED_YAW_PREDICATE, BG_FLOOR_PREDICATE, SPACE_SUBJECT, type RoomFrame, type Vec3,
} from '../splat';
import type { Statement } from '../../rdf/types';

const st = (s: string, p: string, v: string, o: Partial<Statement> = {}): Statement => ({
  id: s + p + v, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: v },
  g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: 1, updatedAt: 1, ...o,
});
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => { for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps); };
const room: RoomFrame = { centre: [10, 2, -4], scale: 2, yaw: 90 };

describe('placementsFrom', () => {
  it('reads placed-at with defaults for scale and yaw, newest live value winning', () => {
    const m = placementsFrom([
      st('urn:a', PLACED_AT_PREDICATE, '1 0 2'),
      st('urn:b', PLACED_AT_PREDICATE, '0 0 0', { updatedAt: 1 }), st('urn:b', PLACED_AT_PREDICATE, '3 0 0', { updatedAt: 2 }),
      st('urn:b', PLACED_SCALE_PREDICATE, '0.5'), st('urn:b', PLACED_YAW_PREDICATE, '-30'),
      st('urn:c', PLACED_AT_PREDICATE, '9 9 9', { status: 'rejected' }),
      st('urn:d', PLACED_AT_PREDICATE, 'nowhere'),
      st('urn:e', PLACED_SCALE_PREDICATE, '2'), // a scale without a place is not a placement
    ]);
    expect([...m.keys()]).toEqual(['urn:a', 'urn:b']);
    expect(m.get('urn:a')).toEqual({ at: [1, 0, 2], scale: 1, yaw: 0 });
    expect(m.get('urn:b')).toEqual({ at: [3, 0, 0], scale: 0.5, yaw: -30 });
  });
});

describe('room to world', () => {
  it('scales by the room scale, turns with the room yaw and offsets from its centre', () => {
    const w = placementWorld({ at: [1, 0.5, 0], scale: 0.5, yaw: 10 }, room);
    close(w.pos, [10, 3, -6]); // (1,0.5,0)*2 = (2,1,0), a quarter turn about y sends +x to -z
    expect(w.radius).toBe(1);
    expect(w.yaw).toBe(100);
  });

  it('worldToRoom inverts it', () => {
    const at: Vec3 = [1.5, -0.25, 3];
    const w = placementWorld({ at, scale: 1, yaw: 0 }, room);
    close(worldToRoom(w.pos, room), at, 1e-3);
  });
});

describe('Place in room', () => {
  it('puts it half way from the camera toward the target, on the floor, radius above it', () => {
    const flat: RoomFrame = { centre: [0, 0, 0], scale: 1, yaw: 0 };
    const p = defaultPlacement({ camera: [0, 5, 10], target: [0, 0, 0], floor: -1.5 }, flat, 0.4);
    expect(p).toEqual({ at: [0, -1.1, 5], scale: 0.4, yaw: 0 });
  });

  it('without a known floor it stays at the middle height rather than guessing one', () => {
    const p = defaultPlacement({ camera: [4, 0, 0], target: [0, 0, 0], floor: null }, { centre: [0, 0, 0], scale: 1, yaw: 0 });
    expect(p.at).toEqual([2, 0, 0]);
  });
});

describe('adjustPlacement', () => {
  const p = { at: [0, 0, 0] as Vec3, scale: 1, yaw: 170 };
  it('moves, raises, turns across the seam, and scales within limits', () => {
    expect(adjustPlacement(p, { kind: 'move', dx: 0.25, dz: -0.25 }).at).toEqual([0.25, 0, -0.25]);
    expect(adjustPlacement(p, { kind: 'move', dy: 0.25 }).at).toEqual([0, 0.25, 0]);
    expect(adjustPlacement(p, { kind: 'turn', degrees: 30 }).yaw).toBe(-160);
    expect(adjustPlacement(p, { kind: 'scale', factor: 1.25 }).scale).toBe(1.25);
    expect(adjustPlacement({ ...p, scale: 0.03 }, { kind: 'scale', factor: 0.1 }).scale).toBe(0.02);
  });

  it('does not mutate and formats a readable triple', () => {
    const before = JSON.stringify(p);
    adjustPlacement(p, { kind: 'move', dx: 1 });
    expect(JSON.stringify(p)).toBe(before);
    expect(formatPlacementAt([0.1 + 0.2, 1, -0.0004])).toBe('0.3 1 0');
  });
});

describe('floor setting', () => {
  it('is read as a number or null', () => {
    expect(backgroundSettingsFrom([]).floor).toBeNull();
    expect(backgroundSettingsFrom([st(SPACE_SUBJECT, BG_FLOOR_PREDICATE, '-1.25')]).floor).toBe(-1.25);
    expect(backgroundSettingsFrom([st(SPACE_SUBJECT, BG_FLOOR_PREDICATE, 'low')]).floor).toBeNull();
  });
});
