import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import type { Quad } from '@rdfjs/types';
import { readStoryQuads, parseAction, parseExpect, allRefusals, type UnifiedStep } from '../story-steps';
import { extractStories } from '../story';
import type { Statement } from '../types';

const PRE = `
@prefix story: <urn:reckons:story/> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <urn:example:> .
`;
const read = (ttl: string, strict = false) => readStoryQuads(new Parser().parse(PRE + ttl), { strict });

const STORY = `
ex:S a story:Story ; rdfs:label "Tour" ; story:description "About" ; story:storyline "Learn it" ;
  story:narrator "Tess" ; story:autoplay "true" ; story:pace "5" .
ex:S1 a story:Step ; story:partOf ex:S ; story:order "1" ; story:title "Add" ; story:stepId "add" ;
  story:content "Say this" ; story:question "Ready?" ; story:target "add-tab :: Add tab" ;
  story:openPage "/ingest" ; story:media "/w/1.webp" ; story:highlight ex:Thing ;
  story:action '{"kind":"click","target":"add-tab"}' ;
  story:expect '{"kind":"note","text":"The tab opens"}' ; story:needs "cap-camera" .
`;
const LEGACY = `
ex:W a ktype:TestWorkflow ; rdfs:label "Tour" ; skos:definition "About" ; kpred:workflow-id "tour" ;
  kpred:test-file "t.ts" ; kpred:narration-storyline "Learn it" ; kpred:narrator "Tess" .
ex:W1 a ktype:TestStep ; kpred:part-of ex:W ; kpred:step-order "1"^^xsd:integer ; kpred:step-id "add" ;
  rdfs:label "Add" ; skos:definition "Say this" ; kpred:narration-lead "Ready?" ;
  kpred:box-target "add-tab" ; kpred:box-label "Add tab" ; kpred:page "/ingest" ;
  kpred:screenshot "/w/1.webp" ; story:highlight ex:Thing ; kpred:assertion "The tab opens" ;
  story:action '{"kind":"click","target":"add-tab"}' ; story:needs "cap-camera" ; kpred:page-name "the Add tab" .
`;
/** The meaning of a step, without the fields only one form has. */
const meaning = (s: UnifiedStep) => ({
  id: s.id, order: s.order, title: s.title, content: s.content, question: s.question, target: s.target,
  openPage: s.openPage, media: s.media, highlights: s.highlights, actions: s.actions, expects: s.expects, needs: s.needs,
});

describe('story-steps reader', () => {
  it('reads every mapped predicate from a story', () => {
    const [st] = read(STORY);
    expect(st).toMatchObject({ origin: 'story', label: 'Tour', description: 'About', storyline: 'Learn it', narrator: 'Tess', autoplay: true, pace: 5 });
    expect(st.steps[0]).toMatchObject({
      id: 'add', title: 'Add', content: 'Say this', question: 'Ready?', openPage: '/ingest', media: '/w/1.webp',
      target: { ref: 'add-tab', label: 'Add tab' }, highlights: ['urn:example:Thing'], needs: ['cap-camera'],
      actions: [{ kind: 'click', target: 'add-tab' }], expects: [{ kind: 'note', text: 'The tab opens' }],
    });
  });

  it('reads every mapped predicate from a legacy workflow', () => {
    const [w] = read(LEGACY);
    expect(w).toMatchObject({ origin: 'test-workflow', id: 'tour', label: 'Tour', storyline: 'Learn it', narrator: 'Tess', testFile: 't.ts' });
    expect(w.steps[0]).toMatchObject({
      content: 'Say this', question: 'Ready?', target: { ref: 'add-tab', label: 'Add tab' }, openPage: '/ingest',
      media: '/w/1.webp', expects: [{ kind: 'note', text: 'The tab opens' }],
    });
  });

  it('gives the same step model from either form for an equivalent step', () => {
    expect(meaning(read(STORY)[0].steps[0])).toEqual(meaning(read(LEGACY)[0].steps[0]));
  });

  it('prefers kpred:narration over the definition for what is said, keeping the definition as detail', () => {
    const [w] = read(LEGACY.replace('kpred:narration-lead', 'kpred:narration "Spoken" ; kpred:narration-lead'));
    expect(w.steps[0]).toMatchObject({ content: 'Spoken', detail: 'Say this' });
  });

  it('parses every action kind', () => {
    const ok = (o: object) => parseAction(JSON.stringify(o));
    expect(ok({ kind: 'open-page', path: '/kb' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'select', entities: ['urn:a'] })).toMatchObject({ ok: true });
    expect(ok({ kind: 'type', target: 'box', text: 'hi' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'run-job', job: 'gen-asset', params: { n: 2, fast: true, name: 'x' } })).toMatchObject({ ok: true });
  });

  it('parses every expectation kind', () => {
    const ok = (o: object) => parseExpect(JSON.stringify(o));
    expect(ok({ kind: 'visible', target: 't' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'count', type: 'urn:kbase:type/Image', n: 3 })).toMatchObject({ ok: true });
    expect(ok({ kind: 'text', target: 't', contains: 'x' })).toMatchObject({ ok: true, expect: { kind: 'text' } });
    expect(ok({ kind: 'attr', target: 't', name: 'data-x', value: 'v' })).toMatchObject({ ok: true, expect: { kind: 'attr', value: 'v' } });
    expect(ok({ kind: 'elements', target: 't', n: 2, attr: 'data-kind', is: 'new' })).toMatchObject({ ok: true, expect: { attr: 'data-kind', is: 'new' } });
    expect(ok({ kind: 'receipt', slug: 'carved-turtle', stage: 'splat' })).toMatchObject({ ok: true });
    expect(ok({ kind: 'media', target: 'asset-image', width: 768 })).toMatchObject({ ok: true });
    expect(parseAction('{"kind":"press","key":"Escape"}')).toMatchObject({ ok: true });
    expect(ok({ kind: 'standing', subject: 'a', predicate: 'b', object: 'c', status: 'confirmed' })).toMatchObject({ ok: true });
  });

  it('refuses an unknown action with a reason, and never drops it silently', () => {
    const [st] = read(STORY.replace(`'{"kind":"click","target":"add-tab"}'`, `'{"kind":"shell","command":"rm -rf /"}'`));
    expect(st.steps[0].actions).toEqual([]);
    expect(st.steps[0].refusals).toEqual([
      expect.objectContaining({ predicate: 'urn:reckons:story/action', reason: expect.stringContaining('unknown action kind "shell"') }),
    ]);
    expect(allRefusals([st])).toHaveLength(1);
  });

  it('refuses malformed and command-shaped actions and expectations', () => {
    expect(parseAction('not json')).toEqual({ ok: false, reason: 'not JSON' });
    expect(parseAction('{"kind":"run-job","job":"x","command":"ls"}')).toMatchObject({ ok: false });
    expect(parseAction('{"kind":"run-job","job":"x","params":{"a":{"b":1}}}')).toMatchObject({ ok: false });
    expect(parseAction('{"kind":"open-page","path":"https://evil.example"}')).toMatchObject({ ok: false });
    expect(parseExpect('{"kind":"count","type":"t","n":-1}')).toMatchObject({ ok: false });
    expect(parseExpect('{"kind":"text","target":"t"}')).toMatchObject({ ok: false });
    expect(parseExpect('{"kind":"elements","target":"t","n":2,"attr":"data-kind"}')).toMatchObject({ ok: false, reason: expect.stringContaining('together') });
    expect(parseExpect('{"kind":"receipt","slug":"x","stage":"audio"}')).toMatchObject({ ok: false });
    expect(parseAction('{"kind":"press","key":"rm -rf"}')).toMatchObject({ ok: false });
    expect(parseExpect('{"kind":"mystery"}')).toMatchObject({ ok: false, reason: expect.stringContaining('unknown expect kind') });
  });

  it('throws on a malformed legacy step when strict, and records the problem otherwise', () => {
    const bad = LEGACY.replace('kpred:box-target "add-tab" ;', '');
    expect(() => read(bad, true)).toThrow('has no kpred:box-target');
    expect(read(bad)[0].steps[0].target?.ref).toBe('');
  });
});

describe('extractStories delegates to the reader', () => {
  const stmts = new Parser().parse(PRE + STORY + LEGACY).map((q: Quad): Statement => ({
    s: { kind: 'iri', value: q.subject.value }, p: { kind: 'iri', value: q.predicate.value },
    o: q.object.termType === 'Literal' ? { kind: 'literal', value: q.object.value } : { kind: 'iri', value: q.object.value },
    status: 'confirmed',
  } as unknown as Statement));

  it('returns the story and not the legacy workflow', () => {
    const stories = extractStories(stmts);
    expect(stories.map(s => s.id)).toEqual(['urn:example:S']);
    expect(stories[0].steps[0]).toMatchObject({ id: 'urn:example:S1', title: 'Add', content: 'Say this', question: 'Ready?' });
  });
});

describe('story:filter (F304)', () => {
  it('parses one filter name on a step', () => {
    const [st] = read(`${STORY}
ex:S1 story:filter "islands" .`);
    expect(st.steps[0].filters).toEqual(['islands']);
  });

  it('parses several filter names, in the order the step says them', () => {
    const [st] = read(`${STORY}
ex:S1 story:filter "islands" , "pending" ; story:filter "no-type" .`);
    expect(st.steps[0].filters).toEqual(['islands', 'pending', 'no-type']);
  });

  it('leaves filters absent when the step names none — the step must leave the filters as they are', () => {
    const [st] = read(STORY);
    expect(st.steps[0].filters).toBeUndefined();
  });

  it('passes names through RAW, without judging them — the reader may be older or newer than the graph', () => {
    const [st] = read(`${STORY}
ex:S1 story:filter "no-such-filter" , "hubs" .`);
    expect(st.steps[0].filters).toEqual(['no-such-filter', 'hubs']);
  });

  it('carries the names through extractStories', () => {
    const stmts = new Parser().parse(PRE + STORY + `
ex:S1 story:filter "islands" , "pending" .`).map((q: Quad): Statement => ({
      s: { kind: 'iri', value: q.subject.value }, p: { kind: 'iri', value: q.predicate.value },
      o: q.object.termType === 'Literal' ? { kind: 'literal', value: q.object.value } : { kind: 'iri', value: q.object.value },
      status: 'confirmed',
    } as unknown as Statement));
    const [story] = extractStories(stmts);
    expect(story.steps[0].filters).toEqual(['islands', 'pending']);
    // The layout rule is the template: a step without a layout has layout undefined.
    expect(story.steps[0].layout).toBeUndefined();
  });

  // NO RESET PATH EXISTS TODAY, and it is not one to invent: the player keeps the last step's
  // story:layout after the end (playStoryStep's end branch only stopAutoPlay()), and exitStory()
  // calls stopStory(), which clears the spotlight but not the layout either. Filters follow the
  // same rule as layout — so the gap of a story's end not clearing the filters it chose is
  // recorded below as it.todo, like layout.
  it.todo('story end clears the filters the story applied');
});
