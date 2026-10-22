import { describe, it, expect } from 'vitest';
import { occluderRadius, projectedRadius, OCCLUDER_CORE_FRACTION } from '../splat-occlusion';

describe('occluderRadius', () => {
  it('is a fraction of the splat radius, clamped to the splat itself', () => {
    expect(occluderRadius(10)).toBeCloseTo(10 * OCCLUDER_CORE_FRACTION);
    expect(occluderRadius(10, 2)).toBe(10);
    expect(occluderRadius(10, -1)).toBe(0);
  });
  it('is zero for a splat with no usable size', () => {
    expect(occluderRadius(0)).toBe(0);
    expect(occluderRadius(NaN)).toBe(0);
    expect(occluderRadius(-3)).toBe(0);
  });
});

describe('projectedRadius', () => {
  it('shrinks with distance and is zero when degenerate', () => {
    expect(projectedRadius(1, 5, 0.5, 400)).toBeCloseTo(160);
    expect(projectedRadius(1, 10, 0.5, 400)).toBeCloseTo(80);
    expect(projectedRadius(1, 0, 0.5, 400)).toBe(0);
  });
});
