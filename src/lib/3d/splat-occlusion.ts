/**
 * F58.9.13 (kb:splat-occlusion): an entity's Gaussian splat hides what is behind it.
 *
 * Splats are blended without writing depth (gaussian-splat-lite's own `depthWrite` is off "because most of
 * a Splat is transparent"; turning it on would let a splat's faint fringe hide markers), so a marker, edge
 * or label behind an entity splat drew straight through it. The fix has two halves, both driven by the numbers
 * here:
 *   1. WebGL objects (markers, edges): a depth-only BackSide sphere per entity splat, drawn before them, sized
 *      `OCCLUDER_CORE_FRACTION` of the splat's bounding radius. Only the FAR hemisphere writes depth, so the
 *      splat itself (which sits in front of that shell) is not clipped, and whatever is beyond it is.
 *   2. HTML labels (not depth-tested by WebGL): the existing sphere-occlusion pass in the 3D scene component drops a
 *      label inside a closer entity's disc; a drawn entity splat now widens that disc to `projectedRadius` of its core.
 *
 * A background room never occludes: only items marked `occludes` get a proxy.
 */

/**
 * Fraction of a splat's bounding-sphere radius that the depth proxy fills. NOT fitted to each splat's
 * opacity (the renderer exposes no per-splat opacity statistics): 0.8 keeps the proxy inside the box-fitted
 * bounding sphere, whose corners are mostly empty, so the proxy stays within the splat's visible body.
 */
export const OCCLUDER_CORE_FRACTION = 0.8;

/** World radius of an entity splat's depth proxy, from the splat's world bounding radius. */
export function occluderRadius(splatWorldRadius: number, fraction = OCCLUDER_CORE_FRACTION): number {
  if (!Number.isFinite(splatWorldRadius) || splatWorldRadius <= 0) return 0;
  return splatWorldRadius * Math.min(1, Math.max(0, fraction));
}

/** Pixel radius of a world sphere seen from `dist` away, for a camera of vertical half-FOV tangent `halfTan`. */
export function projectedRadius(worldRadius: number, dist: number, halfTan: number, halfHeightPx: number): number {
  if (dist <= 0 || halfTan <= 0) return 0;
  return (worldRadius / (halfTan * dist)) * halfHeightPx;
}
