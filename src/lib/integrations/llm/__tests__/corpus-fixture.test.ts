import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { corpusFixtureTriples } from '../corpus-fixture';

const note = (f: string) => readFileSync(`tests/fixtures/notes-corpus/${f}`, 'utf8');

describe('corpus notes the mock backend reads for real (F183.3)', () => {
  it('returns the hand-checked facts for the build note and the change note', async () => {
    const built = await corpusFixtureTriples(note('06-garden-build.txt'));
    expect(built?.map((t) => `${t.subject} ${t.predicate} ${t.object}`)).toContain('tool-shed open-on Saturday');
    const changed = await corpusFixtureTriples(note('07-garden-change.txt'));
    // The change note must read as the NEW state: Sunday and 16, never the old day or the number added.
    expect(changed?.map((t) => t.object)).toEqual(expect.arrayContaining(['Sunday', '16', 'marco-ruiz']));
    expect(changed?.some((t) => t.object === 'Saturday' || t.object === '4')).toBe(false);
  });
  it('leaves every other text to the placeholder extractor', async () => {
    expect(await corpusFixtureTriples('Company Alpha has 50 employees.')).toBeNull();
  });
});
