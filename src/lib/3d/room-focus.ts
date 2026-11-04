/**
 * Maths for the space background's controls in the graph view (F58.9.16): the log-scaled scale
 * slider, where the room sits once it has a focal point, and picking that focal point with a ray.
 *
 * Pure, so it can be asserted as numbers. KnowledgeGraph feeds it the camera ray; the panel feeds it
 * the sampled Gaussian centres.
 *
 * HOW A POINT IS PICKED: there is no mesh to raycast against (a splat is drawn as sorted
 * billboards), so the pick is a DEPTH PICK against the sampled Gaussian centres: every centre that
 * lies within a narrow cone around the ray is a candidate, and the nearest SURFACE wins: the
 * nearest depth with at least three candidates within 15% of it, so a lone floater in front of a
 * wall does not steal the click (with fewer than three candidates in all, the nearest one is taken). When nothing is under the cursor it falls back to the floor plane
 * (the levelled floor height, or the room's middle height when there is no floor) and says so.
 */
import { qAboutY, qRotate, type RoomFrame, type Vec3 } from './splat';

/** The scale slider covers 0.001 to 1000, the range backgroundSettingsFrom accepts. */
export const SCALE_LOG_MIN = -3;
export const SCALE_LOG_MAX = 3;

/** Slider position 0..1 to a scale, logarithmic, so every decade gets the same travel. */
export function scaleFromSlider(pos: number): number {
  const t = Math.min(1, Math.max(0, pos));
  const v = Math.pow(10, SCALE_LOG_MIN + t * (SCALE_LOG_MAX - SCALE_LOG_MIN));
  return Number(v.toPrecision(3));
}

/** The inverse: a scale to its slider position 0..1. */
export function sliderFromScale(scale: number): number {
  const s = Math.min(10 ** SCALE_LOG_MAX, Math.max(10 ** SCALE_LOG_MIN, scale));
  return (Math.log10(s) - SCALE_LOG_MIN) / (SCALE_LOG_MAX - SCALE_LOG_MIN);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * World position of the room's centre. The focal point (room units from the room's centre) is put
 * at the graph's centre plus the offset: centre = graphCentroid + offset - yaw(focal * scale).
 * With focal [0,0,0] this is the previous behaviour exactly.
 */
export function roomCentreWorld(graphCentroid: Vec3, offset: Vec3, focal: Vec3, scale: number, yaw: number): Vec3 {
  const f = qRotate(qAboutY(yaw), [focal[0] * scale, focal[1] * scale, focal[2] * scale]);
  return [graphCentroid[0] + offset[0] - f[0], graphCentroid[1] + offset[1] - f[1], graphCentroid[2] + offset[2] - f[2]];
}

/** A world-space ray as seen from inside the room: origin in room units, direction rotated back by the yaw. */
export function rayToRoomLocal(origin: Vec3, dir: Vec3, room: RoomFrame): { origin: Vec3; dir: Vec3 } {
  const inv = qAboutY(-room.yaw);
  const o = qRotate(inv, sub(origin, room.centre));
  return { origin: [o[0] / room.scale, o[1] / room.scale, o[2] / room.scale], dir: qRotate(inv, dir) };
}

export interface FocalPick {
  point: Vec3;
  /** 'splat' = a Gaussian under the cursor; 'plane' = nothing was, so the floor plane was used. */
  hit: 'splat' | 'plane';
}

/**
 * Depth pick on a ray in room-local space. `centres` is x y z triples (room units, already turned by
 * the up axis and levelling, relative to the room's centre). `tolerance` is the cone's half angle in
 * radians (default 0.03, about 1.7 degrees). `planeY` is the fallback plane's height; `planeLimit` how
 * far from the room's centre (horizontally, room units) that fallback may land.
 */
export function pickOnRay(
  centres: ArrayLike<number>, origin: Vec3, dir: Vec3, planeY: number, tolerance = 0.03, planeLimit = Infinity,
): FocalPick | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!len) return null;
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const cos = Math.cos(tolerance);
  const ts: number[] = [];
  for (let i = 0; i + 2 < centres.length; i += 3) {
    const vx = centres[i] - origin[0], vy = centres[i + 1] - origin[1], vz = centres[i + 2] - origin[2];
    const t = vx * d[0] + vy * d[1] + vz * d[2];
    if (t <= 0) continue;
    const dist = Math.hypot(vx, vy, vz);
    if (t / dist >= cos) ts.push(t);
  }
  if (ts.length) {
    ts.sort((a, b) => a - b);
    // The nearest depth that is a surface and not a floater: at least 3 candidates within 15% of it.
    let t = ts[0];
    for (let i = 0; i + 2 < ts.length; i++) {
      if (ts[i + 2] <= ts[i] * 1.15) { t = ts[i]; break; }
    }
    return { point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t], hit: 'splat' };
  }
  if (d[1] < -1e-6) {
    const t = (planeY - origin[1]) / d[1];
    const px = origin[0] + d[0] * t, pz = origin[2] + d[2] * t;
    // A shallow ray meets the plane miles away: only a point within `planeLimit` of the room's centre is a pick.
    if (t > 0 && Math.hypot(px, pz) <= planeLimit) return { point: [px, planeY, pz], hit: 'plane' };
  }
  return null;
}

/** The focal point's stored text: three numbers, rounded so the triple stays readable. */
export const formatFocal = (p: Vec3): string => p.map((x) => Math.round(x * 1000) / 1000).join(' ');
