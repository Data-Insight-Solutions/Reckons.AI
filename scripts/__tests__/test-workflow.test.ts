import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import {
  loadWorkflows, loadWorkflowsFromFile, workflowDiagram, setScreenshotLink, setStoryMediaLink, conventionalScreenshotPath, ROOT,
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
  it('reads demo narration and narrator when present, null when absent (F275.1)', () => {
    const plain = loadWorkflows(parse(PRE + step(1, 'a')));
    expect(plain[0].narrator).toBeNull();
    expect(plain[0].steps[0].narration).toBeNull();
    const narrated = PRE.replace('kpred:test-file "tests/e2e/sample.test.ts" .', 'kpred:test-file "tests/e2e/sample.test.ts" ; kpred:narrator "Shelly V1" .')
      + step(1, 'a', '; kpred:narration "  Here is the first step.  "') + step(2, 'b', '; kpred:narration "   "');
    const w = loadWorkflows(parse(narrated))[0];
    expect(w.narrator).toBe('Shelly V1');
    expect(w.steps[0].narration).toBe('Here is the first step.');
    expect(w.steps[1].narration).toBeNull();
  });

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

import { videoBlock, videoPathProblem } from '../lib/docs-video';

describe('docs video embed (F275.22.1)', () => {
  const base = {
    iri: 'urn:x', id: 'x', title: 'X', definition: '', shotsNote: '', testFile: 't', narrator: null,
    video: '/video/demos/x.mp4', videoCaptions: '/video/demos/x.vtt', videoPoster: '/video/demos/x.webp',
    relatesTo: [], steps: [],
  } as never;
  const yes = () => true;
  it('renders a captioned player with a poster', () => {
    const h = videoBlock(base, yes);
    expect(h).toBe('<video controls preload="metadata" playsinline poster="/video/demos/x.webp"><source src="/video/demos/x.mp4" type="video/mp4"><track kind="captions" srclang="en" label="English" src="/video/demos/x.vtt" default></video>');
  });
  it('omits poster and track when absent, and escapes attribute values', () => {
    const h = videoBlock({ ...(base as object), video: '/video/demos/a"b.mp4', videoCaptions: null, videoPoster: null } as never, yes);
    expect(h).not.toContain('poster');
    expect(h).not.toContain('<track');
    expect(h).toContain('a&quot;b.mp4');
  });
  it('rejects paths outside /video/demos/ and traversal', () => {
    expect(videoPathProblem('/other/x.mp4', ['.mp4'], yes)).toMatch(/not under/);
    expect(videoPathProblem('/video/demos/../x.mp4', ['.mp4'], yes)).toMatch(/not under/);
    expect(videoPathProblem('https://e.com/video/demos/x.mp4', ['.mp4'], yes)).toMatch(/not under/);
  });
  it('errors when an asset is missing from static/', () => {
    expect(() => videoBlock(base, (p) => p !== '/video/demos/x.vtt')).toThrow(/x\.vtt is linked but .* does not exist/);
  });
});

describe('a workflow that points at a story in a space (F300.5)', () => {
  const POINT = PRE.replace('kpred:test-file "tests/e2e/sample.test.ts" .', 'kpred:test-file "tests/e2e/sample.test.ts" ; kpred:story <urn:reckons:story/Walk> ; kpred:story-space "ex" .');
  const SPACE = `
@prefix story: <urn:reckons:story/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
story:Walk a story:Story ; rdfs:label "Walk" .
story:Walk-1 a story:Step ; story:partOf story:Walk ; story:order "1" ; story:title "Open it" ; story:stepId "open" ;
  story:content "We open it." ; story:detail "Open the page." ; story:page "/about" ; story:pageName "the About page" ;
  story:boxTarget "the card" ; story:assertion "The card opens it." ; story:target "card :: The card" ;
  story:media "/workflows/sample/01-open.webp" .
`;
  const load = (id: string) => (id === 'ex' ? parse(SPACE) : null);

  it('reads the steps from the space and keeps the workflow\'s own identity', () => {
    const w = loadWorkflows(parse(POINT), load)[0];
    expect(w.id).toBe('sample');
    expect(w.testFile).toBe('tests/e2e/sample.test.ts');
    expect(w.storySpace).toBe('ex');
    expect(w.steps).toHaveLength(1);
    const s = w.steps[0];
    expect([s.id, s.page, s.pageName, s.boxTarget, s.boxLabel, s.text, s.assertion, s.narration, s.screenshot])
      .toEqual(['open', '/about', 'the About page', 'the card', 'The card', 'Open the page.', 'The card opens it.', 'We open it.', '/workflows/sample/01-open.webp']);
    expect(workflowDiagram(w)).toContain('1. Open it');
  });
  it('fails loudly when the space is not an example', () => {
    expect(() => loadWorkflows(parse(POINT), () => null)).toThrow(/not in EXAMPLE_KBS/);
  });
});

describe('setStoryMediaLink', () => {
  const ttl = [
    'story:Walk-1 a story:Step ;', '    story:title "One" .', '',
    'story:Walk-2 a story:Step ;', '    story:media "/old.webp" ;', '    story:title "Two" .', '',
  ].join('\n');
  it('adds a link to a step that has none and replaces one that has, touching nothing else', () => {
    const a = setStoryMediaLink(ttl, 'urn:reckons:story/Walk-1', '/new.webp');
    expect(a).toContain('story:Walk-1 a story:Step ;\n    story:media "/new.webp" ;\n    story:title "One" .');
    const b = setStoryMediaLink(ttl, 'urn:reckons:story/Walk-2', '/new.webp');
    expect(b).toContain('story:media "/new.webp" ;');
    expect(b).not.toContain('/old.webp');
    expect(b.split('\n').length).toBe(ttl.split('\n').length);
  });
  it('throws for a step that is not there', () => {
    expect(() => setStoryMediaLink(ttl, 'urn:reckons:story/Nope', '/x.webp')).toThrow(/No block/);
  });
});
