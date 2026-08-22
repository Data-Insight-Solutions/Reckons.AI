/**
 * Graph sets (F113) — grouping the graph list for ANY user.
 *
 * The first version of this module hardcoded THIS repository's naming (`docs-`, `reckons-`,
 * `starter-`) and invented purpose text for the graphs it matched. It grouped one developer's
 * graphs and nobody else's. So the tests that matter here are the ones proving the logic knows
 * nothing about this project: an unrelated user's naming must cluster for the same reasons, and
 * no set may acquire a purpose the user did not write.
 */
import { describe, it, expect } from 'vitest';
import {
  groupIntoSets, bucketIntoSets, suggestSetsFromNames, findDuplicateGraphs, folderSetOf,
  type GraphSetDefinition,
} from '../graph-sets';
import { groupGraphsWithArchives } from '../archive-gallery';
import type { KbEntry } from '../kb-registry';

const kb = (name: string, over: Partial<KbEntry> = {}): KbEntry => ({
  id: `kbase_${name.replace(/\W/g, '_')}`, name, createdAt: 0, ...over,
});

describe('nothing about this project is compiled in', () => {
  it('clusters a stranger\'s naming exactly as it clusters ours', () => {
    const sets = groupIntoSets([
      kb('trip-2024'), kb('trip-2025'), kb('recipes-baking'), kb('recipes-dinner'), kb('Taxes'),
    ]);
    expect(sets.map((s) => s.title)).toEqual(['Recipes', 'Trip', 'Ungrouped']);
    expect(sets[0].groups.map((g) => g.parent.name)).toEqual(['recipes-baking', 'recipes-dinner']);
  });

  it('never invents a purpose for a set it derived', () => {
    // Guessing what someone's graphs are FOR is how a tool starts telling users what their own
    // data means.
    for (const s of groupIntoSets([kb('trip-a'), kb('trip-b')])) {
      expect(s.purpose).toBe('');
    }
  });

  it('uses the purpose the user wrote, and only that', () => {
    const defs: GraphSetDefinition[] = [
      { id: 'holiday', title: 'Holidays', purpose: 'Places I have been.', prefix: 'trip-' },
    ];
    const [set] = groupIntoSets([kb('trip-a'), kb('trip-b')], { definitions: defs });
    expect(set.title).toBe('Holidays');
    expect(set.purpose).toBe('Places I have been.');
    expect(set.basis).toBe('defined');
  });

  it('does not cluster names that merely share letters', () => {
    // "Research" and "Recipes" share a prefix and nothing else; a grouping on that is one no
    // user could follow.
    const sets = groupIntoSets([kb('Research'), kb('Recipes')]);
    expect(sets.map((s) => s.title)).toEqual(['Ungrouped']);
    expect(sets[0].rowCount).toBe(2);
  });

  it('lets the caller name the leftover group', () => {
    const [set] = groupIntoSets([kb('Solo')], { ungroupedTitle: 'Other graphs' });
    expect(set.title).toBe('Other graphs');
  });

  it('can be turned off entirely', () => {
    const sets = groupIntoSets([kb('trip-a'), kb('trip-b')], { deriveFromNames: false });
    expect(sets.map((s) => s.title)).toEqual(['Ungrouped']);
  });
});

describe('suggesting sets from real names', () => {
  it('offers a set only when at least two graphs share a prefix', () => {
    // A "set" of one is a graph with a heading over it — chrome, no information.
    expect(suggestSetsFromNames([kb('trip-a'), kb('solo-thing')]).map((d) => d.title)).toEqual([]);
    expect(suggestSetsFromNames([kb('trip-a'), kb('trip-b')]).map((d) => d.title)).toEqual(['Trip']);
  });

  it('reads hyphen, underscore, space, slash and colon as separators', () => {
    const names = ['a-1', 'a_2', 'b 1', 'b 2', 'c/1', 'c/2', 'd:1', 'd:2'];
    expect(suggestSetsFromNames(names.map((n) => kb(n))).map((d) => d.title))
      .toEqual(['A', 'B', 'C', 'D']);
  });

  it('produces definitions a user can then own and edit', () => {
    const [def] = suggestSetsFromNames([kb('trip-a'), kb('trip-b')]);
    expect(def).toMatchObject({ prefix: 'trip', title: 'Trip' });
    expect(def.purpose).toBeUndefined();
  });
});

describe('precedence between the three sources', () => {
  const defs: GraphSetDefinition[] = [
    { id: 'mine', title: 'Mine', prefix: 'trip-' },
    { id: 'special', title: 'Special', memberIds: ['kbase_trip_b'] },
  ];

  it('explicit membership beats a matching prefix', () => {
    // A user who listed a graph by id meant that graph, whatever else its name matches.
    const sets = groupIntoSets([kb('trip-a'), kb('trip-b')], { definitions: defs });
    expect(sets.find((s) => s.id === 'special')!.groups.map((g) => g.parent.name)).toEqual(['trip-b']);
    expect(sets.find((s) => s.id === 'mine')!.groups.map((g) => g.parent.name)).toEqual(['trip-a']);
  });

  it('a declared set on the graph beats everything', () => {
    const declared = { ...kb('trip-a'), declaredSet: 'mine' } as KbEntry;
    const [set] = groupIntoSets([declared], { definitions: defs });
    expect(set.basis).toBe('declared');
    expect(set.title).toBe('Mine');
  });

  it('a longer prefix wins over a broader one', () => {
    const narrow: GraphSetDefinition[] = [
      { id: 'broad', title: 'Broad', prefix: 'trip' },
      { id: 'narrow', title: 'Narrow', prefix: 'trip-2024' },
    ];
    const sets = groupIntoSets([kb('trip-2024-spain')], { definitions: narrow });
    expect(sets[0].id).toBe('narrow');
  });

  it('keeps user-defined sets in the order the user gave them', () => {
    const sets = groupIntoSets(
      [kb('zzz-1'), kb('zzz-2'), kb('trip-a')],
      { definitions: [{ id: 'mine', title: 'Mine', prefix: 'trip-' }] },
    );
    // Defined first, derived after, leftovers last.
    expect(sets.map((s) => s.id)).toEqual(['mine', 'derived:zzz']);
  });

  it('always puts the leftover group last', () => {
    const sets = groupIntoSets([kb('Solo'), kb('trip-a'), kb('trip-b')]);
    expect(sets.at(-1)!.groups[0].parent.name).toBe('Solo');
  });
});

describe('archives follow their graph', () => {
  it('nests an archive under its parent rather than listing it apart', () => {
    const parent = kb('trip-a', { stableId: 'stable-1' });
    const archive = kb('trip-a (archives)', { archiveOf: 'stable-1' });
    const [set] = groupIntoSets([parent, archive, kb('trip-b')]);
    const group = set.groups.find((g) => g.parent.name === 'trip-a')!;
    expect(group.archives.map((a) => a.name)).toEqual(['trip-a (archives)']);
    expect(set.rowCount).toBe(3);
  });

  it('places an archive by its PARENT even when its own name matches another set', () => {
    const site = kb('Client Site', { stableId: 'stable-2' });
    const arch = kb('trip-notes (archives)', { archiveOf: 'stable-2' });
    const sets = groupIntoSets([site, arch, kb('trip-a'), kb('trip-b')]);
    expect(sets.find((s) => s.title === 'Trip')!.rowCount).toBe(2);
    expect(sets.at(-1)!.groups[0].archives).toHaveLength(1);
  });
});

describe('bucketing pre-sorted groups', () => {
  it('preserves the caller\'s ordering within a set', () => {
    // The page sorts by current-graph, bookmarks, then choice; reimplementing that here is how
    // it would drift.
    const entries = [kb('trip-b'), kb('trip-a')];
    const sets = bucketIntoSets(groupGraphsWithArchives(entries), {}, entries);
    expect(sets[0].groups.map((g) => g.parent.name)).toEqual(['trip-b', 'trip-a']);
  });

  it('derives from the WHOLE registry, so filtering does not make sets vanish', () => {
    const all = [kb('trip-a'), kb('trip-b')];
    const filtered = groupGraphsWithArchives([all[0]]);
    expect(bucketIntoSets(filtered, {}, all)[0].title).toBe('Trip');
  });
});

describe('duplicate graphs are reported, never removed', () => {
  it('finds graphs sharing a name but not an id, fullest first', () => {
    const dupes = findDuplicateGraphs([
      kb('roadmap', { id: 'a', statementCount: 10 }),
      kb('roadmap', { id: 'b', statementCount: 400 }),
      kb('other'),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].entries.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('ignores case and surrounding space', () => {
    expect(findDuplicateGraphs([kb('Trip'), kb(' trip ')])).toHaveLength(1);
  });

  it('reports nothing when every name is unique', () => {
    expect(findDuplicateGraphs([kb('a'), kb('b')])).toEqual([]);
  });
});

describe('a name that IS the prefix belongs to its own cluster', () => {
  it('groups "website" with "website-status"', () => {
    // Found by seeding real names: only the hyphenated one had a separator, so the bare name
    // never counted toward the prefix it exactly matches — leaving a design graph sitting apart
    // from the status graph that observes it, which is the pairing this feature exists to show.
    const sets = groupIntoSets([kb('website'), kb('website-status')]);
    expect(sets.map((s) => s.title)).toEqual(['Website']);
    expect(sets[0].rowCount).toBe(2);
  });

  it('still needs a second member — a bare name alone does not make a set', () => {
    expect(groupIntoSets([kb('website')]).map((s) => s.title)).toEqual(['Ungrouped']);
  });

  it('counts the bare name toward the threshold, not past it', () => {
    expect(suggestSetsFromNames([kb('trip'), kb('trip-a')]).map((d) => d.title)).toEqual(['Trip']);
  });
});

describe('folderSetOf — a graph\'s own folder is not a set, a folder that CONTAINS graphs is', () => {
  it('groups by the folder the user made, not the one the convention made', () => {
    // The workspace writes kbs/{name}/{name}.ttl, so the deepest folder is usually the graph's
    // own name repeated. Grouping on that gives every graph a set of one — a flat list wearing
    // headings.
    expect(folderSetOf('kbs/acme', 'acme')).toBeNull();
    expect(folderSetOf('kbs/clients/acme', 'acme')).toBe('clients');
  });

  it('groups a loose file by the folder it sits in', () => {
    expect(folderSetOf('research', 'notes')).toBe('research');
    expect(folderSetOf('', 'notes')).toBeNull();
    expect(folderSetOf(undefined, 'notes')).toBeNull();
  });

  it('never treats the shared kbs/ wrapper as a set — it separates nothing', () => {
    expect(folderSetOf('kbs', 'anything')).toBeNull();
  });

  it('takes the DEEPEST folder, which is the most specific thing the user expressed', () => {
    expect(folderSetOf('kbs/work/clients/acme', 'acme')).toBe('clients');
  });

  it('matches the graph\'s own folder case-insensitively', () => {
    expect(folderSetOf('kbs/Acme', 'acme')).toBeNull();
  });
});

describe('folder membership in the set list', () => {
  const folder = (name: string, folderPath: string): KbEntry =>
    ({ ...kb(name), folderPath }) as KbEntry;

  it('groups synced graphs by their sub-directory', () => {
    const sets = groupIntoSets([
      folder('acme', 'kbs/clients/acme'),
      folder('globex', 'kbs/clients/globex'),
      folder('household', 'kbs/personal/household'),
    ]);
    const titles = sets.map((s) => s.title).sort();
    expect(titles).toEqual(['clients', 'personal']);
    expect(sets.every((s) => s.basis === 'folder')).toBe(true);
  });

  it('never invents a purpose for a folder either — a folder name is not a meaning', () => {
    for (const s of groupIntoSets([folder('acme', 'kbs/clients/acme'), folder('globex', 'kbs/clients/globex')])) {
      expect(s.purpose).toBe('');
    }
  });

  it('lets a folder beat a name-prefix coincidence, because the user made the folder', () => {
    // "trip-a" and "trip-b" would cluster on spelling; the user filed them apart on purpose.
    const sets = groupIntoSets([
      folder('trip-a', 'kbs/2024/trip-a'),
      folder('trip-b', 'kbs/2025/trip-b'),
    ]);
    expect(sets.map((s) => s.title).sort()).toEqual(['2024', '2025']);
    expect(sets.every((s) => s.basis === 'folder')).toBe(true);
  });

  it('still lets a DEFINED set beat the folder — the user\'s explicit word wins', () => {
    const defs: GraphSetDefinition[] = [{ id: 'work', title: 'Work', prefix: 'acme', purpose: 'Paid engagements' }];
    const sets = bucketIntoSets(
      groupGraphsWithArchives([folder('acme', 'kbs/clients/acme')]),
      { definitions: defs },
    );
    expect(sets[0].title).toBe('Work');
    expect(sets[0].basis).toBe('defined');
    expect(sets[0].purpose).toBe('Paid engagements');
  });

  it('can be turned off, falling back to the name-prefix guess', () => {
    const sets = bucketIntoSets(
      groupGraphsWithArchives([folder('trip-a', 'kbs/2024/trip-a'), folder('trip-b', 'kbs/2025/trip-b')]),
      { groupByFolder: false },
      [folder('trip-a', 'kbs/2024/trip-a'), folder('trip-b', 'kbs/2025/trip-b')],
    );
    expect(sets[0].title).toBe('Trip');
    expect(sets[0].basis).toBe('derived');
  });
});
