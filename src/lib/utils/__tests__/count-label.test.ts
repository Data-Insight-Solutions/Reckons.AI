import { describe, it, expect } from 'vitest';
import { countLabel } from '../count-label';

describe('countLabel', () => {
  it('uses the singular only for exactly one', () => {
    expect(countLabel(1, 'fact')).toBe('1 fact');
    expect(countLabel(0, 'fact')).toBe('0 facts');
    expect(countLabel(2, 'fact')).toBe('2 facts');
  });
  it('takes an irregular plural', () => {
    expect(countLabel(1, 'entity', 'entities')).toBe('1 entity');
    expect(countLabel(5, 'entity', 'entities')).toBe('5 entities');
  });
  it('groups thousands', () => {
    expect(countLabel(1234, 'fact')).toBe('1,234 facts');
  });
});

describe('the summary line', () => {
  it('pluralizes its three counts independently (it once read "1 sources")', () => {
    const line = (e: number, f: number, s: number) =>
      [countLabel(e, 'entity', 'entities'), countLabel(f, 'fact'), countLabel(s, 'note')].join(' · ');
    expect(line(1, 1, 1)).toBe('1 entity · 1 fact · 1 note');
    expect(line(0, 0, 0)).toBe('0 entities · 0 facts · 0 notes');
    expect(line(12, 1, 7)).toBe('12 entities · 1 fact · 7 notes');
  });
});
