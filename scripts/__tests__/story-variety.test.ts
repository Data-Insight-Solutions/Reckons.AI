import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { checkRows, featureSet, rowsFromQuads } from '../offline/story-variety';

/**
 * F300.6 (kb:story-variety): the check's own rules, pinned on synthetic graphs.
 * The reader is the repository's own one (src/lib/rdf/story-steps.ts); these fixtures only
 * exercise WHICH MIX counts as the same and what fails.
 */
const HEAD = `
@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix story: <urn:reckons:story/> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix kb:    <urn:kbase:concept/> .
`;
const story = (id: string, label: string) => `
story:${id} rdf:type story:Story ; rdfs:label "${label}" ; story:description "a walk" .
`;
const step = (sid: string, id: string, extra = '') => `
story:${sid} rdf:type story:Step ; story:partOf story:${id} ; story:order "1"^^xsd:integer ; story:title "one" ; story:content "text" ${extra} .
`;
const parse = (ttl: string) => new Parser().parse(ttl);
const rows = (ttl: string) => rowsFromQuads([{ file: 'fixture.ttl', quads: parse(ttl) }]);

describe('story-variety rules', () => {
  it('fails when two stories use the same feature set', () => {
    const a = HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs"');
    const b = HEAD + story('B', 'Beta') + step('B-1', 'B', '; story:filter "hubs"');
    const rs = rows(a + b);
    expect(rs).toHaveLength(2);
    // Same kinds (filter) and same filter name: one set, two stories.
    expect(featureSet(rs[0].features)).toBe(featureSet(rs[1].features));
    const failures = checkRows(rs);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/shares its feature set/);
  });

  it('fails when a story uses no story:filter', () => {
    const rs = rows(HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:media "/m/webp"'));
    const failures = checkRows(rs);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no story:filter/);
  });

  it('passes a pair that each carry a filter and differ in their mix', () => {
    const a = HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs" ; story:media "/m/a.webp"');
    const b = HEAD + story('B', 'Beta') + step('B-1', 'B', '; story:filter "islands" ; story:layout "focus"');
    const rs = rows(a + b);
    expect(checkRows(rs)).toEqual([]);
  });

  it('counts the same story in two files once, and the same kinds under different filter names as two sets', () => {
    // Dedupe: the curated file and its generated copy carry one story, not two.
    const dup = rowsFromQuads([
      { file: 'curated.ttl', quads: parse(HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs"')) },
      { file: 'copy.ttl', quads: parse(HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs"')) },
    ]);
    expect(dup).toHaveLength(1);
    // Kinds plus filter names make the set: hubs vs islands are two walks of the same kind.
    const rs = rows(
      HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs"')
      + story('B', 'Beta') + step('B-1', 'B', '; story:filter "islands"')
    );
    expect(checkRows(rs)).toEqual([]);
  });

  it('counts a leap when the highlighted entity carries urn:reckons:leap in the same file', () => {
    const plain = rows(HEAD + story('A', 'Alpha') + step('A-1', 'A', '; story:filter "hubs" ; story:highlight kb:plain'))[0].features;
    const leaping = rows(HEAD + story('A', 'Alpha')
      + step('A-1', 'A', '; story:filter "hubs" ; story:highlight kb:door')
      + 'kb:door <urn:reckons:leap> "a1b2c3d4-e5f6-4a01-b001-000000000001" ; <urn:reckons:leap/label> "on to another place" .');
    const f = leaping[0].features;
    expect(plain.leaps).toBe(0);
    expect(f.leaps).toBe(1);
    expect(f.kinds).toContain('leap');
  });
});
