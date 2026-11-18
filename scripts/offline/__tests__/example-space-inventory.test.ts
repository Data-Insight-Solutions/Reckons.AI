import { describe, it, expect } from 'vitest';
import { gapsOf, inventorySpace, isImageFile, type Triple } from '../lib/example-space-inventory';

const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const iri = (s: string, p: string, o: string): Triple => ({ s, p, o, oKind: 'iri' });
const lit = (s: string, p: string, o: string): Triple => ({ s, p, o, oKind: 'literal' });
const e = (n: string) => `urn:t:${n}`;
const link = 'urn:t:links';

/** A small made-up collection: one hub (alice) linked to five others, bob typed Person with a picture. */
function small(): Triple[] {
  const t: Triple[] = [
    iri(e('alice'), T, 'urn:kbase:type/Person'),
    iri(e('bob'), T, 'urn:kbase:type/Person'),
    lit(e('bob'), 'urn:kbase:predicate/photo', '/generated/pic/image.webp'),
    iri(e('widget'), T, 'urn:kbase:type/Concept'),
    iri(e('story1'), T, 'urn:reckons:story/Story'),
    iri(e('step1'), T, 'urn:reckons:story/Step'),
    iri(e('src1'), T, 'urn:kbase:meta/Source'),
    lit(e('src1'), 'urn:kbase:meta/trustLevel', 'review'),
  ];
  for (const n of ['bob', 'widget', 'c', 'd', 'e']) t.push(iri(e('alice'), link, e(n)));
  for (const n of ['c', 'd', 'e']) t.push(lit(e(n), 'http://www.w3.org/2000/01/rdf-schema#label', n));
  return t;
}

describe('inventorySpace', () => {
  const inv = inventorySpace(small(), { hasReceipt: (p) => p.startsWith('/generated/pic/') });

  it('separates typed from untyped entities and ignores story and source scaffolding', () => {
    expect(inv.entities).toBe(6); // alice bob widget c d e
    expect(inv.typed).toBe(3);
    expect(inv.untyped).toBe(3);
    expect(inv.typedPercent).toBe(50);
    expect(inv.builtInUsed).toEqual(['urn:kbase:type/Concept', 'urn:kbase:type/Person']);
  });

  it('lists people without a picture', () => {
    expect(inv.people).toBe(2);
    expect(inv.peopleWithoutImage).toEqual([e('alice')]);
  });

  it('finds hubs by the app rule and which lack an asset', () => {
    expect(inv.hubs).toBe(1);
    expect(inv.hubsWithoutAsset).toEqual([e('alice')]);
    expect(inv.hubsWithoutSplat).toEqual([e('alice')]);
  });

  it('counts receipted asset references, story steps and source review', () => {
    expect(inv.assets).toEqual({ references: 1, receipted: 1, credited: 0, unrecorded: 0 });
    expect(inv.story).toEqual({ stories: 1, steps: 1 });
    expect(inv.sources).toEqual({ total: 1, trusted: 0, review: 1, unmarked: 0 });
  });

  it('a hub with a splat is not reported as lacking an asset', () => {
    const t = [...small(), lit(e('alice'), 'urn:kbase:predicate/splat', '/x/y.ply')];
    expect(inventorySpace(t).hubsWithoutAsset).toEqual([]);
  });

  it('names the gaps in one list and reports none for a complete collection', () => {
    expect(gapsOf(inv).length).toBeGreaterThanOrEqual(4);
    expect(gapsOf({ ...inv, untyped: 0, peopleWithoutImage: [], hubsWithoutAsset: [], story: { stories: 1, steps: 1 }, sources: { total: 1, trusted: 1, review: 0, unmarked: 0 }, assets: { references: 0, receipted: 0, credited: 0, unrecorded: 0 } })).toEqual([]);
  });

  it('treats an emoji as no picture', () => {
    expect(isImageFile('🐢')).toBe(false);
    expect(isImageFile('/a/b.png')).toBe(true);
  });
});
