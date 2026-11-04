/**
 * F273 PHASE 0 done-test: a brief is built only from an entity that carries a job spec.
 * Synthetic entities; F273 itself is the one real entity checked at the bottom.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildJobBrief, INVARIANTS } from '../job-brief.js';

const PFX = `@prefix kb: <urn:kbase:concept/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;
const ent = (lines: Record<string, string[]>) =>
  PFX + 'kb:job rdfs:label "A job" ;\n    kpred:feature-id "F900" ;\n' +
  Object.entries(lines).flatMap(([p, vs]) => vs.map((v) => `    kpred:${p} ${JSON.stringify(v)} ;\n`)).join('') +
  '    kpred:priority "high" .\n';
const FULL = { 'done-test': ['exits 0 when fixed'], evidence: ['it broke on 2026-10-28'], extends: ['scripts/x.ts'], 'non-goal': ['no network'] };

describe('buildJobBrief', () => {
  it('refuses an entity with no done-test and names it', () => {
    const { 'done-test': _, ...rest } = FULL;
    const r = buildJobBrief(ent(rest), 'kb:job');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['kpred:done-test']);
  });
  it.each(['evidence', 'extends', 'non-goal'] as const)('refuses an entity with no %s', (p) => {
    const { [p]: _, ...rest } = FULL;
    const r = buildJobBrief(ent(rest), 'kb:job');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([`kpred:${p}`]);
  });
  it('names every missing predicate at once', () => {
    const r = buildJobBrief(ent({}), 'kb:job');
    expect(r.missing).toEqual(['kpred:done-test', 'kpred:evidence', 'kpred:extends', 'kpred:non-goal']);
  });
  it('refuses an entity that does not exist', () => {
    const r = buildJobBrief(ent(FULL), 'kb:nope');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
  it('builds a brief with the job spec and every invariant when all four are present', () => {
    const r = buildJobBrief(ent(FULL), 'kb:job');
    expect(r.ok).toBe(true);
    const b = r.brief!;
    for (const s of ['F900', 'A job', 'exits 0 when fixed', 'it broke on 2026-10-28', 'scripts/x.ts', 'no network']) expect(b).toContain(s);
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(5);
    for (const re of [/base `?dev/i, /npm ci/i, /npm install/i, /Co-Authored-By/, /STOP/i, /LOCAL-TIER LEDGER/]) expect(b).toMatch(re);
  });
  it('accepts a full IRI, a kb: curie, or a bare slug', () => {
    for (const id of ['urn:kbase:concept/job', 'kb:job', 'job']) expect(buildJobBrief(ent(FULL), id).ok).toBe(true);
  });
  it('treats an empty-string done-test as missing', () => {
    expect(buildJobBrief(ent({ ...FULL, 'done-test': [' '] }), 'kb:job').missing).toEqual(['kpred:done-test']);
  });
});

describe('F273 is the first entity a brief is built from', () => {
  it('builds from the real roadmap', () => {
    const r = buildJobBrief(readFileSync('static/reckons-roadmap.ttl', 'utf8'), 'kb:procedure-over-prose');
    expect(r.error).toBeUndefined();
    expect(r.missing).toEqual([]);
    expect(r.brief).toContain('F273');
    expect(r.brief).toContain('PHASE 0');
  });
});
