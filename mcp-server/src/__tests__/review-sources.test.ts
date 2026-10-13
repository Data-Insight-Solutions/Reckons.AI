/**
 * One review queue (2026-10-08): the MCP review tools must see the rows the offline jobs write to
 * <workspace>/knowledge.pending.jsonl, and a verdict on such a row must be journalled in the
 * workspace file the app drains — not beside a per-graph queue the app never reads.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSources, decisionsFileFor, journalsFor, loadReviewState, resolveQueueWorkspace,
} from '../review-sources.js';
import { buildVerdict, filterDecisions, recordVerdicts } from '../review-session.js';
import { currentActor } from '../actor.js';

const actor = currentActor('cli', {} as NodeJS.ProcessEnv);

function jobRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    subject: 'urn:kbase:concept/job-backpressure',
    predicate: 'urn:kbase:predicate/review-finding',
    object: 'finding A',
    kb: 'roadmap',
    agent: 'offline:code-review',
    priority: 'medium',
    ...over,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'one-queue-'));
  const ws = join(root, 'reckons-workspace');
  const graph = join(root, 'mcp-workspace', 'kbs', 'roadmap');
  mkdirSync(ws, { recursive: true });
  mkdirSync(graph, { recursive: true });
  return { root, ws, graph, graphQueue: join(graph, 'pending.jsonl') };
}

describe('one review queue', () => {
  it('resolves the queue workspace: flag, then env, then ./reckons-workspace, else null', () => {
    const { root, ws } = fixture();
    expect(resolveQueueWorkspace({ cwd: root })).toBe(ws);
    expect(resolveQueueWorkspace({ cwd: root, env: '/elsewhere' })).toBe('/elsewhere');
    expect(resolveQueueWorkspace({ cwd: root, env: '/elsewhere', flag: 'rel' })).toBe(join(root, 'rel'));
    expect(resolveQueueWorkspace({ cwd: join(root, 'nope') })).toBeNull();
  });

  it('shows a workspace queue row as a decision alongside per-graph rows', () => {
    const f = fixture();
    writeFileSync(f.graphQueue, jobRow({ subject: 'urn:kbase:concept/graph-only', agent: 'kb_add_note' }) + '\n');
    writeFileSync(join(f.ws, 'knowledge.pending.jsonl'), jobRow() + '\n' + jobRow({ kb: 'docs', subject: 'urn:kbase:concept/d' }) + '\n');
    const sources = buildSources([f.graphQueue], f.ws);
    expect(sources.map((s) => s.kind)).toEqual(['graph', 'workspace']);
    const state = loadReviewState(sources, new Map());
    expect(state.totalRows).toBe(3);
    expect(state.decisions.map((d) => d.kb).sort()).toEqual(['docs', 'roadmap', 'roadmap']);
    expect(state.decisions.some((d) => d.claims.some((c) => c.proposers.includes('offline:code-review')))).toBe(true);
  });

  it('filters workspace rows by their own kb and by agent', () => {
    const f = fixture();
    writeFileSync(join(f.ws, 'knowledge.pending.jsonl'), jobRow() + '\n' + jobRow({ kb: 'docs', subject: 'urn:kbase:concept/d' }) + '\n');
    const state = loadReviewState(buildSources([], f.ws), new Map(), 'docs');
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0].kb).toBe('docs');
  });

  it('--agent matches question-only job findings that carry no claim', () => {
    const f = fixture();
    writeFileSync(join(f.ws, 'knowledge.pending.jsonl'),
      jobRow({ object: undefined, question: '[local review] a.ts:1 — bug', agent: 'offline:code-review (qwen3-coder:latest)' }) + '\n');
    const { decisions } = loadReviewState(buildSources([], f.ws), new Map());
    expect(decisions[0].claims).toHaveLength(0);
    expect(filterDecisions(decisions, { agent: 'code-review' })).toHaveLength(1);
    expect(filterDecisions(decisions, { agent: 'docs-review' })).toHaveLength(0);
  });

  it('counts a row mirrored in both places once', () => {
    const f = fixture();
    writeFileSync(f.graphQueue, jobRow() + '\n');
    writeFileSync(join(f.ws, 'knowledge.pending.jsonl'), jobRow() + '\n');
    expect(loadReviewState(buildSources([f.graphQueue], f.ws), new Map()).totalRows).toBe(1);
  });

  it('journals a workspace verdict in knowledge.decisions.jsonl, which the app drains', () => {
    const f = fixture();
    writeFileSync(f.graphQueue, jobRow({ subject: 'urn:kbase:concept/graph-only' }) + '\n');
    const queue = join(f.ws, 'knowledge.pending.jsonl');
    writeFileSync(queue, jobRow() + '\n');
    const sources = buildSources([f.graphQueue], f.ws);
    const d = loadReviewState(sources, new Map()).decisions.find((x) => x.subject.endsWith('job-backpressure'))!;
    const targets = journalsFor(d, sources);
    expect(targets).toEqual([join(f.ws, 'knowledge.decisions.jsonl')]);
    for (const t of targets) recordVerdicts(t, [buildVerdict({ decision: d, verdict: 'accept', claim: d.claims[0].id, actor })]);
    const journal = readFileSync(join(f.ws, 'knowledge.decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal).toHaveLength(1);
    expect(journal[0].decision).toBe(d.id);
    expect(journal[0].kb).toBe('roadmap');
    // Not written beside the per-graph queue, and the decision is now settled.
    expect(existsSync(join(f.graph, 'decisions.jsonl'))).toBe(false);
    expect(loadReviewState(buildSources([f.graphQueue], f.ws), new Map()).decisions.some((x) => x.id === d.id)).toBe(false);
  });

  it('per-graph behaviour is unchanged: journal beside its queue, nothing in the workspace', () => {
    const f = fixture();
    writeFileSync(f.graphQueue, jobRow() + '\n');
    const sources = buildSources([f.graphQueue], null);
    expect(sources).toHaveLength(1);
    const d = loadReviewState(sources, new Map()).decisions[0];
    expect(journalsFor(d, sources)).toEqual([join(f.graph, 'decisions.jsonl')]);
    expect(decisionsFileFor('/a/knowledge.pending.jsonl')).toBe('/a/knowledge.decisions.jsonl');
  });

  it('a missing workspace queue file adds no source', () => {
    const f = fixture();
    expect(buildSources([], f.ws)).toEqual([]);
  });
});
