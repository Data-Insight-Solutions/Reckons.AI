import { describe, expect, it } from 'vitest';
import { scriptRunsNamingModel, scriptTierJobs } from '../script-tier-model-check.js';
import { modelMayRead, runToTurtle, TTL_PREFIXES, type RunRecord } from '../../agent/job-watch.js';

const JOBS = `@prefix kpred: <urn:kbase:predicate/> . @prefix job: <urn:reckons:job/> .
job:fast-check kpred:job-tier "script" . job:deep-read kpred:job-tier "agent" .`;
const now = new Date('2026-11-10T12:00:00Z');
const rec = (name: string, model: string | undefined, status: 'passed' | 'failed', ageMin = 10): RunRecord => {
  const t = new Date(now.getTime() - ageMin * 60000);
  return { name, startedAt: t, endedAt: t, exitCode: status === 'passed' ? 0 : 1, logPath: '/x', verdict: { status, headline: 'h', findings: [] }, modelUsed: model };
};
const runs = (...r: RunRecord[]) => `${TTL_PREFIXES}\n${r.map(runToTurtle).join('\n')}`;

describe('F286.6 watching costs less', () => {
  it('a model reads a log only for an agent-tier job or a failure', () => {
    expect(modelMayRead('script', 0)).toBe(false);
    expect(modelMayRead('script', 1)).toBe(true);
    expect(modelMayRead('agent', 0)).toBe(true);
    expect(modelMayRead(undefined, 0)).toBe(true);
  });
  it('a rule-summarized passed script run record names no model and has the headline fields', () => {
    const ttl = runToTurtle(rec('fast-check', undefined, 'passed'));
    expect(ttl).toContain('script rules only (no local model)');
    expect(ttl).toMatch(/kpred:exit-code 0/);
    expect(ttl).toContain('kpred:headline');
  });
  it('the check fails when a passed script-tier run of the last day names a model', () => {
    const jobs = scriptTierJobs(JOBS);
    expect(jobs.has('fast-check')).toBe(true);
    expect(scriptRunsNamingModel(runs(rec('fast-check', 'qwen-x', 'passed')), jobs, now)).toHaveLength(1);
  });
  it('passes for rule runs, failures, agent jobs and runs older than a day', () => {
    const jobs = scriptTierJobs(JOBS);
    const ttl = runs(rec('fast-check', undefined, 'passed'), rec('fast-check', 'qwen-x', 'failed'), rec('deep-read', 'qwen-x', 'passed'), rec('fast-check', 'qwen-x', 'passed', 3000));
    expect(scriptRunsNamingModel(ttl, jobs, now)).toHaveLength(0);
  });
});
