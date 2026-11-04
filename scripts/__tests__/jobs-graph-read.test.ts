import { describe, expect, it } from 'vitest';
import { parseJobs, readJobs } from '../lib/jobs-graph-read.js';

const PRE = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix hnav: <urn:reckons:nav/> .
@prefix job: <urn:reckons:job/> .
`;

describe('jobs graph reader (F216)', () => {
  it('parses the real file: every job has a name, a command and a tier, in order', () => {
    const jobs = readJobs();
    expect(jobs.length).toBeGreaterThan(50);
    for (const j of jobs) {
      expect(j.name).toBeTruthy();
      expect(j.cmd).toBeTruthy();
      expect(['script', 'agent']).toContain(j.tier);
    }
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    expect(jobs.some((j) => j.blocking)).toBe(true);
  });

  it('orders by hnav:order and reads the flags', () => {
    const jobs = parseJobs(`${PRE}
job:b a ktype:OfflineJob ; rdfs:label "b" ; kpred:job-tier "agent" ; kpred:command "echo b" ; kpred:job-enabled "false" ; kpred:job-queues "false" ; hnav:order 2 .
job:a a ktype:OfflineJob ; rdfs:label "a" ; kpred:job-tier "script" ; kpred:command "echo a" ; kpred:job-enabled "true" ; kpred:job-blocking "true" ; hnav:order 1 .`);
    expect(jobs.map((j) => j.name)).toEqual(['a', 'b']);
    expect(jobs[0]).toMatchObject({ enabled: true, blocking: true, tier: 'script' });
    expect(jobs[1]).toMatchObject({ enabled: false, queues: false, tier: 'agent' });
  });

  it('fails loudly on a job with no command, no tier or no label', () => {
    expect(() => parseJobs(`${PRE}job:x a ktype:OfflineJob ; rdfs:label "x" ; kpred:job-tier "script" .`)).toThrow(/no kpred:command/);
    expect(() => parseJobs(`${PRE}job:x a ktype:OfflineJob ; rdfs:label "x" ; kpred:command "echo" .`)).toThrow(/job-tier/);
    expect(() => parseJobs(`${PRE}job:x a ktype:OfflineJob ; kpred:job-tier "script" ; kpred:command "echo" .`)).toThrow(/rdfs:label/);
  });
});
