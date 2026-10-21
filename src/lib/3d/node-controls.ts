/**
 * Per-node controls (F58.9.17, F58.9.18): where a node is pinned in 2D, how a node is drawn (scale, turn,
 * opacity) and how it moves (spin, bob, pulse). Matt, 2026-10-20: "tweakpane or other control mechanisms
 * should be implemented for the nodes, so they can individually controlled motion, etc."
 *
 * These are SETTINGS of the space, not facts about the thing: meta triples on the node (`urn:kbase:meta/…`),
 * hidden by isMetaPredicate, carried by an export. The reading side is pure and lives here, like
 * backgroundSettingsFrom; the writes are in $lib/stores/node-pins. A 3D pin reuses the F58.9.9 placement
 * predicates (placed-at); a 2D pin has its own, because the 2D layout's coordinate space is not the 3D one.
 */
import type { Statement } from '$lib/rdf/types';
import type { Vec3 } from './splat';

const META = 'urn:kbase:meta/';
/** "x y" in the 2D layout's world units. Separate from placed-at: the two coordinate spaces are unrelated. */
export const PIN2D_PREDICATE = META + 'pinned-2d';
export const NODE_SCALE_PREDICATE = META + 'node-scale';
export const NODE_YAW_PREDICATE = META + 'node-yaw';
export const NODE_OPACITY_PREDICATE = META + 'node-opacity';
/** Degrees per second about the vertical (3D) or the screen normal (2D). */
export const NODE_SPIN_PREDICATE = META + 'node-spin';
/** "amplitude periodSeconds": a vertical bob, in world units. */
export const NODE_BOB_PREDICATE = META + 'node-bob';
/** "amplitude periodSeconds": a size pulse, amplitude as a fraction of the node's size. */
export const NODE_PULSE_PREDICATE = META + 'node-pulse';

export const NODE_CONTROL_PREDICATES = [
  NODE_SCALE_PREDICATE, NODE_YAW_PREDICATE, NODE_OPACITY_PREDICATE, NODE_SPIN_PREDICATE, NODE_BOB_PREDICATE, NODE_PULSE_PREDICATE,
] as const;

export interface NodeMotion {
  /** Size multiplier on the node's own size. */
  scale: number;
  /** Degrees. */
  yaw: number;
  opacity: number;
  /** Degrees per second. */
  spin: number;
  bob: { amp: number; period: number };
  pulse: { amp: number; period: number };
}

export const MOTION_DEFAULTS: Readonly<NodeMotion> = {
  scale: 1, yaw: 0, opacity: 1, spin: 0, bob: { amp: 0, period: 3 }, pulse: { amp: 0, period: 2 },
};

const live = (s: Statement) => s.status !== 'rejected' && s.status !== 'superseded' && s.status !== 'pending-removal';
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const nums = (v: string, n: number): number[] | null => {
  const a = v.trim().split(/[\s,]+/).map(Number);
  return a.length === n && a.every(Number.isFinite) ? a : null;
};

/** The newest live literal of each wanted predicate, per node IRI. */
function newestByNode(statements: readonly Statement[], wanted: ReadonlySet<string>): Map<string, Map<string, Statement>> {
  const out = new Map<string, Map<string, Statement>>();
  for (const s of statements) {
    if (s.s.kind !== 'iri' || s.o.kind !== 'literal' || !wanted.has(s.p.value) || !live(s)) continue;
    let per = out.get(s.s.value);
    if (!per) out.set(s.s.value, (per = new Map()));
    const prev = per.get(s.p.value);
    if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) per.set(s.p.value, s);
  }
  return out;
}

const WANTED = new Set<string>(NODE_CONTROL_PREDICATES);

/**
 * Node IRI to its motion and look, for the nodes that have at least one control set. The newest live
 * value of each wins; anything malformed falls back to its default (and a node with only malformed
 * values is left out, so the renderers' fast path stays "no entry, nothing to do").
 */
export function nodeMotionFrom(statements: readonly Statement[]): Map<string, NodeMotion> {
  const out = new Map<string, NodeMotion>();
  for (const [iri, per] of newestByNode(statements, WANTED)) {
    const d = MOTION_DEFAULTS;
    const num = (p: string) => (per.has(p) ? Number(per.get(p)!.o.value) : NaN);
    const pair = (p: string) => (per.has(p) ? nums(per.get(p)!.o.value, 2) : null);
    const scale = num(NODE_SCALE_PREDICATE), yaw = num(NODE_YAW_PREDICATE), opacity = num(NODE_OPACITY_PREDICATE), spin = num(NODE_SPIN_PREDICATE);
    const bob = pair(NODE_BOB_PREDICATE), pulse = pair(NODE_PULSE_PREDICATE);
    const m: NodeMotion = {
      scale: Number.isFinite(scale) && scale > 0 ? clamp(scale, 0.1, 10) : d.scale,
      yaw: Number.isFinite(yaw) ? yaw : d.yaw,
      opacity: Number.isFinite(opacity) ? clamp(opacity, 0, 1) : d.opacity,
      spin: Number.isFinite(spin) ? clamp(spin, -720, 720) : d.spin,
      bob: bob ? { amp: clamp(bob[0], 0, 10), period: clamp(bob[1], 0.2, 120) } : { ...d.bob },
      pulse: pulse ? { amp: clamp(pulse[0], 0, 2), period: clamp(pulse[1], 0.2, 120) } : { ...d.pulse },
    };
    if (isDefaultMotion(m)) continue;
    out.set(iri, m);
  }
  return out;
}

export function isDefaultMotion(m: NodeMotion): boolean {
  const d = MOTION_DEFAULTS;
  return m.scale === d.scale && m.yaw === d.yaw && m.opacity === d.opacity && m.spin === d.spin && m.bob.amp === 0 && m.pulse.amp === 0;
}

/** True when the node changes from frame to frame (so a renderer that sleeps when settled must keep drawing). */
export const isAnimated = (m: NodeMotion): boolean => m.spin !== 0 || m.bob.amp > 0 || m.pulse.amp > 0;

export interface MotionFrame {
  /** Total size multiplier this frame (the static scale times the pulse). */
  scale: number;
  /** Vertical offset in world units. */
  dy: number;
  /** Degrees. */
  yaw: number;
  opacity: number;
}

/**
 * What a node looks like at time `t` (seconds). With reduced motion the static settings still apply
 * (a size, a turn and an opacity are not motion) and spin, bob and pulse are held at their rest values.
 */
export function motionFrame(m: NodeMotion, t: number, reduced: boolean): MotionFrame {
  if (reduced) return { scale: m.scale, dy: 0, yaw: m.yaw, opacity: m.opacity };
  const pulse = m.pulse.amp > 0 ? 1 + m.pulse.amp * Math.sin((2 * Math.PI * t) / m.pulse.period) : 1;
  const dy = m.bob.amp > 0 ? m.bob.amp * Math.sin((2 * Math.PI * t) / m.bob.period) : 0;
  const yaw = m.spin !== 0 ? (((m.yaw + m.spin * t) % 360) + 360) % 360 : m.yaw;
  return { scale: m.scale * pulse, dy, yaw, opacity: m.opacity };
}

/** Node IRI to its 2D pin ("x y", the 2D layout's world units), newest live value, malformed ones ignored. */
export function pins2dFrom(statements: readonly Statement[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const [iri, per] of newestByNode(statements, new Set([PIN2D_PREDICATE]))) {
    const xy = nums(per.get(PIN2D_PREDICATE)!.o.value, 2);
    if (xy) out.set(iri, [clamp(xy[0], -1e4, 1e4), clamp(xy[1], -1e4, 1e4)]);
  }
  return out;
}

export const formatPin2d = (x: number, y: number): string => `${round3(x)} ${round3(y)}`;
export const formatPair = (a: number, b: number): string => `${round3(a)} ${round3(b)}`;

// ── Dragging ─────────────────────────────────────────────────────────────────

/** A pointer must travel this far (CSS px) before a press on a node becomes a drag; less is a click. */
export const DRAG_THRESHOLD_PX = 4;
/** A touch must be held this long, still, to start a drag, so a swipe over a node still pans the view. */
export const LONG_PRESS_MS = 300;

export type DragIntent = 'pending' | 'drag' | 'ignore';

/**
 * Whether a press that landed on a node is a drag, still undecided, or not ours.
 * - Not on a node, or not the primary button (the right button is the camera pan and the timeline scrub): ignore.
 * - Mouse or pen: a drag once it has moved more than DRAG_THRESHOLD_PX; until then pending (a click if released).
 * - Touch: a drag once held LONG_PRESS_MS without moving; a move before that is a swipe (ignore), so
 *   panning and pinching keep working over a node. `armed` latches a long-press that has already started.
 */
export function dragIntent(i: { pointerType: string; button: number; onNode: boolean; movedPx: number; heldMs: number; armed?: boolean }): DragIntent {
  if (!i.onNode || i.button !== 0) return 'ignore';
  if (i.pointerType === 'touch') {
    if (i.armed) return 'drag';
    if (i.movedPx > DRAG_THRESHOLD_PX) return 'ignore';
    return i.heldMs >= LONG_PRESS_MS ? 'drag' : 'pending';
  }
  return i.movedPx > DRAG_THRESHOLD_PX ? 'drag' : 'pending';
}

export interface DragPlane { point: Vec3; normal: Vec3; kind: 'camera' | 'floor' }

/**
 * The plane a node is dragged on: the one facing the camera through the node's start position, or,
 * for a node standing on a room's floor, the horizontal plane through it (so it slides along the floor
 * instead of rising toward the camera).
 */
export function dragPlane(startPos: Vec3, cameraDir: Vec3, onFloor: boolean): DragPlane {
  if (onFloor) return { point: startPos, normal: [0, 1, 0], kind: 'floor' };
  const len = Math.hypot(cameraDir[0], cameraDir[1], cameraDir[2]) || 1;
  return { point: startPos, normal: [cameraDir[0] / len, cameraDir[1] / len, cameraDir[2] / len], kind: 'camera' };
}

/** Where a ray meets a plane, or null when it is parallel to it or the plane is behind the ray's origin. */
export function rayPlaneHit(origin: Vec3, dir: Vec3, plane: Pick<DragPlane, 'point' | 'normal'>): Vec3 | null {
  const denom = dir[0] * plane.normal[0] + dir[1] * plane.normal[1] + dir[2] * plane.normal[2];
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((plane.point[0] - origin[0]) * plane.normal[0] + (plane.point[1] - origin[1]) * plane.normal[1] + (plane.point[2] - origin[2]) * plane.normal[2]) / denom;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t].map((x) => clamp(x, -1e4, 1e4)) as Vec3;
}

/** World height of a room's floor: the room centre plus the floor level (room units) times the scale. Yaw about the vertical does not change it. */
export const floorWorldY = (centreY: number, floor: number, scale: number): number => centreY + floor * scale;
