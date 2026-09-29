import { describe, it, expect } from 'vitest';
import { spacesNeedingCount } from '../space-leaps';
import type { KbEntry } from '../kb-registry';

const e = (id: string, extra: Partial<KbEntry> = {}): KbEntry => ({ id, name: id, createdAt: 0, ...extra });

describe('spacesNeedingCount', () => {
  it('reads spaces never counted or written to since, and skips the current space and archives', () => {
    const picked = spacesNeedingCount([
      e('current'),
      e('never'),
      e('fresh', { leapTargets: {}, leapsCountedAt: 200, lastModified: 100 }),
      e('stale', { leapTargets: { x: 1 }, leapsCountedAt: 100, lastModified: 200 }),
      e('history', { archiveOf: 'current' }),
    ], 'current');
    expect(picked.map((s) => s.id)).toEqual(['never', 'stale']);
  });
});
