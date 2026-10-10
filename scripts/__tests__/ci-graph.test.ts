import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, expandMatrix, OUT, readInputs, readRuleset, readWorkflow, readYamlSubset, scriptsIn, stripComment } from '../ci-graph';

const WF = join(process.cwd(), '.github', 'workflows');

describe('readYamlSubset', () => {
  it('reads mappings, sequences, `- key:` items, flow lists and block scalars, keeping # inside them', () => {
    const y = readYamlSubset([
      'name: CI # trailing comment',
      'on:',
      '  push:',
      "    branches: [main, 'dev']",
      'jobs:',
      '  check:',
      '    name: "Type check + Unit tests"',
      '    needs: [a, b]',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '        with:',
      '          fetch-depth: 0',
      '      - run: |',
      '          npx tsx scripts/a.ts # not a comment inside a block scalar',
      '          echo "#x"',
    ].join('\n')) as any;
    expect(y.name).toBe('CI');
    expect(y.on.push.branches).toEqual(['main', 'dev']);
    expect(y.jobs.check.name).toBe('Type check + Unit tests');
    expect(y.jobs.check.needs).toEqual(['a', 'b']);
    expect(y.jobs.check.steps[0]).toEqual({ uses: 'actions/checkout@v7', with: { 'fetch-depth': '0' } });
    expect(y.jobs.check.steps[1].run).toBe('npx tsx scripts/a.ts # not a comment inside a block scalar\necho "#x"');
  });
  it('refuses what it does not support, by line, instead of half-reading it', () => {
    expect(() => readYamlSubset('a: &x 1\nb: *x')).toThrow(/line 1: anchors/);
    expect(() => readYamlSubset('a: {b: 1}')).toThrow(/flow mappings/);
    expect(() => readYamlSubset('a: 1\n---\nb: 2')).toThrow(/multi-document/);
    expect(() => readYamlSubset('a: one\n  two')).toThrow(/multi-line plain scalars/);
    expect(() => readYamlSubset('<<: x')).toThrow(/merge keys/);
  });
  it('keeps a # that is not after whitespace, and quoted ones', () => {
    expect(stripComment('url: a#b')).toBe('url: a#b');
    expect(stripComment('x: "a # b" # c')).toBe('x: "a # b"');
  });
});

describe('the real workflows', () => {
  for (const f of readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    it(`${f}: every job under jobs: is read (checked against a plain line count)`, () => {
      const src = readFileSync(join(WF, f), 'utf8');
      const jobsAt = src.split('\n').findIndex((l) => l === 'jobs:');
      const expected = src.split('\n').slice(jobsAt + 1).filter((l) => /^ {2}[\w-]+:\s*(#.*)?$/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
      const ids = [...new Set(readWorkflow(f, src).checks.map((c) => c.jobId))];
      expect(ids).toEqual(expected);
    });
  }
});

describe('checks', () => {
  it('names matrix checks the way GitHub does', () => {
    expect(expandMatrix('Dependencies (${{ matrix.project }})', { project: ['.', 'mcp-server', 'cli'] })).toEqual(['Dependencies (.)', 'Dependencies (mcp-server)', 'Dependencies (cli)']);
    expect(expandMatrix('Plain', {})).toEqual(['Plain']);
  });
  it('finds repository scripts and npm scripts in a run block', () => {
    expect(scriptsIn('npx tsx scripts/offline/run-all.ts --tier=script --ci && npm run build:verify')).toEqual({ scripts: ['scripts/offline/run-all.ts'], npm: ['build:verify'] });
  });
  it('reports a required check that no workflow produces', () => {
    const rs = readRuleset('r.json', JSON.stringify({ name: 'Main', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'] } }, rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Ghost check' }] } }] }));
    const { drift } = build({ workflows: [], rulesets: [rs], blockingJobs: [], guardsByPath: new Map(), npmScripts: {} });
    expect(drift.join()).toContain('"Ghost check", which no workflow produces');
  });
});

describe('static/reckons-ci.ttl', () => {
  it('is what the generator writes, every required check exists, and the counts add up', () => {
    const inp = readInputs();
    const { ttl, drift } = build(inp);
    expect(drift).toEqual([]);
    expect(readFileSync(OUT, 'utf8')).toBe(ttl);
    const required = inp.rulesets.flatMap((r) => r.required);
    expect((ttl.match(/kpred:can-block-merge "true"/g) ?? []).length).toBe(required.length);
  });
});
