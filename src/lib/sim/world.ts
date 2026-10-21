// F260.1 — the fixed-step runner. Rapier (WASM) is loaded with a dynamic import() only when a run
// starts, so it never enters the main app bundle. No wall clock, no randomness: the same scene,
// steps and dt give the same poses on the same build.
import type { Scene, Vec3 } from './scene';
import { MAX_BODIES } from './scene';

export const MAX_STEPS = 20_000;
export const DEFAULT_DT = 1 / 60;
export const GRAVITY = -9.81;

export interface Pose {
  position: Vec3;
  /** Quaternion x y z w. */
  rotation: [number, number, number, number];
  velocity: Vec3;
}
export interface Frame { step: number; t: number; poses: Record<string, Pose> }
export interface SimOptions { steps: number; dt?: number; sampleEvery?: number }
export interface SimResult {
  steps: number;
  dt: number;
  final: Record<string, Pose>;
  trajectory: Frame[];
  /** Exact per-step extremes of height, per body (not limited by sampling). */
  maxY: Record<string, number>;
  minY: Record<string, number>;
  /** Pairs of body ids in contact at the final step (sorted, each pair sorted). */
  contacts: [string, string][];
}

export class SimRefusal extends Error {}

let rapierPromise: Promise<typeof import('@dimforge/rapier3d-compat').default> | null = null;
async function loadRapier() {
  if (!rapierPromise) {
    rapierPromise = import('@dimforge/rapier3d-compat').then(async (m) => {
      await m.default.init();
      return m.default;
    });
  }
  return rapierPromise;
}


export async function simulate(scene: Scene, opts: SimOptions): Promise<SimResult> {
  const dt = opts.dt ?? DEFAULT_DT;
  const { steps } = opts;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw new SimRefusal(`steps must be an integer from 1 to ${MAX_STEPS}, got ${steps}`);
  if (!(dt > 0 && dt <= 0.1)) throw new SimRefusal(`dt must be in (0, 0.1], got ${dt}`);
  if (scene.bodies.length === 0) throw new SimRefusal('the scene has no bodies');
  if (scene.bodies.length > MAX_BODIES) throw new SimRefusal(`${scene.bodies.length} bodies exceeds the limit of ${MAX_BODIES}`);
  const sampleEvery = Math.max(1, Math.floor(opts.sampleEvery ?? 10));

  const R = await loadRapier();
  const world = new R.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = dt;

  const handles: { id: string; body: import('@dimforge/rapier3d-compat').RigidBody; collider: import('@dimforge/rapier3d-compat').Collider }[] = [];
  for (const b of scene.bodies) {
    // rotation = yaw about y, after tilt about z: q = qy * qz
    const hy = (b.yaw * Math.PI) / 360, hz = (b.tilt * Math.PI) / 360;
    const sy = Math.sin(hy), cy = Math.cos(hy), sz = Math.sin(hz), cz = Math.cos(hz);
    const rb = world.createRigidBody(
      (b.isStatic ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
        .setTranslation(b.position[0], b.position[1], b.position[2])
        .setRotation({ x: sy * sz, y: sy * cz, z: cy * sz, w: cy * cz })
        .setLinvel(b.velocity[0], b.velocity[1], b.velocity[2]),
    );
    const s = b.shape;
    const desc =
      s.kind === 'box' ? R.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2)
      : s.kind === 'sphere' ? R.ColliderDesc.ball(s.r)
      : R.ColliderDesc.capsule(s.halfHeight, s.r);
    desc.setFriction(b.friction).setRestitution(b.restitution);
    if (b.isSensor) desc.setSensor(true);
    if (!b.isStatic) desc.setMass(b.mass);
    handles.push({ id: b.id, body: rb, collider: world.createCollider(desc, rb) });
  }

  const snapshot = (): Record<string, Pose> => {
    const out: Record<string, Pose> = {};
    for (const h of handles) {
      const t = h.body.translation(), r = h.body.rotation(), v = h.body.linvel();
      out[h.id] = { position: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w], velocity: [v.x, v.y, v.z] };
    }
    return out;
  };

  const maxY: Record<string, number> = {}, minY: Record<string, number> = {};
  for (const h of handles) { const y = h.body.translation().y; maxY[h.id] = y; minY[h.id] = y; }
  const trajectory: Frame[] = [{ step: 0, t: 0, poses: snapshot() }];
  try {
    for (let i = 1; i <= steps; i++) {
      world.step();
      for (const h of handles) {
        const y = h.body.translation().y;
        if (y > maxY[h.id]) maxY[h.id] = y;
        if (y < minY[h.id]) minY[h.id] = y;
      }
      if (i % sampleEvery === 0 || i === steps) trajectory.push({ step: i, t: i * dt, poses: snapshot() });
    }
    const contacts: [string, string][] = [];
    for (let i = 0; i < handles.length; i++) for (let j = i + 1; j < handles.length; j++) {
      const a = handles[i], b = handles[j];
      if (scene.bodies[i].isSensor || scene.bodies[j].isSensor) continue;
      let touching = false;
      world.contactPair(a.collider, b.collider, (m) => { if (m.numContacts() > 0) touching = true; });
      if (touching) contacts.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
    }
    contacts.sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1));
    return { steps, dt, final: trajectory[trajectory.length - 1].poses, trajectory, maxY, minY, contacts };
  } finally {
    world.free();
  }
}
