import { describe, expect, it } from 'vitest';
import { compileSchedules } from '../device-config';
import { scheduleCwd, toRecurring } from '../session-schedule';

const HEAD = '@prefix kpred: <urn:kbase:predicate/> . @prefix ktype: <urn:kbase:type/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n';
const sched = (iri: string, label: string, extra = '') =>
  `${HEAD}<urn:reckons:schedule/${iri}> a ktype:Schedule ; rdfs:label "${label}" ; kpred:every "1h" ; kpred:command "true" ; ${extra} .\n`;

describe('compileSchedules: kpred:cwd (F274.1)', () => {
  it('compiles a named cwd, and leaves it undefined when absent', () => {
    const sources = [sched('site', 'Site', 'kpred:cwd "/srv/site" ;'), sched('here', 'Here')];
    const out = compileSchedules(sources, 'any');
    const withCwd = out.find((s) => s.iri.endsWith('/site'));
    const without = out.find((s) => s.iri.endsWith('/here'));
    expect(withCwd?.cwd).toBe('/srv/site');
    expect(without?.cwd).toBeUndefined();
  });
});

describe('scheduleCwd', () => {
  it('falls back when the own cwd is absent or empty', () => {
    expect(scheduleCwd(undefined, '/repo', '/home/u')).toBe('/repo');
    expect(scheduleCwd('', '/repo', '/home/u')).toBe('/repo');
  });
  it('expands a leading ~ to the home folder', () => {
    expect(scheduleCwd('~/sites/dis', '/repo', '/home/u')).toBe('/home/u/sites/dis');
  });
  it('keeps an absolute path as given', () => {
    expect(scheduleCwd('/abs/x', '/repo', '/home/u')).toBe('/abs/x');
  });
  it('resolves a relative path under the fallback', () => {
    expect(scheduleCwd('sub/dir', '/repo', '/home/u')).toBe('/repo/sub/dir');
  });
});

describe('toRecurring: per-schedule cwd', () => {
  it('uses the schedule\'s own cwd when it has one, the fallback when it does not', () => {
    const sources = [sched('site', 'Site', 'kpred:cwd "/srv/site" ;'), sched('here', 'Here')];
    const out = toRecurring(compileSchedules(sources, 'any'), '/repo');
    expect(out.find((j) => j.name === 'sched:site')?.cwd).toBe('/srv/site');
    expect(out.find((j) => j.name === 'sched:here')?.cwd).toBe('/repo');
  });
});
