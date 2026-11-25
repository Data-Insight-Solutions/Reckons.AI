import { describe, expect, it } from 'vitest';
import { exampleLanding } from '../example-space';

/**
 * F292.4 (kb:site-story-improved), start from the link: /about?example=<id>&story=<iri|n>&autoplay=1
 * must open the example AND start its story at step 1. The landing URL this page hands to
 * switchToKb is the whole parameter handling, so it is tested here, pure, the way the check-tier
 * conventions test the pure core (the e2e spec tests the journey). startStoryFromLink reads the
 * URL with URLSearchParams, so these assertions go through the same decoding it does.
 */
const read = (landing: string) => new URL(`http://reckons.local${landing}`).searchParams;

describe('exampleLanding — the ?story=&autoplay= a link asks for', () => {
  it('lands on the main page when no story is asked', () => {
    expect(exampleLanding()).toBe('/');
    expect(exampleLanding({ autoplay: true })).toBe('/'); // autoplay alone starts no story
  });

  it('keeps the F261 behaviour for story: true — the space\'s own first walk', () => {
    const p = read(exampleLanding({ story: true }));
    expect(p.get('story')).toBe(''); // empty value: startStoryFromLink falls to the first story with >= 2 steps
    expect(p.get('autoplay')).toBeNull();
  });

  it('carries a step number and a story IRI through, undamaged', () => {
    expect(read(exampleLanding({ story: '1' })).get('story')).toBe('1');
    const iri = 'urn:reckons:story/ReckonsPhilosophy';
    const p = read(exampleLanding({ story: iri }));
    expect(p.get('story')).toBe(iri); // the colon and slash survive the round trip, so the id match works
  });

  it('appends autoplay=1 only when asked, and only with a story', () => {
    const on = read(exampleLanding({ story: '1', autoplay: true }));
    expect(on.get('autoplay')).toBe('1');
    expect(read(exampleLanding({ story: '1', autoplay: false })).get('autoplay')).toBeNull();
    expect(read(exampleLanding({ autoplay: true })).get('autoplay')).toBeNull();
  });
});
