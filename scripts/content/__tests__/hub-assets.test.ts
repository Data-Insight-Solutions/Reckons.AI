import { describe, expect, it } from 'vitest';
import type { Statement } from '../../../src/lib/rdf/types';
import { parseRequest } from '../../../src/lib/generation/protocol';
import { planHubAssets } from '../hub-assets';

const U = (n: string) => `urn:t:${n}`;
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
let n = 0;
const st = (s: string, p: string, o: string, kind: 'iri' | 'literal' = 'iri', status: Statement['status'] = 'confirmed'): Statement => ({
  id: `s${n++}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
  o: kind === 'iri' ? { kind: 'iri', value: o } : { kind: 'literal', value: o },
  g: { kind: 'iri', value: 'urn:t' }, sourceId: 't', confidence: 1, status, createdAt: 0, updatedAt: 0,
}) as unknown as Statement;

/** A small synthetic space: one well-connected topic, a person, and several leaves around them. */
function space(extra: Statement[] = []): Statement[] {
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f'];
  return [
    st(U('hub'), LABEL, 'Harbor Project', 'literal'),
    st(U('hub'), 'urn:kbase:predicate/status', 'in progress', 'literal'),
    st(U('hub'), 'urn:kbase:predicate/budget', '40 units', 'literal'),
    st(U('pat'), LABEL, 'Pat Example', 'literal'),
    st(U('pat'), TYPE, 'urn:kbase:type/Person'),
    st(U('pat'), 'urn:kbase:predicate/name', 'Pat Example', 'literal'),
    st(U('pat'), 'urn:kbase:predicate/role', 'harbor master', 'literal'),
    ...leaves.flatMap((l) => [
      st(U(l), LABEL, `Leaf ${l}`, 'literal'),
      st(U('hub'), `urn:kbase:predicate/links-${l}`, U(l)),
      st(U('pat'), `urn:kbase:predicate/knows-${l}`, U(l)),
    ]),
    ...extra,
  ];
}

describe('planHubAssets', () => {
  it('plans an image then a splat for each hub, grounded only in confirmed facts', () => {
    const plan = planHubAssets(space(), { spaceId: 'demo' });
    const item = plan.items.find((i) => i.hub === U('hub'))!;
    expect(item.image.prompt).toContain('Harbor Project');
    expect(item.image.prompt).toContain('status: in progress');
    expect(item.image.prompt).toContain('budget: 40 units');
    expect(item.grounding.length).toBeGreaterThan(0);
  });

  it('ignores facts that are not confirmed', () => {
    const plan = planHubAssets(space([st(U('hub'), 'urn:kbase:predicate/secret', 'invented detail', 'literal', 'pending')]), { spaceId: 'demo' });
    expect(plan.items.find((i) => i.hub === U('hub'))!.image.prompt).not.toContain('invented detail');
  });

  it('gives a person a neutral portrait that names no one', () => {
    const plan = planHubAssets(space(), { spaceId: 'demo' });
    const item = plan.items.find((i) => i.hub === U('pat'))!;
    expect(item.person).toBe(true);
    expect(item.image.prompt).toMatch(/not a likeness of any real individual/);
    expect(item.image.prompt).not.toContain('Pat');
    expect(item.image.prompt).not.toContain('Example');
    expect(item.image.prompt).toContain('harbor master');
  });

  it('chains the splat to wait on the image, and both are valid requests', () => {
    const item = planHubAssets(space(), { spaceId: 'demo' }).items[0];
    expect(item.image.stage).toBe('image');
    expect(item.image.parentId).toBeUndefined();
    expect(item.splat.stage).toBe('splat');
    expect(item.splat.parentId).toBe(item.image.id);
    expect(item.splat.forEntity).toBe(item.hub);
    expect(() => parseRequest(item.image)).not.toThrow();
    expect(parseRequest(item.splat).parentId).toBe(item.image.id);
  });

  it('refuses a hub that has no confirmed fact beyond its label', () => {
    // Linked only to unlabeled entities and holding no confirmed literal: nothing to ground a prompt in.
    const bare = [
      st(U('x'), LABEL, 'Bare Topic', 'literal'),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((l) => st(U('x'), `urn:kbase:predicate/rel-${l}`, U(`t-${l}`))),
      ...['a', 'b'].map((l) => st(U('x'), 'urn:kbase:predicate/note', `unconfirmed ${l}`, 'literal', 'pending')),
    ];
    const plan = planHubAssets(bare, { spaceId: 'demo' });
    expect(plan.items).toHaveLength(0);
    expect(plan.refused).toEqual([{ hub: U('x'), reason: expect.stringMatching(/no confirmed fact/) }]);
  });

  it('skips a hub that already has a picture and respects the limit', () => {
    const withPhoto = space([st(U('hub'), 'urn:kbase:predicate/photo', '/x.webp', 'literal')]);
    const plan = planHubAssets(withPhoto, { spaceId: 'demo' });
    expect(plan.items.find((i) => i.hub === U('hub'))).toBeUndefined();
    expect(plan.skippedHavingAssets).toBe(1);
    expect(planHubAssets(space(), { spaceId: 'demo', limit: 1 }).items).toHaveLength(1);
  });

  it('is deterministic: the same space gives the same ids and seeds', () => {
    expect(planHubAssets(space(), { spaceId: 'demo' })).toEqual(planHubAssets(space(), { spaceId: 'demo' }));
    expect(planHubAssets(space(), { spaceId: 'other' }).items[0].image.id).not.toBe(planHubAssets(space(), { spaceId: 'demo' }).items[0].image.id);
  });
});
