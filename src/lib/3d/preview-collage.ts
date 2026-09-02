/**
 * PREVIEW COLLAGE — making room for every preview at once.
 *
 * Matt, 2026-08-14: "collage wasn't a force, it was a force modifier, to toggle on 'view all
 * previews'". That correction is the design. A FORCE decides where nodes go; this decides what
 * they SHOW, and then asks whichever force is running for enough room to show it. So it composes
 * with free / focus / hub / time / arrange / tree instead of replacing one.
 *
 * WHY A COLLISION PASS AND NOT TUNED REPULSION. The simulation in KnowledgeGraph.svelte is
 * size-blind: repulsion is `f = REPEL / d2` with REPEL a single constant, so a node rendering a
 * 3-unit-wide image pushes exactly as hard as a bare glyph. Raising REPEL for preview nodes
 * spreads the graph but never GUARANTEES non-overlap — inverse-square falls off and the springs
 * settle wherever they balance. The feature is named for a property ("all visible"), and a
 * property that must hold has to be asserted, not approached. Same lesson as the timeline x-lock:
 * tuning constants could never make the date axis authoritative, and pinning it could.
 *
 * This module is deliberately pure and renderer-free so the geometry is testable without a GPU.
 */

/** The minimum a caller must give us: a mutable position. */
export type Positioned = {
  key: string;
  pos: { x: number; y: number; z: number };
  /**
   * Optional, and the difference between a layout that settles and one that buzzes.
   *
   * Correcting a POSITION while leaving the VELOCITY pointing into the neighbour means the
   * simulation drives the node straight back in on the next frame, the constraint shoves it out
   * again, and the node vibrates instead of resting. Reported from the running app on 2026-08-14
   * ("the nodes start moving rapidly... back and forth") — the unit tests could not see it because
   * they stepped the constraint with no forces acting between passes.
   *
   * When present, the inward component of velocity is cancelled along with the position fix, which
   * is what position-based dynamics does and why it converges.
   */
  vel?: { x: number; y: number; z: number };
};

/** A camera's screen plane: the world-space right and up unit vectors. */
export type ViewBasis = {
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
};

export type CollageOptions = {
  /**
   * Separate within the camera's SCREEN PLANE rather than in world space.
   *
   * Without this the constraint is satisfiable by pushing two nodes apart along the VIEW axis —
   * genuinely 3.5 units apart in the world, and still perfectly stacked on screen, because depth
   * is exactly the direction that projects to nothing. Measured on the 9-photo fixture: world-space
   * separation converged and left ~20% of the thumbnail area occluded anyway.
   *
   * Occlusion is a screen phenomenon, so the fix has to be screen-shaped. This is the general form
   * of the same mistake lockX guards against — a separation is only real in the directions the
   * viewer can actually see it.
   */
  basis?: ViewBasis | null;
  /**
   * Timeline mode pins x to the date anchor every frame. A separation pushing along an arbitrary
   * axis would drag nodes off their own date — reintroducing, from a new direction, the exact bug
   * the x-lock exists to fix. When true, all separation happens in y/z only.
   */
  lockX?: boolean;
  /** Fraction of the overlap resolved per pass. 1 = fully, lower = ease apart. */
  strength?: number;
  /**
   * Relaxation passes per call. One pass is NOT enough and the difference is visible: separating a
   * pair moves each of them into somebody else, so a cluster needs the constraint re-applied until
   * it stops finding work. Measured on the 9-photo fixture — a single pass at 0.35 left 16 pairs
   * overlapping on EVERY frame, because the hub's edge springs pulled the nodes back in faster
   * than the pass eased them out, and the render showed a pile.
   *
   * Iterating here rather than trusting successive frames is what makes the guarantee real: this
   * runs last in the frame, so if it converges, nothing overlaps at the moment of painting.
   */
  iterations?: number;
  /**
   * Overlap (world units) tolerated without correcting — "slop", in the physics-engine sense.
   *
   * Zero tolerance means the solver keeps nudging over overlaps far too small to see, and since
   * the other forces push back every frame, those nudges never stop. A tiny allowance lets the
   * layout come to rest, which matters more than being right to the sixth decimal about two images
   * that were never going to look different.
   */
  slop?: number;
  /**
   * How much of the inward velocity to cancel when a pair is corrected, 0..1. 1 removes it
   * entirely (the node stops pushing into its neighbour), 0 leaves the buzzing behaviour.
   */
  velocityDamping?: number;
  /** Safety valve: pairwise is O(n²), so stop before a huge graph stalls the frame. */
  maxNodes?: number;
};

/**
 * World-space radius a node needs while the modifier is on.
 *
 * A preview is drawn as a square billboard, so the radius that must not overlap is its
 * half-DIAGONAL, not its half-width — using half-width lets corners cross while the centers are
 * legally apart, which reads as overlap to the eye even though the math says clear.
 */
export function collageRadius(hasPreview: boolean, baseRadius: number, previewSize: number): number {
  if (!hasPreview) return baseRadius;
  const halfDiagonal = (previewSize * Math.SQRT2) / 2;
  // Never shrink a node below what it already occupied.
  return Math.max(baseRadius, halfDiagonal);
}

/** tan(fov/2) for the 55° camera the graph uses. Matches CAM_HALF_TAN in KnowledgeGraph.svelte. */
export const CAM_HALF_TAN = Math.tan((27.5 * Math.PI) / 180);

/**
 * Convert a preview's on-SCREEN size into the world radius it needs.
 *
 * Previews are not textures on the mesh — they are DOM thumbnails in the GraphLabels overlay,
 * drawn at a fixed pixel size (settings.nodePreviewSize). So the world room a preview needs is
 * not a constant: it depends on how far the camera is. KnowledgeGraph.svelte projects the other
 * way with
 *
 *   screenRadius = (worldRadius / (CAM_HALF_TAN * dist)) * halfH
 *
 * and this is that formula solved for worldRadius. The consequence is the good kind: zoom out and
 * each preview claims MORE world space, because it still occupies the same 96px on screen. The
 * separation therefore holds at every zoom level rather than at one tuned distance.
 */
export function previewWorldRadius(
  previewSizePx: number,
  distance: number,
  halfHeightPx: number,
): number {
  if (halfHeightPx <= 0 || distance <= 0) return 0;
  const halfDiagonalPx = (previewSizePx * Math.SQRT2) / 2;
  return (halfDiagonalPx * CAM_HALF_TAN * distance) / halfHeightPx;
}

/**
 * A deterministic unit vector, used when two nodes sit at (nearly) the same point and there is no
 * real axis to separate along. Derived from the key so the same pair always parts the same way —
 * a random nudge would make the layout jitter differently on every frame and every reload, and
 * would make these tests unrepeatable.
 */
function fallbackAxis(key: string, lockX: boolean): { x: number; y: number; z: number } {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const angle = ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
  if (lockX) return { x: 0, y: Math.cos(angle), z: Math.sin(angle) };
  // Spread over a sphere-ish spiral rather than a single plane.
  const tilt = (((h >>> 8) % 1800) / 1800) * Math.PI - Math.PI / 2;
  const c = Math.cos(tilt);
  return { x: c * Math.cos(angle), y: Math.sin(tilt), z: c * Math.sin(angle) };
}

/**
 * Push apart any pair closer than the sum of their radii. Mutates positions in place — the
 * simulation owns these vectors and allocating new ones every frame would churn the heap.
 *
 * Returns the number of pairs it had to separate, which is what a test asserts on and what a
 * caller can use to tell "settled" from "still resolving".
 */
export function resolveOverlaps(
  nodes: Positioned[],
  radiusOf: (n: Positioned) => number,
  opts: CollageOptions = {},
): number {
  const {
    lockX = false, strength = 0.5, iterations = 1, maxNodes = 400,
    basis = null, slop = 0.02, velocityDamping = 1,
  } = opts;
  if (nodes.length > maxNodes) return 0;

  let separated = 0;
  for (let pass = 0; pass < iterations; pass++) {
    separated = onePass(nodes, radiusOf, lockX, strength, basis, slop, velocityDamping);
    if (separated === 0) break; // converged — nothing left overlapping
  }
  return separated;
}

const dot = (
  v: { x: number; y: number; z: number },
  ax: number, ay: number, az: number,
) => v.x * ax + v.y * ay + v.z * az;

function onePass(
  nodes: Positioned[],
  radiusOf: (n: Positioned) => number,
  lockX: boolean,
  strength: number,
  basis: ViewBasis | null,
  slop: number,
  velocityDamping: number,
): number {
  let separated = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const ra = radiusOf(a);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const min = ra + radiusOf(b);

      const ax = a.pos.x - b.pos.x;
      const ay = a.pos.y - b.pos.y;
      const az = a.pos.z - b.pos.z;

      let d: number;
      let ux: number, uy: number, uz: number;

      if (basis) {
        // Measure and push only in what the viewer can see. The depth component is dropped
        // entirely: separating along it satisfies the arithmetic and changes nothing on screen.
        const r = basis.right, u = basis.up;
        const sr = dot(r, ax, ay, az);
        const su = dot(u, ax, ay, az);
        d = Math.hypot(sr, su);
        if (d >= min - slop) continue;
        if (d < 1e-6) {
          const f = fallbackAxis(a.key + '|' + b.key, false);
          // Re-express the fallback inside the plane so it still moves nothing in depth.
          const fr = dot(r, f.x, f.y, f.z), fu = dot(u, f.x, f.y, f.z);
          const n = Math.hypot(fr, fu) || 1;
          ux = (r.x * fr + u.x * fu) / n;
          uy = (r.y * fr + u.y * fu) / n;
          uz = (r.z * fr + u.z * fu) / n;
          d = 0;
        } else {
          ux = (r.x * sr + u.x * su) / d;
          uy = (r.y * sr + u.y * su) / d;
          uz = (r.z * sr + u.z * su) / d;
        }
      } else {
        const dx = lockX ? 0 : ax;
        d = Math.sqrt(dx * dx + ay * ay + az * az);
        // Under lockX the true gap is measured in the y/z plane only. Two nodes far apart in x but
        // stacked in y/z DO overlap on screen once they are billboards, so this is the honest
        // measure, not a shortcut.
        if (d >= min - slop) continue;
        if (d < 1e-6) {
          const f = fallbackAxis(a.key + '|' + b.key, lockX);
          ux = f.x; uy = f.y; uz = f.z;
          d = 0;
        } else {
          ux = dx / d; uy = ay / d; uz = az / d;
        }
      }

      // The timeline's date axis outranks everything, including this. Zeroing x AFTER choosing the
      // direction keeps the push shorter than requested rather than sending it somewhere unasked —
      // the pair simply takes another pass to clear.
      if (lockX) ux = 0;

      const push = (min - d) * 0.5 * strength;
      a.pos.x += ux * push; a.pos.y += uy * push; a.pos.z += uz * push;
      b.pos.x -= ux * push; b.pos.y -= uy * push; b.pos.z -= uz * push;

      // Cancel the velocity that is still driving these two together. Without this the position
      // fix is undone by the very next integration step and the pair vibrates — visible in the
      // running app as nodes darting back and forth, and invisible to a unit test that steps the
      // constraint with no forces in between.
      if (velocityDamping > 0) {
        if (a.vel) {
          const into = a.vel.x * ux + a.vel.y * uy + a.vel.z * uz;
          if (into < 0) {
            const k = into * velocityDamping;
            a.vel.x -= ux * k; a.vel.y -= uy * k; a.vel.z -= uz * k;
          }
        }
        if (b.vel) {
          // b is pushed along -u, so its inward direction is +u.
          const into = b.vel.x * ux + b.vel.y * uy + b.vel.z * uz;
          if (into > 0) {
            const k = into * velocityDamping;
            b.vel.x -= ux * k; b.vel.y -= uy * k; b.vel.z -= uz * k;
          }
        }
      }
      separated++;
    }
  }
  return separated;
}

/**
 * Does this pair still overlap? Exposed because "all visible" is the feature's whole claim, and a
 * claim that is never checked is the kind of green-over-nothing coverage this repo keeps finding.
 */
export function overlaps(
  a: Positioned,
  b: Positioned,
  radiusOf: (n: Positioned) => number,
  opts: { lockX?: boolean; basis?: ViewBasis | null; tolerance?: number } = {},
): boolean {
  const { lockX = false, basis = null, tolerance = 0 } = opts;
  const ax = a.pos.x - b.pos.x, ay = a.pos.y - b.pos.y, az = a.pos.z - b.pos.z;
  // The checker must speak the same tolerance as the solver. A solver that deliberately leaves up
  // to `slop` of overlap, paired with a checker demanding exact clearance, reports failure forever
  // on a layout that is doing precisely what it was asked to.
  const min = radiusOf(a) + radiusOf(b) - tolerance - 1e-9;
  if (basis) {
    // Same measure the solver uses: what the viewer sees, not what the world coordinates say.
    return Math.hypot(dot(basis.right, ax, ay, az), dot(basis.up, ax, ay, az)) < min;
  }
  const dx = lockX ? 0 : ax;
  return Math.sqrt(dx * dx + ay * ay + az * az) < min;
}
