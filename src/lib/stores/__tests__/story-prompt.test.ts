/**
 * Story detection — mostly about what it REFUSES to announce.
 *
 * A notification spends the user's attention, and this one fires on graph load, which is the
 * moment they are least willing to have it spent. So the assertions below are weighted toward
 * staying silent: no story, one orphan step, a story whose steps were all rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pushNotification = vi.fn();
vi.mock('../notifications.svelte', () => ({ pushNotification }));

const { detectStory, promptStoryIfPresent } = await import('../story-prompt.svelte');
import type { Statement } from '../../rdf/types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
let seq = 0;
const st = (s: string, p: string, o: string, literal = false): Statement =>
  ({
    id: `s${seq++}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: literal ? { kind: 'literal', value: o } : { kind: 'iri', value: o },
    g: { kind: 'iri', value: 'urn:kbase:source/x' },
    sourceId: 'x',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
  }) as Statement;

const step = (n: number) => st(`urn:kbase:concept/step-${n}`, RDF_TYPE, 'urn:reckons:story/Step');

beforeEach(() => pushNotification.mockClear());

describe('detectStory', () => {
  it('counts step SUBJECTS, not triples', () => {
    // A step node carries title, content, order, layout… Counting statements would report a
    // five-step story as seventeen steps.
    const graph = [
      step(1),
      st('urn:kbase:concept/step-1', 'urn:reckons:story/title', 'One', true),
      st('urn:kbase:concept/step-1', 'urn:reckons:story/content', 'Body', true),
      step(2),
      st('urn:kbase:concept/step-2', 'urn:reckons:story/content', 'Body', true),
    ];
    expect(detectStory(graph).steps).toBe(2);
  });

  it('reads the story title when the graph names one', () => {
    const graph = [
      step(1),
      step(2),
      st('urn:kbase:concept/turtle-story', RDF_TYPE, 'urn:reckons:story/Story'),
      st('urn:kbase:concept/turtle-story', 'http://www.w3.org/2000/01/rdf-schema#label', 'Meet the turtles', true),
    ];
    expect(detectStory(graph).title).toBe('Meet the turtles');
  });

  it('finds nothing in a graph with no story', () => {
    const graph = [st('urn:kbase:concept/a', 'urn:kbase:predicate/is-a', 'urn:kbase:concept/b')];
    expect(detectStory(graph).steps).toBe(0);
  });

  it('ignores rejected and superseded steps', () => {
    const graph = [{ ...step(1), status: 'rejected' } as Statement, { ...step(2), status: 'superseded' } as Statement];
    expect(detectStory(graph).steps).toBe(0);
  });

  it('also recognises visual-test steps', () => {
    const graph = [
      st('urn:kbase:concept/t1', RDF_TYPE, 'urn:kbase:type/TestStep'),
      st('urn:kbase:concept/t2', RDF_TYPE, 'urn:kbase:type/TestStep'),
    ];
    expect(detectStory(graph).steps).toBe(2);
  });
});

describe('promptStoryIfPresent', () => {
  it('announces a real story once, scoped to the graph', () => {
    promptStoryIfPresent([step(1), step(2), step(3)], 'kb-turtles');
    expect(pushNotification).toHaveBeenCalledTimes(1);
    const n = pushNotification.mock.calls[0][0];
    // Scoped id + oneTime is what makes it once-per-GRAPH rather than once-per-device: dismissing
    // one graph's prompt must not silence the next graph someone sends.
    expect(n.id).toBe('story:available:kb-turtles');
    expect(n.oneTime).toBe(true);
    expect(n.body).toContain('3 steps');
  });

  it('SAYS NOTHING when there is no story', () => {
    promptStoryIfPresent([st('urn:kbase:concept/a', 'urn:kbase:predicate/p', 'urn:kbase:concept/b')], 'kb-x');
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it('SAYS NOTHING for a single orphan step — a fragment is not a walk', () => {
    promptStoryIfPresent([step(1)], 'kb-x');
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it('uses the story title in the headline when there is one', () => {
    promptStoryIfPresent(
      [
        step(1),
        step(2),
        st('urn:kbase:concept/s', RDF_TYPE, 'urn:reckons:story/Story'),
        st('urn:kbase:concept/s', 'http://www.w3.org/2000/01/rdf-schema#label', 'Meet the turtles', true),
      ],
      'kb-turtles',
    );
    expect(pushNotification.mock.calls[0][0].title).toContain('Meet the turtles');
  });

  it('gives two different graphs two different ids', () => {
    promptStoryIfPresent([step(1), step(2)], 'kb-a');
    promptStoryIfPresent([step(1), step(2)], 'kb-b');
    const ids = pushNotification.mock.calls.map((c) => c[0].id);
    expect(new Set(ids).size).toBe(2);
  });
});
