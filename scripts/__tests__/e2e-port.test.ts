import { describe, it, expect } from 'vitest';
import { portFor, MAIN_PORT } from '../lib/e2e-port';

describe('e2e port per worktree', () => {
  it('lets E2E_PORT win, and ignores a value that is not a port', () => {
    expect(portFor('6123', { top: '/w/a', linked: true })).toBe(6123);
    expect(portFor('banana', { top: '/w/a', linked: true })).not.toBe(Number.NaN);
    expect(portFor('70000', null)).toBe(MAIN_PORT);
  });
  it('keeps 5174 for the main checkout and outside git', () => {
    expect(portFor(undefined, { top: '/home/x/repo', linked: false })).toBe(5174);
    expect(portFor(undefined, null)).toBe(5174);
  });
  it('gives a linked worktree a stable port of its own in 5400-5899', () => {
    const a = portFor(undefined, { top: '/home/x/repo-feature-a', linked: true });
    const b = portFor(undefined, { top: '/home/x/repo-feature-b', linked: true });
    expect(a).toBe(portFor(undefined, { top: '/home/x/repo-feature-a', linked: true }));
    for (const p of [a, b]) { expect(p).toBeGreaterThanOrEqual(5400); expect(p).toBeLessThan(5900); }
    expect(a).not.toBe(b);
  });
});
