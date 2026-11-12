import { describe, expect, it } from 'vitest';
import { parseVec3, parseViews, quaternionToY, rotateByQuat, type Vec3 } from '../splat-shots-lib';

const close = (a: Vec3, b: Vec3) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 6));

describe('splat-shots orientation', () => {
  it('turns any up direction to +y', () => {
    for (const up of [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0.3, -0.5, 0.8], [-2, 4, 1]] as Vec3[]) {
      const len = Math.hypot(...up);
      close(rotateByQuat(quaternionToY(up), up), [0, len, 0]);
    }
  });
  it('handles an up that points straight down by a half turn, and refuses a zero vector', () => {
    close(rotateByQuat(quaternionToY([0, -3, 0]), [0, -3, 0]), [0, 3, 0]);
    expect(() => quaternionToY([0, 0, 0])).toThrow(/no length/);
  });
  it('leaves an already-upright scene alone', () => { expect(quaternionToY([0, 5, 0])).toEqual([0, 0, 0, 1]); });
  it('parses vectors and views, refusing malformed ones', () => {
    expect(parseVec3('1, 2,3', '--up')).toEqual([1, 2, 3]);
    expect(() => parseVec3('1,2', '--up')).toThrow(/three numbers/);
    expect(parseViews('30:20:3,200:10:2:0.1')).toEqual([['az30el20', 30, 20, 3, 0], ['az200el10', 200, 10, 2, 0.1]]);
    expect(() => parseViews('30:20')).toThrow(/bad view/);
  });
});
