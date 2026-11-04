import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { buildReview, GAP_LABEL, VERDICT_UNSET } from '../offline/release-review-space';
import { loadWorkflows } from '../lib/test-workflow';

const PRE = `
@prefix kb: <urn:kbase:concept/> .
@prefix test: <urn:reckons:test/> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

// Synthetic roadmap: a release with a headline, two ordinary parts, one phase nested under a part.
const ROADMAP = PRE + `
kb:rel a ktype:Release ; rdfs:label "v9.9.9" ; kpred:version "9.9.9" ; kpred:has-status "planned" ;
    kpred:has-part kb:plain, kb:untested, kb:parent ;
    kpred:headline kb:parent .
kb:plain a ktype:Feature ; rdfs:label "Plain feature" ; kpred:feature-id "F1" ; kpred:has-status "functional" ;
    kpred:tested-by "tests/e2e/workflow-alpha.test.ts" .
kb:untested a ktype:Feature ; rdfs:label "Untested feature" ; kpred:feature-id "F2" ; kpred:has-status "planned" ;
    kpred:tested-by "src/unit.test.ts" .
kb:parent a ktype:Feature ; rdfs:label "Parent feature" ; kpred:feature-id "F3" ; kpred:has-status "scaffolded" .
kb:child a ktype:Phase ; rdfs:label "Child phase" ; kpred:part-of kb:parent ;
    kpred:tested-by "tests/e2e/workflow-beta.test.ts" .
kb:other a ktype:Release ; kpred:version "8.8.8" .
`;

const TESTING = PRE + `
test:A a ktype:TestWorkflow ; rdfs:label "Alpha path" ; kpred:workflow-id "alpha" ; kpred:test-file "tests/e2e/workflow-alpha.test.ts" ;
    skos:definition "Alpha does a thing.\\n\\nSecond paragraph." .
test:B a ktype:TestWorkflow ; rdfs:label "Beta path" ; kpred:workflow-id "beta" ; kpred:test-file "tests/e2e/workflow-beta.test.ts" .
test:A1 a ktype:TestStep ; rdfs:label "Open it" ; kpred:part-of test:A ; kpred:step-order "1"^^xsd:integer ; kpred:step-id "open" ;
    kpred:page "/a" ; kpred:page-name "the A tab" ; kpred:box-target "the box" ; skos:definition "Open the A tab." ;
    kpred:assertion "A tab is open" ; kpred:screenshot "/workflows/alpha/01-open.webp" .
test:A2 a ktype:TestStep ; rdfs:label "Use it" ; kpred:part-of test:A ; kpred:step-order "2"^^xsd:integer ; kpred:step-id "use" ;
    kpred:page "/a" ; kpred:page-name "the A tab" ; kpred:box-target "the box" ; skos:definition "Use \\"it\\"." ;
    kpred:assertion "It is used" .
test:B1 a ktype:TestStep ; rdfs:label "Beta one" ; kpred:part-of test:B ; kpred:step-order "1"^^xsd:integer ; kpred:step-id "one" ;
    kpred:page "/b" ; kpred:page-name "the B tab" ; kpred:box-target "the box" ; skos:definition "B one." ;
    kpred:assertion "B holds" ; kpred:screenshot "/workflows/beta/01-one.webp" .
`;

const quads = (ttl: string) => new Parser().parse(ttl);
const build = (version = '9.9.9', testing = TESTING) => buildReview(quads(ROADMAP), loadWorkflows(quads(testing)), version);

function triples(ttl: string) {
  return new Parser().parse(ttl).map((q) => [q.subject.value, q.predicate.value, q.object.value] as const);
}
const R = 'urn:reckons:review/9.9.9/';
const get = (ttl: string, s: string, p: string) => triples(ttl).filter(([a, b]) => a === R + s && b === p).map((t) => t[2]);
const P = (x: string) => 'urn:kbase:predicate/' + x;
const HNAV = (x: string) => 'urn:reckons:nav/' + x;

describe('buildReview', () => {
  it('produces valid Turtle with the release as root', () => {
    const { ttl } = build();
    expect(() => new Parser().parse(ttl)).not.toThrow();
    expect(get(ttl, 'release', 'http://www.w3.org/2000/01/rdf-schema#label')).toEqual(['Review v9.9.9']);
  });

  it('is deterministic: the same inputs give the same bytes', () => {
    expect(build().ttl).toBe(build().ttl);
  });

  it('orders workflows by story: the headline part first, then the rest in roadmap order', () => {
    const { ttl, stats } = build();
    // headline "parent" owns beta via its child phase, so beta comes before alpha (plain)
    expect(get(ttl, 'release', P('has'))).toEqual([R + 'wf-beta', R + 'wf-alpha', R + 'gap']);
    expect(get(ttl, 'wf-beta', HNAV('order'))).toEqual(['1']);
    expect(get(ttl, 'wf-alpha', HNAV('order'))).toEqual(['2']);
    expect(get(ttl, 'wf-beta', HNAV('next'))).toEqual([R + 'wf-alpha']);
    expect(get(ttl, 'wf-alpha', HNAV('prev'))).toEqual([R + 'wf-beta']);
    expect(get(ttl, 'wf-alpha', HNAV('next'))).toEqual([R + 'gap']);
    expect(stats).toMatchObject({ parts: 3, workflows: 2, steps: 3, gaps: 1 });
  });

  it('gives each step its text, screenshot, assertion and an unset verdict', () => {
    const { ttl } = build();
    const step1 = 'wf-alpha-01-open';
    expect(get(ttl, step1, P('photo'))).toEqual(['/workflows/alpha/01-open.webp']);
    const comment = get(ttl, step1, 'http://www.w3.org/2000/01/rdf-schema#comment')[0];
    expect(comment).toContain('Open the A tab.');
    expect(comment).toContain('The test checks: A tab is open');
    expect(get(ttl, step1, 'urn:kbase:meta/review-verdict')).toEqual([VERDICT_UNSET]);
    expect(get(ttl, 'wf-alpha', P('has'))).toEqual([R + step1, R + 'wf-alpha-02-use']);
  });

  it('says so when a step has no screenshot, rather than showing a stand-in', () => {
    const { ttl } = build();
    const step2 = 'wf-alpha-02-use';
    expect(get(ttl, step2, P('photo'))).toEqual([]);
    expect(get(ttl, step2, 'http://www.w3.org/2000/01/rdf-schema#comment')[0]).toContain('No screenshot has been captured');
    expect(get(ttl, step2, 'http://www.w3.org/2000/01/rdf-schema#comment')[0]).toContain('Use "it".');
  });

  it('lists a part with no TestWorkflow under one gap node instead of dropping it', () => {
    const { ttl } = build();
    expect(get(ttl, 'gap', 'http://www.w3.org/2000/01/rdf-schema#label')).toEqual([GAP_LABEL]);
    expect(get(ttl, 'gap', P('has'))).toEqual([R + 'gap-f2']);
    expect(get(ttl, 'gap-f2', 'http://www.w3.org/2000/01/rdf-schema#label')[0]).toContain('Untested feature');
    expect(get(ttl, 'gap-f2', 'http://www.w3.org/2000/01/rdf-schema#comment')[0]).toContain('src/unit.test.ts');
  });

  it('a release with no workflow at all is only the gap node', () => {
    const none = buildReview(quads(ROADMAP), [], '9.9.9');
    expect(none.stats).toMatchObject({ workflows: 0, gaps: 3 });
    expect(get(none.ttl, 'release', P('has'))).toEqual([R + 'gap']);
  });

  it('fails loudly on an unknown release', () => {
    expect(() => build('1.0.0')).toThrow(/exactly one ktype:Release/);
  });
});
