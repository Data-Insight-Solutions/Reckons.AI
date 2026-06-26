import { describe, it, expect } from 'vitest';
import { cosine, cluster } from '../embed';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a unit vector pointing in one axis direction (for orthogonality tests). */
function unit(length: number, hotIndex: number): Float32Array {
  const v = new Float32Array(length);
  v[hotIndex] = 1;
  return v;
}

/** Build a Float32Array from a plain number array. */
function f32(...values: number[]): Float32Array {
  return new Float32Array(values);
}

/**
 * Normalise a raw vector so cosine() (which assumes pre-normalised inputs)
 * gives correct results. cosine() is a pure dot product.
 */
function normalise(v: Float32Array): Float32Array {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag === 0) return v;
  return v.map((x) => x / mag) as Float32Array;
}

// ── cosine ────────────────────────────────────────────────────────────────────

describe('cosine', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const v = normalise(f32(1, 2, 3));
    expect(cosine(v, v)).toBeCloseTo(1.0, 6);
  });

  it('returns 1.0 for two separately normalised copies of the same vector', () => {
    const a = normalise(f32(3, 4, 0));
    const b = normalise(f32(3, 4, 0));
    expect(cosine(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 0.0 for orthogonal unit vectors', () => {
    const a = unit(3, 0); // [1, 0, 0]
    const b = unit(3, 1); // [0, 1, 0]
    expect(cosine(a, b)).toBeCloseTo(0.0, 6);
  });

  it('returns -1.0 for opposite unit vectors', () => {
    const a = normalise(f32(1, 0, 0));
    const b = normalise(f32(-1, 0, 0));
    expect(cosine(a, b)).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 for a zero vector', () => {
    const zero = f32(0, 0, 0);
    const v = normalise(f32(1, 2, 3));
    // zero vector has magnitude 0; cosine should not blow up
    expect(cosine(zero, v)).toBe(0);
  });

  it('returns a value close to 1 for nearly-identical vectors', () => {
    const a = normalise(f32(1.0, 0.001, 0.001));
    const b = normalise(f32(1.0, 0.002, 0.001));
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThan(0.999);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it('returns a value near 0 for weakly correlated vectors', () => {
    const a = normalise(f32(1, 0, 0, 0));
    const b = normalise(f32(0.1, 0.995, 0, 0));
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(0.2);
  });

  it('handles single-element vectors', () => {
    const a = normalise(f32(5));
    const b = normalise(f32(5));
    expect(cosine(a, b)).toBeCloseTo(1.0, 6);
  });
});

// ── cluster ───────────────────────────────────────────────────────────────────

describe('cluster', () => {
  it('returns an empty array for empty input', () => {
    const result = cluster([], []);
    expect(result).toEqual([]);
  });

  it('returns one cluster for a single item', () => {
    const v = unit(4, 0);
    const result = cluster(['a'], [v]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['a']);
  });

  it('groups two identical vectors into one cluster', () => {
    const v = normalise(f32(1, 2, 3));
    const result = cluster(['x', 'y'], [v, v]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    expect(result[0]).toContain('x');
    expect(result[0]).toContain('y');
  });

  it('keeps two orthogonal vectors in separate clusters', () => {
    const a = unit(4, 0); // [1,0,0,0]
    const b = unit(4, 1); // [0,1,0,0]
    const result = cluster(['a', 'b'], [a, b]);
    expect(result).toHaveLength(2);
    expect(result.flat()).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('keeps nearly-opposite vectors separate', () => {
    const a = normalise(f32(1, 0));
    const b = normalise(f32(-1, 0));
    const result = cluster(['pos', 'neg'], [a, b]);
    expect(result).toHaveLength(2);
  });

  it('respects a stricter threshold — separates vectors that would merge at 0.85', () => {
    // Two vectors with cosine ~0.9 (angle ~26 degrees)
    const a = normalise(f32(1, 0));
    const b = normalise(f32(0.9, Math.sqrt(1 - 0.9 ** 2)));
    const simAB = cosine(a, b);
    expect(simAB).toBeGreaterThan(0.85); // they would merge at 0.85

    const merged = cluster(['a', 'b'], [a, b], 0.85);
    expect(merged).toHaveLength(1); // merged at lenient threshold

    const separated = cluster(['a', 'b'], [a, b], 0.999);
    expect(separated).toHaveLength(2); // separated at strict threshold
  });

  it('produces multiple distinct clusters with clear separation', () => {
    // Three groups: A-axis, B-axis, C-axis (all orthogonal to each other)
    const a1 = normalise(f32(1.0, 0.0, 0.0, 0.01));
    const a2 = normalise(f32(1.0, 0.0, 0.0, 0.02));
    const b1 = normalise(f32(0.0, 1.0, 0.0, 0.01));
    const b2 = normalise(f32(0.0, 1.0, 0.0, 0.02));
    const c1 = normalise(f32(0.0, 0.0, 1.0, 0.01));

    const items = ['a1', 'a2', 'b1', 'b2', 'c1'];
    const vecs  = [a1,  a2,  b1,  b2,  c1];

    const result = cluster(items, vecs, 0.85);
    expect(result).toHaveLength(3);

    // Each group should be internally consistent
    const flat = result.map((g) => g.slice().sort());
    expect(flat).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['a1', 'a2']),
        expect.arrayContaining(['b1', 'b2']),
        ['c1']
      ])
    );
  });

  it('uses single-link chaining — bridges transitively similar vectors', () => {
    // a~b, b~c, but a and c alone might be below threshold
    // Using 2D vectors: a=(1,0), b at 10 degrees, c at 20 degrees
    const deg = (d: number) => (d * Math.PI) / 180;
    const a = f32(Math.cos(deg(0)),  Math.sin(deg(0)));
    const b = f32(Math.cos(deg(10)), Math.sin(deg(10)));
    const c = f32(Math.cos(deg(20)), Math.sin(deg(20)));

    // cosine between adjacent ~cos(10°) ≈ 0.985, between a and c ~cos(20°) ≈ 0.940
    // All are above 0.85 so all three should merge into one cluster
    const result = cluster(['a', 'b', 'c'], [a, b, c], 0.85);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
  });

  it('preserves item values (not just indices) in output', () => {
    const obj1 = { label: 'apple' };
    const obj2 = { label: 'banana' };
    const a = unit(2, 0);
    const b = unit(2, 1);
    const result = cluster([obj1, obj2], [a, b]);
    expect(result).toHaveLength(2);
    expect(result.flat()).toContain(obj1);
    expect(result.flat()).toContain(obj2);
  });
});
