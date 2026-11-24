import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { EXAMPLE_TTL, WALK_TTL, exampleTtl } from '../gen-assets';
import { readStoryQuads } from '../../../src/lib/rdf/story-steps';

/**
 * F300.5: the Generated assets walk is a story inside the example. static/starter-generated-assets.ttl is GENERATED, so a
 * story written into it by hand would be deleted by the next regeneration; the generator copies scripts/content/gen-assets-walk.ttl in.
 */
describe('the Generated assets walk survives regeneration', () => {
  const walk = readFileSync(WALK_TTL, 'utf8').trimEnd();

  it('the generator emits the walk, whatever the receipts are', () => {
    expect(exampleTtl([])).toContain(walk);
  });

  it('the committed example holds exactly that text (a regeneration would not change it)', () => {
    expect(readFileSync(EXAMPLE_TTL, 'utf8')).toContain(walk);
  });

  it('reads as one story of six steps in order, beside the Shelly one, each step carrying what a docs page prints', () => {
    const stories = readStoryQuads(new Parser().parse(readFileSync(EXAMPLE_TTL, 'utf8'))).filter((s) => s.origin === 'story');
    expect(stories.map((s) => s.iri).sort()).toEqual(['urn:reckons:story/create-generated-asset', 'urn:reckons:story/generated-assets-walk']);
    const w = stories.find((s) => s.iri.endsWith('generated-assets-walk'))!;
    expect(w.steps.map((s) => s.id)).toEqual(['open-example', 'see-pipeline', 'picture', 'video', 'splat', 'background']);
    expect(w.shotsNote).toContain('How these screenshots were made');
    for (const st of w.steps) {
      expect(st.refusals, st.id).toEqual([]);
      expect(st.detail && st.pageName && st.boxTarget && st.media, st.id).toBeTruthy();
      expect(st.expects.some((e) => e.kind === 'note'), st.id).toBe(true);
    }
    expect(w.steps.find((s) => s.id === 'splat')!.expects.some((e) => e.kind === 'receipt')).toBe(true);
  });
});
