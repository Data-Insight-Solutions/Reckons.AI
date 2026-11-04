// F260.1 — the condition vocabulary. A condition is text such as `inside(ball, cup-zone)`. It is
// PARSED against a closed vocabulary and validated against the scene's body ids; a text that does
// not parse or names an unknown body is reported and never evaluated. Evaluation is plain
// arithmetic over a SimResult, so the verdict is deterministic and checkable.
import type { Scene, Vec3 } from './scene';
import { halfExtents } from './scene';
import type { SimResult } from './world';

/** Speed (world units per second) below which a body counts as at rest. */
export const REST_SPEED = 0.05;

export type Aabb = { min: Vec3; max: Vec3 };
export type Target = { kind: 'body'; id: string } | { kind: 'all' };
export type Region = { kind: 'body'; id: string } | { kind: 'aabb'; box: Aabb };

export type Condition =
  | { op: 'inside'; body: string; region: Region }
  | { op: 'restsOn'; a: string; b: string }
  | { op: 'aboveFloor'; target: Target; y: number }
  | { op: 'reachesHeight'; body: string; h: number }
  | { op: 'atRest'; target: Target }
  | { op: 'within'; a: string; b: string; distance: number };

export interface ConditionResult { text: string; ok: boolean; detail: string }

/** Split on commas that are not inside parentheses. */
function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth < 0) return null; }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (depth !== 0) return null;
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

const num = (s: string): number | null => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** Parse and validate one condition text. Returns the Condition or `{ error }`. */
export function parseCondition(text: string, scene: Scene): Condition | { error: string } {
  const m = /^\s*([A-Za-z]+)\s*\((.*)\)\s*$/s.exec(text);
  if (!m) return { error: `not of the form name(args): "${text}"` };
  const [, op, inner] = m;
  const args = splitArgs(inner);
  if (!args || args.some((a) => a === '')) return { error: `bad argument list in "${text}"` };
  const ids = new Set(scene.bodies.map((b) => b.id));
  const body = (a: string): string | { error: string } => (ids.has(a) ? a : { error: `unknown body "${a}" (bodies: ${[...ids].join(', ') || 'none'})` });
  const isErr = (x: unknown): x is { error: string } => typeof x === 'object' && x !== null && 'error' in x;
  const arity = (n: number) => (args.length === n ? null : { error: `${op} takes ${n} arguments, got ${args.length}` });
  const target = (a: string): Target | { error: string } => {
    if (a === 'all') return { kind: 'all' };
    const b = body(a);
    return isErr(b) ? b : { kind: 'body', id: b };
  };

  switch (op) {
    case 'inside': {
      const e = arity(2); if (e) return e;
      const b = body(args[0]); if (isErr(b)) return b;
      const ra = /^aabb\((.*)\)$/s.exec(args[1]);
      if (ra) {
        const v = ra[1].split(',').map((x) => num(x.trim()));
        if (v.length !== 6 || v.some((x) => x === null)) return { error: 'aabb needs six numbers: aabb(x1,y1,z1,x2,y2,z2)' };
        const [x1, y1, z1, x2, y2, z2] = v as number[];
        return { op, body: b, region: { kind: 'aabb', box: { min: [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)], max: [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)] } } };
      }
      const r = body(args[1]); if (isErr(r)) return r;
      return { op, body: b, region: { kind: 'body', id: r } };
    }
    case 'restsOn': {
      const e = arity(2); if (e) return e;
      const a = body(args[0]); if (isErr(a)) return a;
      const b = body(args[1]); if (isErr(b)) return b;
      return { op, a, b };
    }
    case 'aboveFloor': {
      const e = arity(2); if (e) return e;
      const t = target(args[0]); if (isErr(t)) return t;
      const y = num(args[1]); if (y === null) return { error: `aboveFloor needs a number height, got "${args[1]}"` };
      return { op, target: t, y };
    }
    case 'reachesHeight': {
      const e = arity(2); if (e) return e;
      const b = body(args[0]); if (isErr(b)) return b;
      const h = num(args[1]); if (h === null) return { error: `reachesHeight needs a number, got "${args[1]}"` };
      return { op, body: b, h };
    }
    case 'atRest': {
      const e = arity(1); if (e) return e;
      const t = target(args[0]); if (isErr(t)) return t;
      return { op, target: t };
    }
    case 'within': {
      const e = arity(3); if (e) return e;
      const a = body(args[0]); if (isErr(a)) return a;
      const b = body(args[1]); if (isErr(b)) return b;
      const d = num(args[2]); if (d === null || d < 0) return { error: `within needs a distance >= 0, got "${args[2]}"` };
      return { op, a, b, distance: d };
    }
    default:
      return { error: `unknown condition "${op}" (use inside, restsOn, aboveFloor, reachesHeight, atRest, within)` };
  }
}

const f = (n: number) => n.toFixed(3);
const speed = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** The dynamic body ids a target refers to. */
function targetIds(t: Target, scene: Scene): string[] {
  return t.kind === 'all' ? scene.bodies.filter((b) => !b.isStatic).map((b) => b.id) : [t.id];
}

export function evaluateCondition(c: Condition, scene: Scene, run: SimResult, text: string): ConditionResult {
  const done = (ok: boolean, detail: string): ConditionResult => ({ text, ok, detail });
  const pos = (id: string) => run.final[id].position;
  switch (c.op) {
    case 'inside': {
      let box: Aabb;
      if (c.region.kind === 'aabb') box = c.region.box;
      else {
        const rb = scene.bodies.find((b) => b.id === (c.region as { id: string }).id)!;
        const he = halfExtents(rb.shape), p = pos(rb.id);
        box = { min: [p[0] - he[0], p[1] - he[1], p[2] - he[2]], max: [p[0] + he[0], p[1] + he[1], p[2] + he[2]] };
      }
      const p = pos(c.body);
      const ok = [0, 1, 2].every((i) => p[i] >= box.min[i] && p[i] <= box.max[i]);
      return done(ok, `${c.body} centre at (${p.map(f).join(', ')}); region ${box.min.map(f).join(',')} to ${box.max.map(f).join(',')}`);
    }
    case 'restsOn': {
      const touching = run.contacts.some(([x, y]) => (x === c.a && y === c.b) || (x === c.b && y === c.a));
      const v = speed(run.final[c.a].velocity);
      return done(touching && v < REST_SPEED, `${touching ? 'touching' : 'not touching'} at the end, ${c.a} speed ${f(v)} (rest below ${REST_SPEED})`);
    }
    case 'aboveFloor': {
      const ids = targetIds(c.target, scene);
      const low = ids.map((id) => [id, run.minY[id]] as const).sort((a, b) => a[1] - b[1])[0];
      return done(!low || low[1] >= c.y, low ? `lowest centre ${low[0]} at y=${f(low[1])} over the whole run (floor ${c.y})` : 'no dynamic bodies');
    }
    case 'reachesHeight':
      return done(run.maxY[c.body] >= c.h, `${c.body} highest centre y=${f(run.maxY[c.body])} (needs ${c.h})`);
    case 'atRest': {
      const ids = targetIds(c.target, scene);
      const fast = ids.map((id) => [id, speed(run.final[id].velocity)] as const).sort((a, b) => b[1] - a[1])[0];
      return done(!fast || fast[1] < REST_SPEED, fast ? `fastest at the end: ${fast[0]} ${f(fast[1])} (rest below ${REST_SPEED})` : 'no dynamic bodies');
    }
    case 'within': {
      const a = pos(c.a), b = pos(c.b);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return done(d <= c.distance, `${c.a} to ${c.b} centre distance ${f(d)} (limit ${c.distance})`);
    }
  }
}

/** Parse, validate and evaluate. A text that fails to parse yields ok=false with the reason; it is never run. */
export function checkConditions(texts: string[], scene: Scene, run: SimResult): ConditionResult[] {
  return texts.map((text) => {
    const c = parseCondition(text, scene);
    if ('error' in c) return { text, ok: false, detail: `REFUSED: ${c.error}` };
    return evaluateCondition(c, scene, run, text);
  });
}
