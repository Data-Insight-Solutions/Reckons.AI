/**
 * F89.4.3 — lanes. A fixture of 3 claims, 2 questions and 4 findings: the router sends the findings
 * to the report, and the review state (what kb_review_next lists) holds none of them.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countByLane, laneOf, routeLanes, type Lane } from '../review-lane.js';
import { buildSources, loadReviewState } from '../review-sources.js';
import { jobLanes } from '../local-jobs.js';

const S = 'urn:kbase:concept/';
const rows = [
  { subject: `${S}a`, predicate: 'urn:kbase:predicate/has-status', object: 'planned', agent: 'offline:describe-entities' },
  { subject: `${S}b`, predicate: 'urn:kbase:predicate/has-status', object: 'planned', agent: 'someone' },
  { subject: `${S}c`, predicate: 'urn:kbase:predicate/has-status', object: 'planned' },
  { subject: `${S}q1`, predicate: 'urn:kbase:predicate/has-owner', type: 'question', agent: 'someone' },
  { subject: `${S}q2`, predicate: 'urn:kbase:predicate/has-owner', agent: 'offline:term-usage' },
  { subject: 'src/a.ts', predicate: 'urn:sweep:pred/dead-weight', type: 'question', agent: 'offline:dead-weight' },
  { subject: 'src/b.ts', predicate: 'urn:sweep:pred/graph-lint', type: 'question', agent: 'offline:graph-lint' },
  { subject: `${S}d`, predicate: 'urn:kbase:predicate/x', type: 'drift-warning', agent: 'offline:tenet-align' },
  { subject: `${S}e`, predicate: 'urn:kbase:predicate/y', agent: 'offline:docs-review' },
];
const lanes = new Map<string, Lane>([['docs-review', 'finding'], ['term-usage', 'question'], ['dead-weight', 'question']]);

describe('lane router', () => {
  it('an explicit lane wins over every guess', () => {
    expect(laneOf({ subject: 's', predicate: 'p', lane: 'finding', object: 'o' })).toBe('finding');
    expect(laneOf({ subject: 's', predicate: 'p', lane: 'nonsense', object: 'o' })).toBe('claim');
  });

  it('routes 3 claims, 2 questions, 4 findings; findings go to the report', () => {
    expect(countByLane(rows, lanes)).toEqual({ claim: 3, question: 2, finding: 4 });
    const { review, findings } = routeLanes(rows, lanes);
    expect(review).toHaveLength(5);
    expect(findings.map((r) => r.subject)).toEqual(['src/a.ts', 'src/b.ts', `${S}d`, `${S}e`]);
  });

  it('a job that declares a lane is read by its agent name, with or without the offline: prefix', () => {
    expect(laneOf({ predicate: 'p', agent: 'offline:docs-review' }, lanes)).toBe('finding');
    expect(laneOf({ predicate: 'p', agent: 'docs-review' }, lanes)).toBe('finding');
    expect(laneOf({ predicate: 'p', agent: 'offline:unknown' }, lanes)).toBe('question');
  });
});

describe('the review state (kb_review_next) holds no finding', () => {
  it('lists 5 decisions and counts 4 findings from a fixture queue', () => {
    const ws = mkdtempSync(join(tmpdir(), 'lanes-'));
    mkdirSync(ws, { recursive: true });
    const queue = join(ws, 'knowledge.pending.jsonl');
    writeFileSync(queue, rows.map((r) => JSON.stringify({ kb: 'roadmap', ...r })).join('\n') + '\n');
    const state = loadReviewState(buildSources([], ws), new Map(), undefined, lanes);
    expect(state.findings).toBe(4);
    expect(state.decisions).toHaveLength(5);
    expect(state.decisions.flatMap((d) => d.claims.flatMap((c) => c.proposers ?? []))).not.toContain('offline:tenet-align');
  });
});

describe('jobLanes reads the declared lanes from the jobs graph', () => {
  it('the real jobs graph declares the dead-weight sweep as a question and the lint as a finding', () => {
    const m = jobLanes({ root: join(__dirname, '..', '..', '..'), stateHome: '/nonexistent' });
    expect(m.get('dead-weight')).toBe('question');
    expect(m.get('graph-lint')).toBe('finding');
    expect(m.has('csp-origin-audit')).toBe(false); // 'nothing' has no rows to route
  });
});
