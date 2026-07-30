/**
 * Graph sets (F113) — grouping the graph list by purpose.
 *
 * Two properties carry the weight. An archive must never be sorted away from its parent, because
 * an archive read as a working graph invites edits that belong somewhere else. And the BASIS of
 * each grouping must be reported, because name-derivation is a guess and a guess presented as
 * fact is one the user cannot know to correct.
 */
import { describe, it, expect } from 'vitest';
import { groupIntoSets, findDuplicateGraphs } from '../graph-sets';
import type { KbEntry } from '../kb-registry';

const kb = (name: string, over: Partial<KbEntry> = {}): KbEntry => ({
  id: `kbase_${name.replace(/\W/g, '_')}`, name, createdAt: 0, ...over,
});

describe('grouping by purpose', () => {
  it('puts the website design and status graphs in one set', () => {
    const sets = groupIntoSets([kb('website'), kb('website-status'), kb('docs-features')]);
    const site = sets.find((s) => s.id === 'website')!;
    expect(site.groups.map((g) => g.parent.name).sort()).toEqual(['website', 'website-status']);
    expect(site.rowCount).toBe(2);
  });

  it('separates docs sources, project graphs and starters', () => {
    const sets = groupIntoSets([
      kb('docs-features'), kb('reckons-roadmap'), kb('starter-guide'), kb('website'),
    ]);
    expect(sets.map((s) => s.id)).toEqual(['website', 'docs', 'project', 'starters']);
  });

  it('puts an unrecognised graph in Other, last', () => {
    const sets = groupIntoSets([kb('My Research'), kb('website')]);
    expect(sets.map((s) => s.id)).toEqual(['website', 'other']);
    expect(sets.at(-1)!.groups[0].parent.name).toBe('My Research');
  });

  it('keeps a stable order rather than sorting by size', () => {
    // The list is somewhere a user navigates by memory; rearranging it when one set grows is
    // worse than a long list.
    const many = [kb('website'), ...Array.from({ length: 9 }, (_, i) => kb(`docs-${i}`))];
    expect(groupIntoSets(many).map((s) => s.id)).toEqual(['website', 'docs']);
  });

  it('reports the BASIS, so a guess looks like a guess', () => {
    const sets = groupIntoSets([kb('website'), kb('My Research')]);
    expect(sets.find((s) => s.id === 'website')!.basis).toBe('name');
    expect(sets.find((s) => s.id === 'other')!.basis).toBe('ungrouped');
  });

  it('prefers a DECLARED set over the name, and says the basis changed', () => {
    const declared = { ...kb('My Research'), declaredSet: 'website' } as KbEntry;
    const sets = groupIntoSets([declared]);
    expect(sets[0].id).toBe('website');
    expect(sets[0].basis).toBe('declared');
  });

  it('every set carries a stated purpose', () => {
    for (const s of groupIntoSets([kb('website'), kb('docs-x'), kb('reckons-y'), kb('starter-z'), kb('Mine')])) {
      expect(s.purpose.length).toBeGreaterThan(10);
    }
  });
});

describe('archives follow their graph', () => {
  const parent = kb('Research', { stableId: 'stable-1' });
  const archive = kb('Research (archives)', { archiveOf: 'stable-1' });

  it('nests an archive under its parent instead of listing it separately', () => {
    const sets = groupIntoSets([parent, archive]);
    const other = sets.find((s) => s.id === 'other')!;
    expect(other.groups).toHaveLength(1);
    expect(other.groups[0].archives.map((a) => a.name)).toEqual(['Research (archives)']);
    expect(other.rowCount).toBe(2);
  });

  it('places an archive by its PARENT even when its own name matches another rule', () => {
    // "website (archives)" of a graph called "Client Site" belongs with the client site.
    const site = kb('Client Site', { stableId: 'stable-2' });
    const arch = kb('website (archives)', { archiveOf: 'stable-2' });
    const sets = groupIntoSets([site, arch]);
    expect(sets.find((s) => s.id === 'website')).toBeUndefined();
    expect(sets.find((s) => s.id === 'other')!.groups[0].archives).toHaveLength(1);
  });
});

describe('duplicate graphs are reported, never removed', () => {
  it('finds graphs sharing a name but not an id', () => {
    // Re-importing a source mints a NEW database; the second row is an independent copy that
    // will disagree the moment either is edited.
    const dupes = findDuplicateGraphs([
      kb('reckons-roadmap', { id: 'a', statementCount: 10 }),
      kb('reckons-roadmap', { id: 'b', statementCount: 400 }),
      kb('website'),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].name).toBe('reckons-roadmap');
    // Fullest first — the likeliest real one, offered for judgement rather than acted on.
    expect(dupes[0].entries.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('reports nothing when every name is unique', () => {
    expect(findDuplicateGraphs([kb('website'), kb('website-status')])).toEqual([]);
  });

  it('ignores case and surrounding space when comparing names', () => {
    expect(findDuplicateGraphs([kb('Website'), kb(' website ')])).toHaveLength(1);
  });
});
