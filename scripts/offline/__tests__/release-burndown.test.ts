import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { analyze, findRelease, lastChange, loadRanks, measureLine, render } from '../release-burndown.ts';

const PFX = `@prefix kb: <urn:kbase:concept/> . @prefix kpred: <urn:kbase:predicate/> . @prefix ktype: <urn:kbase:type/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix hnav: <urn:reckons:nav/> . `;
const parse = (t: string) => new Parser().parse(PFX + t);

const vocab = parse(`
ktype:s1 skos:inScheme ktype:FeatureLifecycle ; skos:notation "planned" ; hnav:order 1 .
ktype:s2 skos:inScheme ktype:FeatureLifecycle ; skos:notation "in-progress" ; hnav:order 2 .
ktype:s3 skos:inScheme ktype:FeatureLifecycle ; skos:notation "functional" ; hnav:order 4 .
ktype:other skos:inScheme ktype:ReviewStatusScheme ; skos:notation "confirmed" ; hnav:order 9 .
`);

const graph = parse(`
kb:rel rdfs:label "v9.9.9" ; kpred:version "9.9.9" ; kpred:starts "2026-10-01" ; kpred:cut "2026-10-08" ; kpred:ends "2026-10-11" ;
  kpred:headline kb:a ; kpred:has-part kb:a, kb:b, kb:c, kb:d .
kb:a rdfs:label "Alpha" ; kpred:feature-id "F1" ; kpred:has-status "planned" .
kb:b rdfs:label "Beta" ; kpred:has-status "functional" ; kpred:progress "2026-10-02, built." .
kb:c rdfs:label "Gamma" ; kpred:has-status "in-progress" ; kpred:progress "2026-10-04, started." ; kpred:measured "2026-10-05, measured." .
kb:d rdfs:label "Delta" .
`);

describe('release-burndown', () => {
  it('reads status ranks from the lifecycle scheme only', () => {
    expect(loadRanks(vocab)).toEqual({ planned: 1, 'in-progress': 2, functional: 4 });
  });
  it('finds the release by version', () => {
    expect(findRelease(graph, '9.9.9')).toBe('urn:kbase:concept/rel');
    expect(findRelease(graph, '1.0.0')).toBeNull();
  });
  it('takes the newest dated note', () => {
    expect(lastChange(graph, 'urn:kbase:concept/c')).toBe('2026-10-05');
    expect(lastChange(graph, 'urn:kbase:concept/d')).toBeNull();
  });
  it('counts statuses, calendar and headline parts', () => {
    const b = analyze(graph, vocab, '9.9.9', '2026-10-06')!;
    expect(b.counts).toEqual({ planned: 1, functional: 1, 'in-progress': 1, 'no status': 1 });
    expect(b.built).toBe(1);
    expect(b.elapsed).toBe(5);
    expect(b.remaining).toBe(5);
    expect(b.cutIn).toBe(2);
    expect(b.headlineNotStarted.map((p) => p.id)).toEqual(['F1']);
    expect(b.verdict).toBe('1 of 4 parts functional or better; 1 headline part not started');
  });
  it('flags stale parts below functional, not built ones', () => {
    const b = analyze(graph, vocab, '9.9.9', '2026-10-10', 4)!;
    expect(b.stale.map((p) => p.label).sort()).toEqual(['Alpha', 'Delta', 'Gamma']);
  });
  it('returns null for an unknown release and renders without throwing', () => {
    expect(analyze(graph, vocab, '0.0.1', '2026-10-06')).toBeNull();
    const b = analyze(graph, vocab, '9.9.9', '2026-10-06')!;
    expect(render(b)).toContain('Alpha');
    expect(measureLine(b, '2026-10-06')).toMatch(/^kpred:measured "2026-10-06, BURNDOWN/);
  });
});
