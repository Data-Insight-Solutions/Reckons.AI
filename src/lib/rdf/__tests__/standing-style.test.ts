import { describe, it, expect } from 'vitest';
import { standingStyle, nodeStyle, standingAlpha, DIM_ALPHA } from '../standing-style';

describe('standing style (F223.10)', () => {
  it('maps each standing to distinct line style or shape, not colour alone', () => {
    expect(standingStyle('held').dashed).toBe(false);
    expect(standingStyle('pending')).toEqual(standingStyle('held'));
    expect(standingStyle('proposed').dashed).toBe(true);
    expect(standingStyle('question')).toMatchObject({ dashed: true, hollow: true, mark: '?' });
    expect(nodeStyle('proposed').hollow).toBe(true);
    // proposed and question differ in shape as well as colour
    expect(nodeStyle('proposed').mark).not.toBe(nodeStyle('question').mark);
    expect(standingStyle('proposed').hollow).toBe(false);
  });
  it('an undimmed question is at least twice as strong as a dimmed held fact', () => {
    expect(standingAlpha('question', false)).toBeGreaterThanOrEqual(2 * standingAlpha('held', true));
    expect(standingAlpha('held', true)).toBe(DIM_ALPHA);
  });
  it('dimming multiplies on top of a question look', () => {
    expect(standingAlpha('question', true)).toBeCloseTo(0.5 * DIM_ALPHA);
  });
});
