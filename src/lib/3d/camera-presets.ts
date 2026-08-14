/**
 * AIMING THE 3D CAMERA — so a visual test can shoot the graph from somewhere other than
 * dead ahead.
 *
 * WHY THIS EXISTS (Matt, 2026-08-13: "can we control the angle of the viewport in our visual
 * tests? currently our forces are 'flat' even in 3D, but we may want more 3d forces later").
 *
 * The camera was `<T.PerspectiveCamera position={[0, 0, 18]} />` — a hardcoded literal looking
 * straight down −z — with OrbitControls that only respond to a real pointer. So there was no
 * way to aim it from a test, and that is worse than an inconvenience: MOST LAYOUTS PIN z TO 0
 * (type, hub and timeline place every anchor at z=0; only focus, source and hierarchy use the
 * third axis at all). A head-on camera over a flat layout renders identically whether z is
 * honoured or ignored, so the 3D renderer was effectively UNTESTED AS 3D — a regression that
 * flattened the remaining depth would have passed every visual check.
 *
 * Fixing the camera is therefore a prerequisite for adding genuinely 3D forces, not a
 * convenience for the ones that exist: a force that uses depth cannot be regression-tested
 * from an angle that cannot see depth.
 *
 * SPHERICAL, NOT CARTESIAN, because the useful request is "show me this from up and to the
 * left", not a coordinate triple. Azimuth and elevation in degrees survive a URL, read
 * clearly in a test name, and stay meaningful when the scene is rescaled.
 */

export type CameraSpec = { azimuth: number; elevation: number; distance: number };

/** The default matches the historical hardcoded camera exactly: straight down −z at 18 units. */
export const CAMERA_PRESETS = {
  /** Dead ahead — the original view, and what every existing screenshot was taken with. */
  front: { azimuth: 0, elevation: 0, distance: 18 },
  /** Three-quarter view. The one that actually reveals depth, so the default for 3D checks. */
  iso: { azimuth: 35, elevation: 25, distance: 20 },
  /** Straight down. A flat z=0 layout looks like a LINE from here — which is the point: it
   *  makes "is this layout actually flat?" a visible question rather than an invisible one. */
  top: { azimuth: 0, elevation: 89, distance: 20 },
  /** From the side. Also collapses a z=0 layout to a line, along the other axis. */
  side: { azimuth: 90, elevation: 0, distance: 20 },
} as const satisfies Record<string, CameraSpec>;

export type CameraPresetName = keyof typeof CAMERA_PRESETS;

export function isCameraPreset(name: string): name is CameraPresetName {
  return Object.prototype.hasOwnProperty.call(CAMERA_PRESETS, name);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Parse a `?cam=` value into a spec, or null when absent/unusable.
 *
 * Accepts a preset name (`iso`) or an explicit `azimuth,elevation[,distance]` triple in
 * degrees (`35,25,20`). Returns null rather than a default on garbage so the caller keeps its
 * own default and a typo cannot silently move the camera — a visual baseline captured from an
 * unintended angle is a broken baseline that still passes.
 */
export function parseCameraSpec(raw: string | null | undefined): CameraSpec | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (isCameraPreset(value)) return { ...CAMERA_PRESETS[value] };

  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((n) => !Number.isFinite(n))) return null;

  const [azimuth, elevation, distance] = parts;
  return {
    azimuth,
    // Beyond ±90 the view flips over the pole, which reads as an unexplained upside-down
    // scene rather than as the angle that was asked for.
    elevation: clamp(elevation, -89.9, 89.9),
    distance: distance !== undefined ? clamp(distance, 1, 500) : CAMERA_PRESETS.front.distance,
  };
}

/**
 * Spec → world position, with the scene centred on the origin.
 *
 * y is up (matching three.js and the layout builders, which spread nodes across x/y), so
 * elevation lifts the camera on y and azimuth swings it around that axis.
 */
export function cameraPosition(spec: CameraSpec): [number, number, number] {
  const az = (spec.azimuth * Math.PI) / 180;
  const el = (spec.elevation * Math.PI) / 180;
  const d = spec.distance;
  return [
    d * Math.cos(el) * Math.sin(az),
    d * Math.sin(el),
    d * Math.cos(el) * Math.cos(az),
  ];
}

/**
 * Does this angle reveal the z axis at all?
 *
 * A camera looking straight down −z (azimuth and elevation both ~0) projects every z value
 * onto the same screen point, so depth is invisible from there. A visual test that means to
 * exercise a 3D force must not be shot from such an angle, and this makes that assertable
 * rather than a matter of reviewer attention.
 */
export function revealsDepth(spec: CameraSpec, toleranceDeg = 5): boolean {
  const az = Math.abs(((spec.azimuth % 360) + 360) % 360);
  const azOffAxis = Math.min(az, Math.abs(az - 180), Math.abs(az - 360));
  return azOffAxis > toleranceDeg || Math.abs(spec.elevation) > toleranceDeg;
}
