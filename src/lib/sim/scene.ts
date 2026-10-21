// F260.1 — the scene reader. Pure: statements in, a Scene (or refusals with reasons) out.
// A node is a rigid body when it has a `sim-shape`. Pose reuses the existing placement predicates
// (placed-at, placed-yaw from 3d/splat.ts); nothing here invents a pose predicate.
import type { Statement } from '../rdf/types';
import { PLACED_AT_PREDICATE, PLACED_YAW_PREDICATE } from '../3d/splat';

const META = 'urn:kbase:meta/';
export const SIM_SHAPE = META + 'sim-shape';
export const SIM_MASS = META + 'sim-mass';
export const SIM_STATIC = META + 'sim-static';
export const SIM_SENSOR = META + 'sim-sensor';
export const SIM_FRICTION = META + 'sim-friction';
export const SIM_RESTITUTION = META + 'sim-restitution';
export const SIM_TILT = META + 'sim-tilt';
export const SIM_VELOCITY = META + 'sim-velocity';
export const SIM_CONDITION = META + 'sim-condition';

export const DEFAULT_FRICTION = 0.5;
export const DEFAULT_RESTITUTION = 0;
export const DEFAULT_MASS = 1;
export const MAX_BODIES = 200;

export type Vec3 = [number, number, number];
export type Shape =
  | { kind: 'box'; w: number; h: number; d: number }
  | { kind: 'sphere'; r: number }
  | { kind: 'capsule'; r: number; halfHeight: number };

export interface Body {
  /** Local name of the node IRI (after the last / or #). Unique within a scene. */
  id: string;
  iri: string;
  shape: Shape;
  /** Static bodies never move. */
  isStatic: boolean;
  /** A sensor does not collide: it is a region other conditions test against. Implies static. */
  isSensor: boolean;
  mass: number;
  friction: number;
  restitution: number;
  position: Vec3;
  /** Degrees about the vertical axis. */
  yaw: number;
  /** Degrees about the z axis, applied before yaw (a ramp needs a slope; the placement predicates only carry yaw). */
  tilt: number;
  velocity: Vec3;
}

export interface Refusal { id: string; reason: string }
export interface Scene { bodies: Body[]; refusals: Refusal[] }

const live = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded' && s.status !== 'pending-removal';

export function localName(iri: string): string {
  const m = /[^/#:]+$/.exec(iri);
  return m ? m[0] : iri;
}

function numbers(v: string, n: number): number[] | null {
  const a = v.trim().split(/[\s,]+/).map(Number);
  return a.length === n && a.every(Number.isFinite) ? a : null;
}

/** Parse "box w h d" | "sphere r" | "capsule r halfHeight". Returns a reason string on failure. */
export function parseShape(text: string): Shape | string {
  const parts = text.trim().split(/\s+/);
  const kind = parts[0]?.toLowerCase();
  const args = parts.slice(1).map(Number);
  const ok = (n: number) => args.length === n && args.every((x) => Number.isFinite(x) && x > 0);
  if (kind === 'box') return ok(3) ? { kind: 'box', w: args[0], h: args[1], d: args[2] } : 'box needs three positive numbers: "box w h d"';
  if (kind === 'sphere') return ok(1) ? { kind: 'sphere', r: args[0] } : 'sphere needs one positive number: "sphere r"';
  if (kind === 'capsule') return ok(2) ? { kind: 'capsule', r: args[0], halfHeight: args[1] } : 'capsule needs two positive numbers: "capsule r halfHeight"';
  return `unknown shape "${parts[0] ?? ''}" (use box, sphere or capsule)`;
}

/** Axis-aligned half-extents of a shape (yaw is ignored: regions are axis-aligned). */
export function halfExtents(s: Shape): Vec3 {
  if (s.kind === 'box') return [s.w / 2, s.h / 2, s.d / 2];
  if (s.kind === 'sphere') return [s.r, s.r, s.r];
  return [s.r, s.r + s.halfHeight, s.r];
}

export function sceneFromStatements(statements: readonly Statement[]): Scene {
  // newest live literal per (subject, predicate)
  const newest = new Map<string, Statement>();
  for (const s of statements) {
    if (s.s.kind !== 'iri' || s.o.kind !== 'literal' || !live(s)) continue;
    if (!s.p.value.startsWith(META)) continue;
    const k = s.s.value + '|' + s.p.value;
    const prev = newest.get(k);
    if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) newest.set(k, s);
  }
  const val = (iri: string, p: string) => newest.get(iri + '|' + p)?.o.value;

  const subjects = [...new Set([...newest.values()].filter((s) => s.p.value === SIM_SHAPE).map((s) => s.s.value))].sort();
  const bodies: Body[] = [];
  const refusals: Refusal[] = [];
  const seen = new Map<string, string>();

  for (const iri of subjects) {
    const id = localName(iri);
    const refuse = (reason: string) => refusals.push({ id, reason });
    if (seen.has(id)) { refuse(`id "${id}" is also used by ${seen.get(id)}`); continue; }
    seen.set(id, iri);

    const shape = parseShape(val(iri, SIM_SHAPE)!);
    if (typeof shape === 'string') { refuse(shape); continue; }

    const flag = (p: string): boolean | string => {
      const v = val(iri, p);
      if (v === undefined) return false;
      if (v.trim() === 'true') return true;
      if (v.trim() === 'false') return false;
      return `${p.slice(META.length)} must be "true" or "false", got "${v}"`;
    };
    const isStatic = flag(SIM_STATIC);
    const isSensor = flag(SIM_SENSOR);
    if (typeof isStatic === 'string') { refuse(isStatic); continue; }
    if (typeof isSensor === 'string') { refuse(isSensor); continue; }

    const numField = (p: string, dflt: number, min: number, positive = false): number | string => {
      const v = val(iri, p);
      if (v === undefined) return dflt;
      const x = Number(v);
      if (!Number.isFinite(x) || x < min || (positive && x <= 0)) return `${p.slice(META.length)} must be a number ${positive ? '> 0' : `>= ${min}`}, got "${v}"`;
      return x;
    };
    const mass = numField(SIM_MASS, DEFAULT_MASS, 0, true);
    const friction = numField(SIM_FRICTION, DEFAULT_FRICTION, 0);
    const restitution = numField(SIM_RESTITUTION, DEFAULT_RESTITUTION, 0);
    const bad = [mass, friction, restitution].find((x) => typeof x === 'string');
    if (bad) { refuse(bad as string); continue; }

    const at = val(iri, PLACED_AT_PREDICATE);
    if (at === undefined) { refuse('no pose: placed-at is required ("x y z")'); continue; }
    const position = numbers(at, 3);
    if (!position) { refuse(`placed-at must be three numbers "x y z", got "${at}"`); continue; }
    const yawText = val(iri, PLACED_YAW_PREDICATE);
    const yaw = yawText === undefined ? 0 : Number(yawText);
    if (!Number.isFinite(yaw)) { refuse(`placed-yaw must be a number of degrees, got "${yawText}"`); continue; }

    const tiltText = val(iri, SIM_TILT);
    const tilt = tiltText === undefined ? 0 : Number(tiltText);
    if (!Number.isFinite(tilt) || Math.abs(tilt) > 180) { refuse(`sim-tilt must be degrees from -180 to 180, got "${tiltText}"`); continue; }

    const velText = val(iri, SIM_VELOCITY);
    const velocity = velText === undefined ? [0, 0, 0] : numbers(velText, 3);
    if (!velocity) { refuse(`sim-velocity must be three numbers "x y z", got "${velText}"`); continue; }
    if ((isStatic || isSensor) && velText !== undefined) { refuse('a static or sensor body cannot have sim-velocity'); continue; }

    bodies.push({
      id, iri, shape, isStatic: isStatic || isSensor, isSensor,
      mass: mass as number, friction: friction as number, restitution: restitution as number,
      position: position as Vec3, yaw, tilt, velocity: velocity as Vec3,
    });
  }
  if (bodies.length > MAX_BODIES) {
    return { bodies: [], refusals: [{ id: '*', reason: `${bodies.length} bodies exceeds the limit of ${MAX_BODIES}` }, ...refusals] };
  }
  return { bodies, refusals };
}

/** Condition texts on a target node, in statement order. */
export function conditionsFromStatements(statements: readonly Statement[]): { subject: string; text: string }[] {
  return statements
    .filter((s) => s.p.value === SIM_CONDITION && s.o.kind === 'literal' && s.s.kind === 'iri' && live(s))
    .map((s) => ({ subject: s.s.value, text: s.o.value }));
}
