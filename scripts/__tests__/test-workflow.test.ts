import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import {
  loadWorkflows, loadWorkflowsFromFile, workflowDiagram, setScreenshotLink, conventionalScreenshotPath, ROOT,
} from '../lib/test-workflow';
import { checkWorkflows } from '../offline/test-workflow-check';

const PRE = `
@prefix test: <urn:reckons:test/> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
test:W a ktype:TestWorkflow ; rdfs:label "Sample" ; kpred:workflow-id "sample" ; kpred:test-file "tests/e2e/sample.test.ts" .
`;
const step = (n: number, id: string, extra = '') => `
test:W-${id}
    a ktype:TestStep ;
    rdfs:label "Step ${id}" ;
    kpred:part-of test:W ;
    kpred:step-order "${n}"^^xsd:integer ;
    kpred:step-id "${id}" ;
    kpred:page "/p${n}" ;
    kpred:page-name "the P${n} tab" ;
    kpred:box-target "the control for ${id}" ;
    skos:definition "Text ${id}" ;
    kpred:assertion "Checks ${id}" ${extra} .
`;
const parse = (ttl: string) => new Parser().parse(ttl);

describe('loadWorkflows', () => {
  it('returns steps in kpred:step-order, not file order', () => {
    const w = loadWorkflows(parse(PRE + step(2, 'second') + step(1, 'first')));
    expect(w).toHaveLength(1);
    expect(w[0].steps.map((s) => s.id)).toEqual(['first', 'second']);
  });

  it('fails loudly on a step with no assertion or a duplicate order', () => {
    const noAssertion = PRE + step(1, 'a').replace(/kpred:assertion "[^"]*"/, '');
    expect(() => loadWorkflows(parse(noAssertion))).toThrow(/no kpred:assertion|assertion/);
    expect(() => loadWorkflows(parse(PRE + step(1, 'a') + step(1, 'b')))).toThrow(/same kpred:step-order/);
  });

  it('requires every step to say what its box sits on and what the place is called', () => {
    const noTarget = PRE + step(1, 'a').replace(/kpred:box-target "[^"]*" ;/, '');
    expect(() => loadWorkflows(parse(noTarget))).toThrow(/box-target/);
    const noName = PRE + step(1, 'a').replace(/kpred:page-name "[^"]*" ;/, '');
    expect(() => loadWorkflows(parse(noName))).toThrow(/page-name/);
    const w = loadWorkflows(parse(PRE + step(1, 'a')))[0].steps[0];
    expect(w.boxTarget).toBe('the control for a');
    expect(w.pageName).toBe('the P1 tab');
  });
});

describe('workflowDiagram', () => {
  it('names every step once, in order, and changes when a step is added (so drift moves the cache key)', () => {
    const two = loadWorkflows(parse(PRE + step(1, 'a') + step(2, 'b')))[0];
    const three = loadWorkflows(parse(PRE + step(1, 'a') + step(2, 'b') + step(3, 'c')))[0];
    const d = workflowDiagram(two);
    expect(d.startsWith('flowchart TB')).toBe(true);
    expect(d).toContain('S1 --> S2');
    expect(d.indexOf('1. Step a')).toBeLessThan(d.indexOf('2. Step b'));
    expect(workflowDiagram(three)).not.toBe(d);
  });

  it('cannot be broken by quotes or markup in a step title', () => {
    const w = loadWorkflows(parse(PRE + step(1, 'a').replace("Step a", "Say \\\"hi\\\" <b>")))[0];
    expect(workflowDiagram(w)).not.toMatch(/"hi"|<b>/);
  });
});

describe('setScreenshotLink', () => {
  const ttl = `test:Foo-Step1\n    rdf:type x ;\n    kpred:page "/a" ;\n    kpred:assertion "z" .\n\ntest:Foo-Step2\n    kpred:page "/b" .\n`;
  it('inserts after kpred:page in the right block and replaces on a second run', () => {
    const once = setScreenshotLink(ttl, 'urn:reckons:test/Foo-Step1', '/workflows/f/01-a.webp');
    expect(once).toContain('kpred:page "/a" ;\n    kpred:screenshot    "/workflows/f/01-a.webp" ;');
    expect(once.match(/kpred:screenshot/g)).toHaveLength(1);
    const twice = setScreenshotLink(once, 'urn:reckons:test/Foo-Step1', '/workflows/f/01-b.webp');
    expect(twice).toContain('01-b.webp');
    expect(twice).not.toContain('01-a.webp');
    expect(twice).toContain('test:Foo-Step2\n    kpred:page "/b" .');
  });
  it('throws for a step that is not there', () => {
    expect(() => setScreenshotLink(ttl, 'urn:reckons:test/Nope', '/x.webp')).toThrow(/No block/);
  });
});

describe('checkWorkflows', () => {
  const w = loadWorkflows(parse(PRE + step(1, 'a', '; kpred:screenshot "/workflows/sample/01-a.webp"') + step(2, 'b')))[0];
  const test = "const impls = { 'a': 1, b: 2 }";
  it('reports a step with no screenshot and a linked file that is missing', () => {
    const f = checkWorkflows([w], () => false, () => true, () => test);
    expect(f.map((x) => x.rule).sort()).toEqual(['missing-file', 'no-screenshot']);
  });
  it('is clean when the file exists and the test names every step', () => {
    const full = { ...w, steps: w.steps.map((s) => ({ ...s, screenshot: conventionalScreenshotPath(w, s) })) };
    expect(checkWorkflows([full], () => true, () => true, () => test)).toEqual([]);
  });
  it('reports a step the test never names', () => {
    const f = checkWorkflows([w], () => true, () => true, () => "const impls = { 'a': 1 }");
    expect(f.some((x) => x.rule === 'step-not-in-test' && x.step === 'b')).toBe(true);
  });
});

describe('the real flagship workflow', () => {
  const flagship = loadWorkflowsFromFile().find((x) => x.id === 'readme-path')!;
  it('exists with the five steps the README path needs, in order', () => {
    expect(flagship.steps.map((s) => s.id)).toEqual(
      ['add-source', 'review-claims', 'confirm-claims', 'see-in-space', 'reckoning']);
  });
  it('is run by a test file that names every step (static twin of the e2e mismatch check)', () => {
    const text = readFileSync(join(ROOT, flagship.testFile), 'utf8');
    for (const s of flagship.steps) expect(text, s.id).toMatch(new RegExp(`['"]?${s.id}['"]?\\s*:`));
  });
});
