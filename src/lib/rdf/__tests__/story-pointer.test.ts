import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import type { Quad } from '@rdfjs/types';
import { applyPointers, readPointers } from '../story-pointer';
import { readStoryQuads } from '../story-steps';

const PRE = `
@prefix test: <urn:reckons:test/> .
@prefix story: <urn:reckons:story/> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
`;
const parse = (t: string): Quad[] => new Parser().parse(PRE + t);

const WORKFLOW = (extra: string) => `
test:W a ktype:TestWorkflow ; rdfs:label "Walk" ; skos:definition "About the walk." ;
  kpred:workflow-id "walk" ; kpred:test-file "tests/e2e/walk.test.ts" ${extra} .`;

const SPACE = (stepExtra = '') => `
story:Walk a story:Story ; rdfs:label "A walk" ; story:shotsNote "How the pictures were made." .
story:Walk-1 a story:Step ; story:partOf story:Walk ; story:order "1" ; story:title "Open it" ;
  story:stepId "open" ; story:content "We open it." ; story:detail "Open the page." ;
  story:page "/about" ; story:pageName "the About page" ; story:boxTarget "the card" ;
  story:assertion "The card opens it." ; story:target "card :: The card" ;
  story:action '{"kind":"click","target":"card"}' ; story:media "/workflows/walk/01-open.webp" ${stepExtra} .
`;
const load = (id: string): Quad[] | null => (id === 'ex' ? parse(SPACE()) : null);
const legacy = (q: Quad[]) => readStoryQuads(q, { strict: true }).filter((s) => s.origin === 'test-workflow');

describe('readPointers (F300.5)', () => {
  it('reads kpred:story and kpred:story-space together', () => {
    const q = parse(WORKFLOW('; kpred:story story:Walk ; kpred:story-space "ex"'));
    expect(readPointers(q)).toEqual([{ workflowIri: 'urn:reckons:test/W', storyIri: 'urn:reckons:story/Walk', spaceId: 'ex' }]);
  });
  it('refuses a half pointer, in either direction', () => {
    expect(() => readPointers(parse(WORKFLOW('; kpred:story story:Walk')))).toThrow(/no kpred:story-space/);
    expect(() => readPointers(parse(WORKFLOW('; kpred:story-space "ex"')))).toThrow(/no kpred:story\b/);
  });
  it('finds nothing in a workflow that keeps its own steps', () => {
    expect(readPointers(parse(WORKFLOW('')))).toEqual([]);
  });
});

describe('applyPointers', () => {
  const pointing = parse(WORKFLOW('; kpred:story story:Walk ; kpred:story-space "ex"'));

  it('gives the workflow the steps of the story it points at, and keeps its own identity', () => {
    const [w] = applyPointers(legacy(pointing), pointing, load);
    expect(w.id).toBe('walk');
    expect(w.label).toBe('Walk');
    expect(w.testFile).toBe('tests/e2e/walk.test.ts');
    expect(w.shotsNote).toBe('How the pictures were made.');
    expect(w.steps.map((s) => s.id)).toEqual(['open']);
    expect(w.steps[0].actions).toEqual([{ kind: 'click', target: 'card' }]);
    expect(w.steps[0].media).toBe('/workflows/walk/01-open.webp');
    expect(w.steps[0].pageName).toBe('the About page');
    expect(w.steps[0].expects.some((e) => e.kind === 'note')).toBe(true);
  });

  it('throws, with the reason, for an id that is not an example', () => {
    const q = parse(WORKFLOW('; kpred:story story:Walk ; kpred:story-space "nowhere"'));
    expect(() => applyPointers(legacy(q), q, load)).toThrow(/"nowhere", which is not in EXAMPLE_KBS/);
  });
  it('throws for a story the example does not hold', () => {
    const q = parse(WORKFLOW('; kpred:story story:Missing ; kpred:story-space "ex"'));
    expect(() => applyPointers(legacy(q), q, load)).toThrow(/not a story:Story in example "ex"/);
  });
  it('throws when a step lacks what a docs page prints', () => {
    const bad = (id: string): Quad[] | null => (id === 'ex' ? parse(SPACE().replace('story:pageName "the About page" ;', '')) : null);
    expect(() => applyPointers(legacy(pointing), pointing, bad)).toThrow(/no story:pageName/);
  });
  it('refuses a workflow that has its own steps AND a pointer', () => {
    const both = parse(WORKFLOW('; kpred:story story:Walk ; kpred:story-space "ex"') + `
test:W-1 a ktype:TestStep ; rdfs:label "S" ; kpred:part-of test:W ; kpred:step-order 1 ; kpred:step-id "s" ; kpred:page "/" ;
  kpred:page-name "p" ; kpred:box-target "t" ; skos:definition "d" ; kpred:assertion "a" .`);
    expect(() => applyPointers(legacy(both), both, load)).toThrow(/its own steps AND points/);
  });
  it('passes a workflow without a pointer through untouched', () => {
    const plain = parse(WORKFLOW(''));
    const stories = legacy(plain);
    expect(applyPointers(stories, plain, load)).toBe(stories);
  });
});
