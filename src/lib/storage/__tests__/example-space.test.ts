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
  it('lands on the main page with Shelly open on learn when no story is asked', () => {
    // Matt, 2026-11-25: "We need to auto open Shelly, show the alpha disclaimer" (the learn tab carries the note).
    expect(exampleLanding()).toBe('/?shelly=learn');
    expect(exampleLanding({ autoplay: true })).toBe('/?shelly=learn'); // autoplay alone starts no story
    expect(read(exampleLanding({ sel: 'i:urn:x' })).get('shelly')).toBe('learn');
  });

  it('carries a step number with a story, and nothing else as a step', () => {
    expect(read(exampleLanding({ story: '1', step: '6' })).get('step')).toBe('6');
    expect(read(exampleLanding({ story: '1', step: 'x' })).get('step')).toBeNull();
    expect(read(exampleLanding({ step: '6' })).get('step')).toBeNull(); // no story, no step
  });

  it('leaves shelly= off when a story is asked: story mode opens her on explore by itself', () => {
    expect(read(exampleLanding({ story: '1', autoplay: true })).get('shelly')).toBeNull();
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

  it('carries an entity selection (?sel=i:<iri>) alone or with the story', () => {
    const sel = 'i:urn:reckons:ring/frames-contact-sheet';
    expect(read(exampleLanding({ sel })).get('sel')).toBe(sel); // colon and slash survive, like a story IRI
    expect(read(exampleLanding({ sel })).get('story')).toBeNull();
    const both = read(exampleLanding({ story: '1', autoplay: true, sel }));
    expect(both.get('story')).toBe('1');
    expect(both.get('autoplay')).toBe('1');
    expect(both.get('sel')).toBe(sel);
    expect(read(exampleLanding({ sel: 'i:x' })).get('sel')).toBe('i:x');
  });
});
