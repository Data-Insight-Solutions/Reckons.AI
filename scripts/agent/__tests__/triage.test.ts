/**
 * The triage classifier (F80) — the single arbiter of what a pending item IS.
 *
 * The queue grew to 83 "questions", zero of which were a decision (2026-07-16), because three
 * agents mis-filed observations and findings as questions and nothing sorted them back out. This
 * is the sorter both the orchestrator and the desk depend on; if it drifts, the desk fills with
 * noise again. So the three failure modes get pinned: a re-derivable stat treated as a decision,
 * a finding treated as a decision, and a real decision dropped from the desk.
 */
import { describe, it, expect } from 'vitest';
import { signature, classify, isDeskQuestion, ageDays, isBlocking } from '../triage';

const q = (o: Record<string, unknown>) => ({ subject: 'urn:s', predicate: 'urn:p', ...o });

describe('signature', () => {
  it('reads the [agent/check] tag when present', () => {
    expect(signature(q({ question: '[graph-lint/predicate-economy] kpred:related — 219 edges' }))).toBe('graph-lint/predicate-economy');
    expect(signature(q({ question: '[local review] mcp-server/src/kb-reader.ts: bug' }))).toBe('local review');
  });
  it('falls back to agent/type when there is no tag', () => {
    expect(signature(q({ agent: 'offline:history-lessons', type: 'observation' }))).toBe('history-lessons/observation');
  });
});

describe('classify', () => {
  it('marks graph-lint stats re-derivable — never a queue item', () => {
    expect(classify(q({ question: '[graph-lint/predicate-economy] noise' })).kind).toBe('rederivable');
  });
  it('marks missing descriptions remediable — a job clears the cluster', () => {
    const r = classify(q({ question: '[graph-lint/incomplete] no description' }));
    expect(r.kind).toBe('remediable');
    expect(r.command).toContain('describe-entities');
  });
  it('marks a code-review finding judgment (a proposal to verify), and copyleft judgment', () => {
    expect(classify(q({ question: '[local review] some finding' })).kind).toBe('judgment');
    expect(classify(q({ question: '[competitor-scan/copyleft] AGPL' })).kind).toBe('judgment');
  });
  it('fails toward the human: an unknown signature is judgment', () => {
    expect(classify(q({ agent: 'mystery', type: 'question' })).kind).toBe('judgment');
  });
});

describe('isDeskQuestion', () => {
  it('is true only for an unanswered judgment item of type question', () => {
    expect(isDeskQuestion(q({ type: 'question', agent: 'claude-code' }))).toBe(true);
  });
  it('is false for observations and drift-warnings, however wordy', () => {
    expect(isDeskQuestion(q({ type: 'observation', question: 'a long explanation but not a question' }))).toBe(false);
    expect(isDeskQuestion(q({ type: 'drift-warning', question: 'fix without test' }))).toBe(false);
  });
  it('is false for re-derivable stats even when typed question', () => {
    expect(isDeskQuestion(q({ type: 'question', question: '[graph-lint/predicate-economy] stat' }))).toBe(false);
  });
  it('is false once the item has an object (it is an assertion, not a question)', () => {
    expect(isDeskQuestion(q({ type: 'question', object: 'answered' }))).toBe(false);
  });
});

describe('carried-over and blocking dimensions', () => {
  it('ageDays counts whole days since addedAt', () => {
    const now = Date.parse('2026-07-16T00:00:00Z');
    expect(ageDays(q({ addedAt: '2026-07-12T00:00:00Z' }), now)).toBe(4);
    expect(ageDays(q({}), now)).toBe(0);
  });
  it('isBlocking is true only when the item names what it blocks', () => {
    expect(isBlocking(q({ blocks: 'urn:kbase:concept/auto-merge' }))).toBe(true);
    expect(isBlocking(q({}))).toBe(false);
  });
});
