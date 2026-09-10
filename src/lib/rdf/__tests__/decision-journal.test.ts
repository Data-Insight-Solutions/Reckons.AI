/**
 * Applying a verdict reached outside the app (F199).
 *
 * THE TEST THAT MATTERS MOST IS THE SELF-SETTLEMENT ONE. F52 stops an agent landing a settled fact
 * directly; a journal that let an agent accept its own proposal would be the same wall climbed in
 * two steps — propose, then accept, with a person's account on the second step and nobody having
 * read either. Everything else here is bookkeeping by comparison.
 */
import { describe, it, expect } from 'vitest';
import {
  applyVerdicts, parseDecisionJsonl, parseDecisionLine, sameAgent, settlerChannel,
  type DecisionVerdict,
} from '../decision-journal';
import type { Statement } from '../types';

const S = 'urn:kbase:concept/graph-publishing';
const P = 'urn:kbase:predicate/has-status';

function actor(over: Partial<DecisionVerdict['actor']> = {}): DecisionVerdict['actor'] {
  return {
    user: 'matt', host: '12chi-core', route: 'cli', agent: false, interactive: true,
    attestation: 'Typed at an interactive terminal as matt@12chi-core.',
    ...over,
  };
}

function verdict(over: Partial<DecisionVerdict> = {}): DecisionVerdict {
  return {
    decision: 'd1', verdict: 'accept', claim: 'd1.aaaa', rows: ['r1'],
    subject: S, predicate: P, object: 'functional', supersedes: [], kb: 'roadmap',
    actor: actor(), at: '2026-09-10T10:00:00.000Z',
    ...over,
  };
}

function statement(over: Partial<Statement> = {}): Statement {
  return {
    id: 'st1', sourceId: 'mcp-pending-x', confidence: 0.7, status: 'pending',
    s: { kind: 'iri', value: S },
    p: { kind: 'iri', value: P },
    o: { kind: 'literal', value: 'functional' },
    g: { kind: 'iri', value: 'urn:mcp:pending:x' },
    createdAt: 1, updatedAt: 1,
    ...over,
  } as Statement;
}

describe('parsing the journal', () => {
  it('accepts a well-formed verdict', () => {
    expect(parseDecisionLine(JSON.stringify(verdict())).ok).toBe(true);
  });

  it('refuses a settlement with no settler — worse than an unsettled one', () => {
    const { actor: _drop, ...rest } = verdict();
    const parsed = parseDecisionLine(JSON.stringify(rest));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.code).toBe('missing-actor');
  });

  it('refuses an accept that names no object', () => {
    const parsed = parseDecisionLine(JSON.stringify({ ...verdict(), object: undefined }));
    expect(parsed.ok === false && parsed.code).toBe('accept-without-object');
  });

  it('refuses an unknown verdict word rather than treating it as a no-op', () => {
    const parsed = parseDecisionLine(JSON.stringify({ ...verdict(), verdict: 'approve' }));
    expect(parsed.ok === false && parsed.code).toBe('unknown-verdict');
  });

  it('keeps reading after a torn line and reports it', () => {
    const text = '{"decision":"tr\n' + JSON.stringify(verdict()) + '\n';
    const { verdicts, issues } = parseDecisionJsonl(text);
    expect(verdicts).toHaveLength(1);
    expect(issues[0].code).toBe('malformed-json');
  });
});

describe('F52 — an agent may not settle its own proposal', () => {
  const own = () => applyVerdicts(
    [verdict({ actor: actor({ agent: true, agentId: 'claude-code', route: 'mcp', interactive: undefined }) })],
    [statement({ proposedBy: 'claude-code' })],
  );

  it('refuses it, and changes nothing', () => {
    const out = own();
    expect(out.changes).toHaveLength(0);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].reason).toContain('cannot also settle it');
  });

  it('leaves the verdict in the journal rather than consuming it', () => {
    expect(own().applied).toHaveLength(0);
  });

  it('allows an agent to settle a DIFFERENT agent\'s proposal, downgraded rather than confirmed', () => {
    const out = applyVerdicts(
      [verdict({ actor: actor({ agent: true, agentId: 'claude-code', route: 'mcp' }) })],
      [statement({ proposedBy: 'offline:graph-lint' })],
    );
    expect(out.refused).toHaveLength(0);
    // The boundary still holds: an agent-routed accept becomes a proposal for review, not a fact.
    expect(out.changes[0].status).toBe('pending');
    expect(out.changes[0].reason).toContain('agent may not settle a fact directly');
  });

  it('lets a person at a terminal confirm it outright', () => {
    const out = applyVerdicts([verdict()], [statement({ proposedBy: 'offline:graph-lint' })]);
    expect(out.changes[0].status).toBe('confirmed');
    expect(out.changes[0].settledBy).toEqual({
      actor: 'matt@12chi-core', channel: 'cli:tty', at: expect.any(Number),
    });
  });

  it('matches agent labels on their leading identifier, not exactly', () => {
    expect(sameAgent('claude-code (opus)', 'claude-code')).toBe(true);
    expect(sameAgent('offline:code-review (qwen3-coder:latest)', 'claude-code')).toBe(false);
  });
});

describe('what a verdict does to statements', () => {
  it('confirms the accepted claim and supersedes only the objects it named', () => {
    const out = applyVerdicts(
      [verdict({ object: 'functional', supersedes: ['planned'] })],
      [
        statement({ id: 'a', o: { kind: 'literal', value: 'functional' } }),
        statement({ id: 'b', o: { kind: 'literal', value: 'planned' } }),
        statement({ id: 'c', o: { kind: 'literal', value: 'scaffolded' } }),
      ],
    );
    const byId = new Map(out.changes.map((c) => [c.id, c.status]));
    expect(byId.get('a')).toBe('confirmed');
    expect(byId.get('b')).toBe('superseded');
    // Untouched: a batch acceptance supersedes nothing, so an unnamed sibling must not move.
    expect(byId.has('c')).toBe(false);
  });

  it('accepts a whole batch without superseding anything', () => {
    const out = applyVerdicts(
      [verdict({ claim: 'all', object: undefined, objects: ['one', 'two'], supersedes: [] })],
      [
        statement({ id: 'a', o: { kind: 'literal', value: 'one' } }),
        statement({ id: 'b', o: { kind: 'literal', value: 'two' } }),
        statement({ id: 'c', o: { kind: 'literal', value: 'three' } }),
      ],
    );
    expect(out.changes.map((c) => c.status)).toEqual(['confirmed', 'confirmed']);
    expect(out.changes.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('rejects every matching statement on a reject', () => {
    const out = applyVerdicts([verdict({ verdict: 'reject' })], [statement()]);
    expect(out.changes[0].status).toBe('rejected');
  });

  it('changes nothing on defer or ask, and still records them as handled', () => {
    const out = applyVerdicts(
      [verdict({ verdict: 'defer', note: 'needs the meeting' }), verdict({ verdict: 'ask' })],
      [statement()],
    );
    expect(out.changes).toHaveLength(0);
    expect(out.applied).toEqual(['d1', 'd1']);
  });

  it('never touches a statement a person already settled', () => {
    const out = applyVerdicts([verdict()], [statement({ status: 'confirmed' })]);
    expect(out.changes).toHaveLength(0);
    expect(out.unmatched).toHaveLength(1);
  });

  it('keeps a verdict whose row has not been drained yet — early is not wrong', () => {
    const out = applyVerdicts([verdict()], []);
    expect(out.unmatched).toHaveLength(1);
    expect(out.applied).toHaveLength(0);
  });

  it('stamps every change with the decision that caused it', () => {
    const out = applyVerdicts([verdict({ decision: 'abc123' })], [statement()]);
    expect(out.changes[0].settledByDecision).toBe('abc123');
  });

  it('lets a later verdict override an earlier one on the same statement', () => {
    const out = applyVerdicts(
      [verdict(), verdict({ verdict: 'reject' })],
      [statement()],
    );
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].status).toBe('rejected');
  });
});

describe('the channel a settlement travelled by', () => {
  it('distinguishes a person at a terminal from a script from an agent', () => {
    expect(settlerChannel(actor())).toBe('cli:tty');
    expect(settlerChannel(actor({ interactive: false }))).toBe('cli:script');
    expect(settlerChannel(actor({ agent: true, agentId: 'claude-code' }))).toBe('cli:agent:claude-code');
    expect(settlerChannel(actor({ route: 'mcp', agent: false, interactive: undefined }))).toBe('mcp:client');
  });
});
