import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { jobLink, hyperlink, jobIri, type HistRun } from '../job-state.js';
import { jobToTurtle, upsertJobBlock, TTL_PREFIXES } from '../job-watch.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
const fail = (m: number): HistRun => ({ name: 'j', status: 'failed', exitCode: 1, signature: 'exit=1|error: x', startedAt: at(m), logPath: `/l${m}`, headline: 'h' });
const pass = (m: number): HistRun => ({ name: 'j', status: 'passed', exitCode: 0, startedAt: at(m), logPath: `/l${m}` });
const runs = [30, 20, 10].map(fail);

describe('job link builder', () => {
  it('builds the app deep link: ?kb=<graph>&sel=<job IRI>, encoded', () => {
    expect(jobIri('CI wait #1')).toBe('urn:reckons:job/ci-wait-1');
    expect(jobLink('CI wait #1', 'http://localhost:5173/')).toBe('http://localhost:5173/?kb=job-runs&sel=urn%3Areckons%3Ajob%2Fci-wait-1');
  });
  it('uses OSC 8 on a TTY and a plain URL otherwise', () => {
    expect(hyperlink('j', 'http://x/', true)).toBe('\u001b]8;;http://x/\u001b\\j\u001b]8;;\u001b\\');
    expect(hyperlink('j', 'http://x/', false)).toBe('j (http://x/)');
  });
});

describe('job entity', () => {
  it('carries latest/previous run, circuit state, signature and log path, and parses', () => {
    const q = new Parser().parse(`${TTL_PREFIXES}\n${jobToTurtle('j', runs, 3)}`);
    const vals = Object.fromEntries(q.map((x) => [x.predicate.value.split('/').pop(), x.object.value]));
    expect(vals['circuit-state']).toBe('open');
    expect(vals['failure-signature']).toBe('exit=1|error: x');
    expect(vals['log-path']).toBe('/l10');
    expect(vals['latest-run']).toMatch(/jobrun\/j-/);
    expect(vals['latest-run']).not.toBe(vals['previous-run']);
  });
  it('is closed after a pass', () => {
    expect(jobToTurtle('j', [...runs, pass(1)], 3)).toContain('kpred:circuit-state "closed"');
  });
  it('upsert replaces the same job block, keeps others, and adds the job: prefix to old files', () => {
    const a = upsertJobBlock('@prefix jobrun: <urn:reckons:jobrun/> .\n\n# x\n', 'j', jobToTurtle('j', runs, 3));
    expect(a).toContain('@prefix job:');
    const b = upsertJobBlock(a, 'j', jobToTurtle('j', [...runs, pass(1)], 3));
    expect(b.match(/# job-begin j/g)).toHaveLength(1);
    expect(b).toContain('"closed"');
    expect(b).not.toContain('"open"');
    expect(upsertJobBlock(b, 'k', jobToTurtle('k', [], 3)).match(/# job-begin/g)).toHaveLength(2);
  });
});
