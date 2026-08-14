import { describe, it, expect } from 'vitest';
import { toTurtleFull } from '../serialize';
import { importTurtleFull } from '../import-ttl';
import type { Statement, Source } from '../types';

/**
 * Attribution has to survive the round trip, or proposal yield can only ever be computed
 * inside the browser — while the job that would compute it is script tier, reading the
 * exported files.
 */
function stmt(p: Partial<Statement> & { id: string }): Statement {
  return {
    s: { kind: 'iri', value: 'urn:kbase:concept/thing' },
    p: { kind: 'iri', value: 'urn:kbase:predicate/note' },
    o: { kind: 'literal', value: 'a value' },
    g: { kind: 'iri', value: 'urn:kbase:source/src1' },
    sourceId: 'src1',
    confidence: 0.9,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...p,
  } as Statement;
}

const SOURCES: Source[] = [
  { id: 'src1', title: 'MCP queued notes', uri: 'urn:mcp:pending:src1', kind: 'analysis', trustLevel: 'review', ingestedAt: 1 },
];

describe('proposal attribution survives export and re-import', () => {
  it('carries proposedBy through toTurtleFull -> importTurtleFull', async () => {
    const ttl = toTurtleFull([stmt({ id: 'a1', proposedBy: 'offline:code-review (qwen3-coder:latest)' })], SOURCES);
    expect(ttl).toContain('meta:proposed-by');
    const { statements } = await importTurtleFull(ttl);
    expect(statements[0].proposedBy).toBe('offline:code-review (qwen3-coder:latest)');
  });

  it('keeps askedBy and proposedBy as separate facts', async () => {
    // askedBy routes an ANSWER back; proposedBy answers "was running that agent worth it".
    const ttl = toTurtleFull(
      [stmt({ id: 'a2', proposedBy: 'agent-x', askedBy: 'agent-x', needsObject: true })],
      SOURCES,
    );
    const { statements } = await importTurtleFull(ttl);
    expect(statements[0].proposedBy).toBe('agent-x');
    expect(statements[0].askedBy).toBe('agent-x');
  });

  it('preserves the STATUS alongside attribution — both halves of yield', async () => {
    const ttl = toTurtleFull(
      [
        stmt({ id: 'ok', status: 'confirmed', proposedBy: 'agent-a' }),
        stmt({ id: 'no', status: 'rejected', proposedBy: 'agent-a', o: { kind: 'literal', value: 'other' } }),
      ],
      SOURCES,
    );
    const { statements } = await importTurtleFull(ttl);
    const byId = Object.fromEntries(statements.map((s) => [s.o.value, s]));
    expect(byId['a value'].status).toBe('confirmed');
    expect(byId['other'].status).toBe('rejected');
    expect(statements.every((s) => s.proposedBy === 'agent-a')).toBe(true);
  });

  it('omits the annotation entirely when there is no agent, rather than writing an empty one', () => {
    const ttl = toTurtleFull([stmt({ id: 'a3' })], SOURCES);
    expect(ttl).not.toContain('meta:proposed-by');
  });

  it('survives an agent name containing quotes and unicode', async () => {
    const name = 'offline:review "v2" — qwen3';
    const ttl = toTurtleFull([stmt({ id: 'a4', proposedBy: name })], SOURCES);
    const { statements } = await importTurtleFull(ttl);
    expect(statements[0].proposedBy).toBe(name);
  });
});
