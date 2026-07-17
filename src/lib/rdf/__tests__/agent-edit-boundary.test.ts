/**
 * F52 the agent-edit boundary — the wall.
 * The human holds the fact-edit right; an agent may only PROPOSE. The failure to prevent is a
 * silently-settled agent write, so the coercion is one-directional: only ever downgrade to a
 * proposal, never upgrade to a settled fact.
 */
import { describe, it, expect } from 'vitest';
import {
  gateFactWrite,
  agentTargetPolicy,
  isSettled,
  SETTLED_STATUSES,
} from '../agent-edit-boundary';
import type { ReviewStatus } from '../types';

describe('gateFactWrite — agents propose, humans hold the edit right', () => {
  it('an agent cannot settle a fact directly — confirmed/refined are downgraded to pending', () => {
    for (const s of ['confirmed', 'refined'] as ReviewStatus[]) {
      const d = gateFactWrite('agent', s);
      expect(d.status).toBe('pending');
      expect(d.coerced).toBe(true);
      expect(d.reason).toMatch(/proposal|review/);
    }
  });

  it("an agent's proposal statuses pass through unchanged", () => {
    for (const s of ['pending', 'pending-removal'] as ReviewStatus[]) {
      const d = gateFactWrite('agent', s);
      expect(d.status).toBe(s);
      expect(d.coerced).toBe(false);
    }
  });

  it('a human write is never coerced — any status passes', () => {
    for (const s of ['confirmed', 'refined', 'pending', 'rejected'] as ReviewStatus[]) {
      const d = gateFactWrite('human', s);
      expect(d.status).toBe(s);
      expect(d.coerced).toBe(false);
      expect(d.reason).toMatch(/human/);
    }
  });

  it('the coercion is one-directional: an agent write never becomes MORE settled than requested', () => {
    for (const s of ['pending', 'pending-removal', 'confirmed', 'refined', 'rejected', 'superseded'] as ReviewStatus[]) {
      const out = gateFactWrite('agent', s).status;
      expect(isSettled(out)).toBe(false); // an agent write is never left settled
    }
  });
});

describe('isSettled / SETTLED_STATUSES', () => {
  it('only confirmed and refined are settled', () => {
    expect([...SETTLED_STATUSES].sort()).toEqual(['confirmed', 'refined']);
    expect(isSettled('confirmed')).toBe(true);
    expect(isSettled('pending')).toBe(false);
    expect(isSettled('rejected')).toBe(false); // terminal, but not a fresh assertion
  });
});

describe('agentTargetPolicy — only facts must be proposed', () => {
  it('facts are proposed; plan/code/roadmap are direct (git+PR is their review)', () => {
    expect(agentTargetPolicy('fact')).toBe('propose');
    expect(agentTargetPolicy('plan')).toBe('direct');
    expect(agentTargetPolicy('code')).toBe('direct');
    expect(agentTargetPolicy('roadmap-ttl')).toBe('direct');
  });
});
