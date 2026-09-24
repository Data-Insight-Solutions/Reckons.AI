import { describe, it, expect } from 'vitest';
import {
  collageRadius,
  resolveOverlaps,
  overlaps,
  previewWorldRadius,
  CAM_HALF_TAN,
  type Positioned, markerWorldRadius, glbWorldRadius, degreeScale, SELECTED_NODE_SCALE } from '../preview-collage';

/** Matches the solver's default slop, so the checker tolerates exactly what the solver leaves. */
const SLOP = 0.02;

const at = (key: string, x: number, y: number, z = 0): Positioned => ({ key, pos: { x, y, z } });

/** Run to convergence the way the frame loop does, rather than asserting one pass is enough. */
function settle(nodes: Positioned[], radiusOf: (n: Positioned) => number, opts = {}, frames = 200) {
  let last = 0;
  for (let i = 0; i < frames; i++) last = resolveOverlaps(nodes, radiusOf, opts);
  return last;
}

describe('collageRadius', () => {
  it('leaves a node without a preview at its base radius', () => {
    expect(collageRadius(false, 0.4, 3)).toBe(0.4);
  });

  it('uses the half-DIAGONAL of the billboard, not the half-width', () => {
    // A square preview rotated to face the camera still occupies its corners. Half-width would
    // let two previews touch corner-to-corner while the math called them clear.
    expect(collageRadius(true, 0.4, 2)).toBeCloseTo(Math.SQRT2, 5);
    expect(collageRadius(true, 0.4, 2)).toBeGreaterThan(1); // > half-width
  });

  it('never shrinks a node below what it already occupied', () => {
    expect(collageRadius(true, 5, 0.1)).toBe(5);
  });
});

describe('previewWorldRadius — screen pixels back into world units', () => {
  it('round-trips the projection KnowledgeGraph uses', () => {
    // Forward:  screenRadius = (worldRadius / (CAM_HALF_TAN * dist)) * halfH
    const dist = 18, halfH = 360, px = 96;
    const world = previewWorldRadius(px, dist, halfH);
    const backToPx = (world / (CAM_HALF_TAN * dist)) * halfH;
    expect(backToPx).toBeCloseTo((px * Math.SQRT2) / 2, 6);
  });

  it('CLAIMS MORE WORLD ROOM AS THE CAMERA PULLS BACK — the property that makes it hold at any zoom', () => {
    // A thumbnail stays 96px whatever the zoom, so twice as far away means twice the world span.
    const near = previewWorldRadius(96, 10, 360);
    const far = previewWorldRadius(96, 20, 360);
    expect(far).toBeCloseTo(near * 2, 6);
  });

  it('scales with the configured preview size', () => {
    expect(previewWorldRadius(192, 18, 360)).toBeCloseTo(previewWorldRadius(96, 18, 360) * 2, 6);
  });

  it('returns 0 rather than Infinity or NaN on a degenerate viewport', () => {
    // A canvas can genuinely be 0px tall for a frame during mount; dividing by it would write
    // Infinity into every position and empty the scene with no error.
    expect(previewWorldRadius(96, 18, 0)).toBe(0);
    expect(previewWorldRadius(96, 0, 360)).toBe(0);
  });
});

describe('resolveOverlaps', () => {
  const r1 = () => 1;

  it('separates an overlapping pair', () => {
    const a = at('a', 0, 0), b = at('b', 0.5, 0);
    expect(overlaps(a, b, r1, { tolerance: SLOP })).toBe(true);
    settle([a, b], r1);
    expect(overlaps(a, b, r1, { tolerance: SLOP })).toBe(false);
  });

  it('leaves a pair that already clears each other alone', () => {
    const a = at('a', 0, 0), b = at('b', 5, 0);
    const before = { ...b.pos };
    expect(resolveOverlaps([a, b], r1)).toBe(0);
    expect(b.pos).toEqual(before);
  });

  it('pushes both nodes, not just one — no node is privileged', () => {
    const a = at('a', -0.25, 0), b = at('b', 0.25, 0);
    settle([a, b], r1);
    expect(a.pos.x).toBeLessThan(-0.25);
    expect(b.pos.x).toBeGreaterThan(0.25);
  });

  it('CLEARS A DENSE CLUSTER COMPLETELY — the property the feature is named for', () => {
    // Nine nodes stacked nearly on top of each other: the realistic case, since a fresh graph
    // starts every node near the origin.
    const nodes = Array.from({ length: 9 }, (_, i) => at(`n${i}`, (i % 3) * 0.1, Math.floor(i / 3) * 0.1));
    settle(nodes, r1, {}, 600);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j], r1, { tolerance: SLOP }), `${nodes[i].key} vs ${nodes[j].key}`).toBe(false);
      }
    }
  });

  it('respects mixed radii — a big preview claims more room than a bare glyph', () => {
    const big = at('big', 0, 0), small = at('small', 0.5, 0);
    const radius = (n: Positioned) => (n.key === 'big' ? 2 : 0.3);
    settle([big, small], radius);
    const gap = Math.hypot(big.pos.x - small.pos.x, big.pos.y - small.pos.y);
    // 2 + 0.3, less the slop the solver is allowed to leave on the table.
    expect(gap).toBeGreaterThanOrEqual(2.3 - SLOP - 1e-6);
  });
});

describe('the timeline x-lock survives the modifier', () => {
  // The x-lock exists because repulsion and springs used to negotiate the date axis away. A
  // separation free to push along x would reintroduce that bug from a new direction.
  const r1 = () => 1;

  it('NEVER moves a node along x when lockX is set', () => {
    const a = at('a', 10, 0), b = at('b', 10, 0.5);
    settle([a, b], r1, { lockX: true });
    expect(a.pos.x).toBe(10);
    expect(b.pos.x).toBe(10);
  });

  it('still separates them, in y/z', () => {
    const a = at('a', 10, 0), b = at('b', 10, 0.5);
    settle([a, b], r1, { lockX: true });
    expect(overlaps(a, b, r1, { lockX: true, tolerance: SLOP })).toBe(false);
  });

  it('treats nodes far apart in x but stacked in y/z as OVERLAPPING under lockX', () => {
    // They are billboards facing the camera: a wide x gap does not stop them covering each other
    // on screen. Measuring the true 3D distance here would call this clear and be wrong.
    const a = at('a', 0, 0), b = at('b', 50, 0.1);
    expect(overlaps(a, b, r1, { lockX: true, tolerance: SLOP })).toBe(true);
    settle([a, b], r1, { lockX: true });
    expect(overlaps(a, b, r1, { lockX: true, tolerance: SLOP })).toBe(false);
    expect(a.pos.x).toBe(0); // and the dates held
    expect(b.pos.x).toBe(50);
  });
});

describe('screen-plane separation — the bug the world-space version could not see', () => {
  // A camera looking down -z: right is +x, up is +y, and z is DEPTH.
  const basis = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
  const r1 = () => 1;

  it('COUNTS TWO NODES SEPARATED ONLY IN DEPTH AS OVERLAPPING', () => {
    // This is the whole defect. In world space these are 10 units apart and the constraint is
    // satisfied; on screen one sits exactly on top of the other. Measured on the real fixture,
    // world-space separation converged and still left ~20% of the thumbnail area covered.
    const a = at('a', 0, 0, 0), b = at('b', 0, 0, 10);
    expect(overlaps(a, b, r1), 'world space calls it clear').toBe(false);
    expect(overlaps(a, b, r1, { basis, tolerance: SLOP }), 'the viewer sees a pile').toBe(true);
  });

  it('separates them within the plane, leaving depth alone', () => {
    const a = at('a', 0, 0, 0), b = at('b', 0, 0, 10);
    settle([a, b], r1, { basis });
    expect(overlaps(a, b, r1, { basis, tolerance: SLOP })).toBe(false);
    // Depth untouched: pushing along z would have been the easy, useless answer.
    expect(a.pos.z).toBe(0);
    expect(b.pos.z).toBe(10);
  });

  it('clears a dense cluster AS PROJECTED, not merely in world coordinates', () => {
    // Nodes spread across depth but stacked in the view plane — exactly what a force-directed
    // layout produces, and exactly what looked separated while reading as a pile.
    const nodes = Array.from({ length: 8 }, (_, i) => at(`n${i}`, (i % 2) * 0.2, 0.1 * i, i * 3));
    settle(nodes, r1, { basis }, 400);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j], r1, { basis, tolerance: SLOP }), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it('honours a tilted camera basis rather than assuming an axis-aligned view', () => {
    const s = Math.SQRT1_2;
    const tilted = { right: { x: s, y: s, z: 0 }, up: { x: -s, y: s, z: 0 } };
    const a = at('a', 0, 0, 0), b = at('b', 0.3, 0.3, 0);
    settle([a, b], r1, { basis: tilted });
    expect(overlaps(a, b, r1, { basis: tilted, tolerance: SLOP })).toBe(false);
  });

  it('still never moves x when the timeline lock is on, even in plane mode', () => {
    // Both constraints at once: separate in what the viewer sees, but the date axis outranks it.
    const a = at('a', 5, 0, 0), b = at('b', 5, 0.1, 0);
    settle([a, b], r1, { basis, lockX: true }, 400);
    expect(a.pos.x).toBe(5);
    expect(b.pos.x).toBe(5);
  });
});

describe('degenerate input cannot produce NaN', () => {
  // Two nodes at exactly the same point have no separation axis. A naive normalize divides by
  // zero, writes NaN into the position, and the node disappears from the scene with no error.
  const r1 = () => 1;

  it('separates perfectly coincident nodes instead of emitting NaN', () => {
    const a = at('a', 3, 3, 3), b = at('b', 3, 3, 3);
    settle([a, b], r1);
    for (const n of [a, b]) {
      expect(Number.isFinite(n.pos.x), 'x').toBe(true);
      expect(Number.isFinite(n.pos.y), 'y').toBe(true);
      expect(Number.isFinite(n.pos.z), 'z').toBe(true);
    }
    expect(overlaps(a, b, r1, { tolerance: SLOP })).toBe(false);
  });

  it('is DETERMINISTIC for coincident nodes — same input, same result', () => {
    // A random nudge would work once and make the layout jitter differently every reload, and
    // would make this test flaky rather than failing honestly.
    const run = () => {
      const a = at('a', 0, 0), b = at('b', 0, 0);
      settle([a, b], r1);
      return [a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z];
    };
    expect(run()).toEqual(run());
  });

  it('separates coincident nodes without touching x under lockX', () => {
    const a = at('a', 7, 0, 0), b = at('b', 7, 0, 0);
    settle([a, b], r1, { lockX: true });
    expect(a.pos.x).toBe(7);
    expect(b.pos.x).toBe(7);
    expect(overlaps(a, b, r1, { lockX: true, tolerance: SLOP })).toBe(false);
  });
});

describe('the O(n^2) guard', () => {
  it('does nothing past maxNodes rather than stalling the frame', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => at(`n${i}`, 0, 0));
    expect(resolveOverlaps(nodes, () => 1, { maxNodes: 5 })).toBe(0);
    expect(nodes[0].pos).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('runs when the graph is within budget', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => at(`n${i}`, 0, 0));
    expect(resolveOverlaps(nodes, () => 1, { maxNodes: 50 })).toBeGreaterThan(0);
  });
});

/**
 * GLB NODES, WHICH ARE THE CASE THAT WAS NOT COVERED.
 *
 * Matt reported models colliding on a real graph (2026-09-23) and I first claimed no automated
 * test could reach it. That was wrong twice: resolveOverlaps is a pure exported function with
 * this very test file beside it, and the app already ships an example model. The real defect was
 * that both the radius map and this solver were gated on the collage modifier, so a GLB — whose
 * world size is whatever its author exported, routinely an order of magnitude past a marker's
 * 0.32 — was spaced as though it were a marker in every ordinary view.
 *
 * These assert the PROPERTY rather than a screenshot: given radii that differ by an order of
 * magnitude, nothing ends up closer than the two radii it needs. A pixel comparison would catch
 * a change; this catches the thing being wrong.
 */
describe('separation when radii differ by an order of magnitude (GLB beside markers)', () => {
  const MARKER = 0.32;
  const MODEL = 3.2; // a Meshy-scale export against a default marker

  const radiusFor = (big: Set<string>) => (n: Positioned) => (big.has(n.key) ? MODEL : MARKER);

  it('pushes a model clear of a marker sitting on top of it', () => {
    const nodes = [at('model', 0, 0), at('marker', 0.1, 0)];
    const big = new Set(['model']);
    resolveOverlaps(nodes, radiusFor(big), { strength: 1, iterations: 24 });
    const d = Math.hypot(nodes[0].pos.x - nodes[1].pos.x, nodes[0].pos.y - nodes[1].pos.y, nodes[0].pos.z - nodes[1].pos.z);
    expect(d).toBeGreaterThanOrEqual(MODEL + MARKER - SLOP);
  });

  it('separates two models from each other, not just from markers', () => {
    const nodes = [at('a', 0, 0), at('b', 0.5, 0.2)];
    const big = new Set(['a', 'b']);
    resolveOverlaps(nodes, radiusFor(big), { strength: 1, iterations: 24 });
    const d = Math.hypot(nodes[0].pos.x - nodes[1].pos.x, nodes[0].pos.y - nodes[1].pos.y, nodes[0].pos.z - nodes[1].pos.z);
    expect(d).toBeGreaterThanOrEqual(MODEL * 2 - SLOP);
  });

  it('leaves no overlapping pair in a mixed cluster', () => {
    const nodes = [
      at('m1', 0, 0), at('m2', 0.4, 0.1), at('m3', -0.3, 0.2),
      at('n1', 0.1, -0.1), at('n2', -0.2, -0.3), at('n3', 0.2, 0.3),
    ];
    const big = new Set(['m1', 'm2', 'm3']);
    const r = radiusFor(big);
    resolveOverlaps(nodes, r, { strength: 1, iterations: 40 });
    // overlaps() compares ONE pair, so check every pair and name the ones that fail.
    const still: string[] = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (overlaps(nodes[i], nodes[j], r, { tolerance: SLOP })) still.push(`${nodes[i].key}/${nodes[j].key}`);
    expect(still).toEqual([]);
  });

  // The bug was never that separation is impossible — it is that nothing asked for it outside
  // collage. A uniform radius spreads to 2*0.32 and calls it done, which is what the layout did
  // to a model ten times that size.
  it('a uniform marker radius leaves models overlapping, which is the defect', () => {
    const nodes = [at('model-a', 0, 0), at('model-b', 0.1, 0)];
    resolveOverlaps(nodes, () => MARKER, { strength: 1, iterations: 24 });
    const d = Math.hypot(nodes[0].pos.x - nodes[1].pos.x, nodes[0].pos.y - nodes[1].pos.y, nodes[0].pos.z - nodes[1].pos.z);
    expect(d).toBeLessThan(MODEL * 2); // spaced as markers — still colliding as models
  });
});


/**
 * THE RADIUS DERIVATION, which is where both GLB bugs actually lived.
 *
 * The solver above was already covered; the arithmetic that tells it how big each node is was
 * not, because it sat inline in a .svelte file. It has now been wrong twice — once by giving
 * every node a uniform radius (PR #281), once by applying the MARKER unit-sphere conversion to
 * a model as well and under-reporting every GLB by about a factor of three (2026-09-24, "the
 * GLB nodes need more space also"). Both were invisible to the solver's own tests, which
 * happily separate whatever radii they are handed.
 */
describe('node layout radius derivation', () => {
  it('a marker is the degree scale times the unit-sphere radius', () => {
    expect(markerWorldRadius(0)).toBeCloseTo(degreeScale(0) * 0.32, 6);
    expect(markerWorldRadius(7)).toBeCloseTo(degreeScale(7) * 0.32, 6);
  });

  it('a GLB does NOT get the marker conversion — that was the bug', () => {
    // GraphNode draws the model at `scale * 0.8` with `scale` the RAW degree scale, so the
    // world radius carries no 0.32. The old code multiplied it in and made every model a
    // third of its drawn size.
    const intrinsic = 2.5;
    const s = degreeScale(3);
    // model body (scale * 0.8) PLUS the lift GraphNode applies (scale * 0.55), because the
    // reserved circle is centred on node.pos and the model is not.
    expect(glbWorldRadius(intrinsic, 3)).toBeCloseTo(intrinsic * s * 0.8 + s * 0.55, 6);
    // the old, wrong value — marker conversion applied to a model
    expect(glbWorldRadius(intrinsic, 3)).not.toBeCloseTo(intrinsic * s * 0.32 * 0.8, 3);
  });

  it('a unit-radius model claims meaningfully more room than a marker of the same degree', () => {
    // (0.8 + 0.55) / 0.32 = 4.21875 for a unit-radius model: body plus the draw lift, against
    // the marker's unit sphere. The old code produced 0.8x — LESS than a marker — which is how
    // models ended up with less room than the dots beside them.
    const ratio = glbWorldRadius(1, 5) / markerWorldRadius(5);
    expect(ratio).toBeCloseTo((0.8 + 0.55) / 0.32, 6);
    expect(ratio).toBeGreaterThan(1);
  });

  it('radius grows with degree in both, and never goes backwards', () => {
    for (let d = 0; d < 20; d++) {
      expect(markerWorldRadius(d + 1)).toBeGreaterThan(markerWorldRadius(d));
      expect(glbWorldRadius(1, d + 1)).toBeGreaterThan(glbWorldRadius(1, d));
    }
  });

  it('the selection scale is the single shared figure, not a local copy', () => {
    // Three call sites read this: the mesh, the DOM thumbnail and the layout radius. The bug
    // was that only the first knew about it.
    expect(SELECTED_NODE_SCALE).toBeGreaterThan(1);
  });
});
