import { describe, it, expect } from 'vitest';
import { testEmbedding } from '../embed';
import { cosine } from '../embed';
import { corpusFixtureTriples } from '../integrations/llm/corpus-fixture';
import demo from '../../../tests/fixtures/compare-demo/notes.json';

describe('compare demo seam (F264.1)', () => {
  it('scores a plural spelling above the near-duplicate threshold and unrelated labels far below it', () => {
    const a = testEmbedding('larkspur orchard cooperative');
    expect(cosine(a, testEmbedding('larkspur orchard cooperatives'))).toBeGreaterThan(0.88);
    expect(cosine(a, testEmbedding('cider press shed'))).toBeLessThan(0.5);
    expect(cosine(testEmbedding('press day'), testEmbedding('has cellar'))).toBeLessThan(0.82);
  });

  it('returns the seed and the change statements for their notes, and nothing for other text', async () => {
    expect((await corpusFixtureTriples(demo.seed.text))?.length).toBe(3);
    const change = await corpusFixtureTriples(demo.change.text);
    expect(change?.map((t) => t.predicate)).toEqual(['press-day', 'members', 'has-cellar', 'has-roof']);
    expect(await corpusFixtureTriples('an unrelated note')).toBeNull();
  });
});
