/**
 * The task queue (F87 phase 1).
 *
 * These tests guard the failure modes this project has ALREADY HIT, not hypothetical ones:
 *
 *   - a scheduler that fired, produced nothing, reported nothing, and still showed a future
 *     run time (it looked armed while being dead)  -> abandonedTasks()
 *   - an agent left to judge whether its own work was finished                -> done-when
 *   - a harness that hit a usage limit mid-task and stalled it forever        -> leases
 *
 * Getting these wrong is not a bug you see. It is a queue that quietly stops moving.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTasks,
  runnableTasks,
  orderForModelBatching,
  blockedReason,
  abandonedTasks,
  claimTriples,
  completeTriples,
  AGENT_TASK_TYPE,
  DEFAULT_LEASE_MS,
  type AgentTask,
} from '../agent-task';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
let n = 0;

function st(s: string, p: string, o: string): Statement {
  n += 1;
  return {
    id: `q${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'src',
    confidence: 1,
    status: 'confirmed',
    createdAt: n,
    updatedAt: n,
  } as Statement;
}

const T = 'urn:reckons:task/t1';
const NOW = 1_000_000;

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    iri: T,
    goal: 'do the thing',
    tier: 'script',
    harness: 'any',
    doneWhen: 'npm run align exits 0',
    blockedBy: [],
    state: 'open',
    ...over,
  };
}

const nothingResolved = { now: NOW, resolved: () => false };
const allResolved = { now: NOW, resolved: () => true };

describe('parseTasks', () => {
  it('reads a task out of the graph', () => {
    const stmts = [
      st(T, RDF_TYPE, AGENT_TASK_TYPE),
      st(T, `${KPRED}goal`, 'fix the filter'),
      st(T, `${KPRED}tier`, 'local-agent'),
      st(T, `${KPRED}done-when`, 'tests pass'),
      st(T, `${KPRED}blocked-by`, 'urn:kbase:concept/q1'),
    ];
    // The o for rdf:type must be an IRI for the type match; force it.
    (stmts[0].o as any) = { kind: 'iri', value: AGENT_TASK_TYPE };

    const [t] = parseTasks(stmts);
    expect(t.goal).toBe('fix the filter');
    expect(t.tier).toBe('local-agent');
    expect(t.doneWhen).toBe('tests pass');
    expect(t.blockedBy).toEqual(['urn:kbase:concept/q1']);
    expect(t.harness).toBe('any'); // default: any competent harness
  });
});

describe('done-when is not optional', () => {
  it('REFUSES to assign a task with no acceptance criterion', () => {
    const wish = task({ doneWhen: undefined });
    expect(blockedReason(wish, allResolved)).toMatch(/done-when/);
    expect(runnableTasks([wish], allResolved)).toHaveLength(0);
  });

  it('refuses a task with no goal', () => {
    expect(blockedReason(task({ goal: '  ' }), allResolved)).toMatch(/no goal/);
  });
});

describe('blocking', () => {
  it('a task with unresolved blockers is not runnable', () => {
    const t = task({ blockedBy: ['urn:kbase:concept/q1'] });
    expect(blockedReason(t, nothingResolved)).toMatch(/blocked by 1/);
    expect(runnableTasks([t], nothingResolved)).toHaveLength(0);
  });

  it('…and becomes runnable the moment the question is answered', () => {
    const t = task({ blockedBy: ['urn:kbase:concept/q1'] });
    expect(runnableTasks([t], allResolved)).toHaveLength(1);
  });

  it('a task is not runnable before it is due', () => {
    expect(blockedReason(task({ dueAt: NOW + 1 }), allResolved)).toBe('not due yet');
    expect(blockedReason(task({ dueAt: NOW - 1 }), allResolved)).toBeNull();
  });
});

describe('leases — a dead runner must give the task back', () => {
  it('a LIVE claim blocks other runners', () => {
    const t = task({ claimedBy: 'opus-1', claimExpires: NOW + 1000, state: 'claimed' });
    expect(blockedReason(t, allResolved)).toMatch(/claimed by opus-1/);
  });

  it('an EXPIRED claim does NOT block — the runner died, the work must not die with it', () => {
    const t = task({ claimedBy: 'opus-1', claimExpires: NOW - 1, state: 'claimed' });
    expect(blockedReason(t, allResolved)).toBeNull();
    expect(runnableTasks([t], allResolved)).toHaveLength(1);
  });

  it('surfaces abandoned work — the "looked armed while being dead" failure', () => {
    const dead = task({ claimedBy: 'cron', claimExpires: NOW - 1, state: 'claimed' });
    const finished = task({ claimedBy: 'cron', claimExpires: NOW - 1, state: 'claimed', outcome: 'shipped' });
    const alive = task({ claimedBy: 'cron', claimExpires: NOW + 1, state: 'claimed' });

    const abandoned = abandonedTasks([dead, finished, alive], NOW);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toBe(dead);
  });

  it('a claim is a lease with an expiry, not a lock', () => {
    const triples = claimTriples(T, 'opus-1', NOW);
    const expires = triples.find((t) => t.predicate.endsWith('claim-expires'))!;
    expect(Number(expires.object)).toBe(NOW + DEFAULT_LEASE_MS);
  });
});

describe('routing', () => {
  it('cheapest competent tier first — script before local-agent before frontier', () => {
    const order = runnableTasks(
      [task({ iri: 'a', tier: 'frontier' }), task({ iri: 'b', tier: 'script' }), task({ iri: 'c', tier: 'local-agent' })],
      allResolved,
    ).map((t) => t.tier);
    expect(order).toEqual(['script', 'local-agent', 'frontier']);
  });
});

describe('model batching — Ollama cannot switch models cheaply', () => {
  it('groups same-model local-agent tasks CONSECUTIVELY (no interleave = no reload thrash)', () => {
    const order = orderForModelBatching([
      task({ iri: 'a', tier: 'local-agent', model: 'qwen3-coder' }),
      task({ iri: 'b', tier: 'local-agent', model: 'qwen2.5vl' }),
      task({ iri: 'c', tier: 'local-agent', model: 'qwen3-coder' }),
      task({ iri: 'd', tier: 'local-agent', model: 'qwen2.5vl' }),
    ]).map((t) => t.model);
    // each model appears in one unbroken run, not interleaved
    expect(order).toEqual(['qwen2.5vl', 'qwen2.5vl', 'qwen3-coder', 'qwen3-coder']);
  });

  it('script tier still runs first (free, no model), frontier last', () => {
    const order = orderForModelBatching([
      task({ iri: 'f', tier: 'frontier' }),
      task({ iri: 'la', tier: 'local-agent', model: 'qwen3-coder' }),
      task({ iri: 's', tier: 'script' }),
    ]).map((t) => t.tier);
    expect(order).toEqual(['script', 'local-agent', 'frontier']);
  });

  it('is STABLE within a model group — existing priority is preserved', () => {
    const order = orderForModelBatching([
      task({ iri: 'first', tier: 'local-agent', model: 'm' }),
      task({ iri: 'second', tier: 'local-agent', model: 'm' }),
      task({ iri: 'third', tier: 'local-agent', model: 'm' }),
    ]).map((t) => t.iri);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('runnableTasks applies the batching after filtering blocked tasks', () => {
    const order = runnableTasks(
      [
        task({ iri: 'a', tier: 'local-agent', model: 'zebra' }),
        task({ iri: 'b', tier: 'local-agent', model: 'alpha' }),
        task({ iri: 'c', tier: 'local-agent', model: 'zebra' }),
      ],
      allResolved,
    ).map((t) => t.model);
    expect(order).toEqual(['alpha', 'zebra', 'zebra']);
  });
});

describe('outcomes — silence must never look like success', () => {
  it('a task cannot be closed with an empty outcome', () => {
    expect(() => completeTriples(T, '   ', true)).toThrow(/outcome/i);
  });

  it('"I did nothing, and here is why" IS a valid outcome — indeed the important one', () => {
    const triples = completeTriples(T, 'Did nothing: the model would not load.', false);
    expect(triples.find((t) => t.predicate.endsWith('task-state'))?.object).toBe('failed');
    expect(triples.find((t) => t.predicate.endsWith('outcome'))?.object).toMatch(/Did nothing/);
  });
});
