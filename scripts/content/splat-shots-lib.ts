/**
 * Pure parts of splat-shots.ts: how a splat is oriented and which cameras shoot it.
 *
 * The default orientation is TripoSplat's (y-down, picture faces +x), which is WRONG for a reconstructed scene:
 * COLMAP and Brush leave the scene in an arbitrary frame whose up is wherever the first camera happened to point.
 * `--up=x,y,z` gives the scene's up direction in file coordinates (for example the normal of the board the object sits
 * on); the shot then turns that direction to +y instead of applying the TripoSplat turn.
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function parseVec3(text: string, what: string): Vec3 {
  const v = text.split(',').map((s) => Number(s.trim()));
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) throw new Error(`${what} must be three numbers x,y,z, got "${text}"`);
  return v as Vec3;
}

/** The shortest rotation taking direction `up` to +y, as a quaternion x,y,z,w. Refuses a zero vector. */
export function quaternionToY(up: Vec3): Quat {
  const len = Math.hypot(...up);
  if (!(len > 1e-9)) throw new Error('up vector has no length');
  const [x, y, z] = up.map((n) => n / len);
  // Rotation from u to (0,1,0): axis u x y = (-z, 0, x), cos = y.
  if (y < -0.999999) return [1, 0, 0, 0]; // opposite: half turn about x
  const w = 1 + y;
  const q: Quat = [-z, 0, x, w];
  const n = Math.hypot(...q);
  return [q[0] / n + 0, q[1] / n + 0, q[2] / n + 0, q[3] / n + 0];
}

export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** `az:el:dist:lookY` separated by commas; a name is `az<az>el<el>`. Distances are multiples of the radius. */
export function parseViews(text: string): [string, number, number, number, number][] {
  return text.split(',').map((part) => {
    const [az, el, dist, lookY = '0'] = part.split(':').map(Number);
    if ([az, el, dist, Number(lookY)].some((n) => !Number.isFinite(n)) || !(dist > 0)) throw new Error(`bad view "${part}", want az:el:dist[:lookY]`);
    return [`az${az}el${el}`, az, el, dist, Number(lookY)] as [string, number, number, number, number];
  });
}
