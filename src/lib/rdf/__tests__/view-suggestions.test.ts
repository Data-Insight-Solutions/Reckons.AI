/**
 * Context-aware view suggestions (F85).
 *
 * A suggestion must be EARNED BY THE DATA. An unearned one is not merely useless — it
 * trains the user to ignore the suggester, and then the one good suggestion goes unread
 * with all the rest. So most of these tests assert SILENCE.
 */
import { describe, it, expect } from 'vitest';
import {
  suggestForView,
  bestSuggestion,
  temporalSpread,
  typeSpread,
  hubSkew,
  type ViewContext,
} from '../view-suggestions';
import type { Statement } from '../types';
import { iri, lit } from '../types';

const KB = 'urn:kbase:concept/';
const KP = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';

let n = 0;
const st = (
  subject: string,
  predicate: string,
  object: { iri: string } | { lit: string; dt?: string },
): Statement => ({
  id: `s${++n}`,
  s: iri(`${KB}${subject}`),
  p: iri(predicate.startsWith('http') ? predicate : `${KP}${predicate}`),
  o: 'iri' in object ? iri(`${KB}${object.iri}`) : lit(object.lit, object.dt),
  g: iri('urn:kbase:source/test'),
  sourceId: 'src',
  confidence: 1,
  status: 'confirmed',
  createdAt: 0,
  updatedAt: 0,
});

const ctx = (over: Partial<ViewContext> = {}): ViewContext => ({
  visible: [],
  nodeCount: 10,
  layout: 'force',
  ...over,
});

describe('temporalSpread — does this view actually contain time?', () => {
  it('finds properly typed dates', () => {
    const spread = temporalSpread([
      st('meeting-1', 'starts-at', { lit: '2026-01-10', dt: XSD_DATE }),
      st('meeting-2', 'starts-at', { lit: '2026-03-12', dt: XSD_DATE }),
    ]);
    expect(spread!.count).toBe(2);
    expect(Math.round(spread!.spanDays)).toBe(61);
  });

  it('also finds UNTYPED ISO dates — real graphs are full of them', () => {
    // Refusing to see untyped dates would make the feature useless exactly where it is
    // most needed: on a graph the user built by hand.
    const spread = temporalSpread([st('e', 'on', { lit: '2026-05-01' })]);
    expect(spread!.count).toBe(1);
  });

  it('is not fooled by numbers or ordinary text', () => {
    expect(
      temporalSpread([
        st('a', 'has-count', { lit: '2026' }),
        st('b', 'description', { lit: 'sometime next year' }),
      ]),
    ).toBeNull();
  });

  it('returns null when there is no time at all', () => {
    expect(temporalSpread([st('a', 'depends-on', { iri: 'b' })])).toBeNull();
  });
});

describe('the motivating case: calendar/event types selected, facts carry dates', () => {
  const events = [
    st('standup', RDF_TYPE, { iri: 'Event' }),
    st('standup', 'starts-at', { lit: '2026-01-05', dt: XSD_DATE }),
    st('review', RDF_TYPE, { iri: 'Event' }),
    st('review', 'starts-at', { lit: '2026-02-20', dt: XSD_DATE }),
    st('retro', RDF_TYPE, { iri: 'Event' }),
    st('retro', 'starts-at', { lit: '2026-04-30', dt: XSD_DATE }),
  ];

  it('offers a timeline, and SHOWS ITS EVIDENCE', () => {
    const best = bestSuggestion(
      ctx({ visible: events, selectedTypes: new Set([`${KB}Event`]) }),
    );

    expect(best).not.toBeNull();
    expect(best!.adjust.layout).toBe('timeline');
    // The evidence is shown, never implied. "Trust me" is not a reason.
    expect(best!.evidence).toMatch(/3 of the facts/);
    expect(best!.evidence).toMatch(/months/);
    expect(best!.evidence).toMatch(/types you have selected/);
  });

  it('is MORE confident when the user has explicitly selected those types', () => {
    const withTypes = suggestForView(ctx({ visible: events, selectedTypes: new Set([`${KB}Event`]) }));
    const without = suggestForView(ctx({ visible: events }));

    const t1 = withTypes.find((s) => s.id === 'layout-timeline')!;
    const t2 = without.find((s) => s.id === 'layout-timeline')!;
    expect(t1.weight).toBeGreaterThan(t2.weight);
  });
});

describe('SILENCE is the correct and common answer', () => {
  it('says nothing about time when the graph has no time in it', () => {
    const flat = [
      st('a', 'depends-on', { iri: 'b' }),
      st('b', 'depends-on', { iri: 'c' }),
    ];
    expect(suggestForView(ctx({ visible: flat })).some((s) => s.id === 'layout-timeline')).toBe(false);
  });

  it('says nothing about time when the dates all fall on one day', () => {
    // Three facts, one instant. A timeline of a single point is not a timeline.
    const sameDay = [
      st('a', 'on', { lit: '2026-01-05', dt: XSD_DATE }),
      st('b', 'on', { lit: '2026-01-05', dt: XSD_DATE }),
      st('c', 'on', { lit: '2026-01-05', dt: XSD_DATE }),
    ];
    expect(suggestForView(ctx({ visible: sameDay })).some((s) => s.id === 'layout-timeline')).toBe(false);
  });

  it('never suggests the layout the user is already using', () => {
    const events = [
      st('a', 'on', { lit: '2026-01-01', dt: XSD_DATE }),
      st('b', 'on', { lit: '2026-02-01', dt: XSD_DATE }),
      st('c', 'on', { lit: '2026-03-01', dt: XSD_DATE }),
    ];
    const suggestions = suggestForView(ctx({ visible: events, layout: 'timeline' }));
    expect(suggestions.some((s) => s.adjust.layout === 'timeline')).toBe(false);
  });

  it('says nothing at all about an empty view', () => {
    expect(suggestForView(ctx({ visible: [] }))).toEqual([]);
    expect(bestSuggestion(ctx({ visible: [] }))).toBeNull();
  });

  it('does not offer hubs for a small, evenly-connected graph', () => {
    const even = [
      st('a', 'links', { iri: 'b' }),
      st('c', 'links', { iri: 'd' }),
    ];
    expect(suggestForView(ctx({ visible: even, nodeCount: 4 })).some((s) => s.id === 'filter-hubs')).toBe(
      false,
    );
  });
});

describe('crowding — the roadmap-graph problem', () => {
  it('offers the hubs when the view is crowded AND hub-shaped', () => {
    // 200 leaves all pointing at one hub: unreadable, and obviously hub-shaped.
    const hairball = Array.from({ length: 200 }, (_, i) => st(`leaf${i}`, 'depends-on', { iri: 'core' }));

    const best = suggestForView(ctx({ visible: hairball, nodeCount: 201 })).find(
      (s) => s.id === 'filter-hubs',
    );

    expect(best).toBeDefined();
    expect(best!.adjust.filters).toEqual(['hubs']);
    expect(best!.evidence).toMatch(/201 nodes/);
  });

  it('stays quiet when the view is crowded but evenly connected — hubs would not help', () => {
    // 200 disconnected pairs: crowded, but there is no hub to retreat to.
    const pairs = Array.from({ length: 200 }, (_, i) => st(`a${i}`, 'links', { iri: `b${i}` }));
    expect(
      suggestForView(ctx({ visible: pairs, nodeCount: 400 })).some((s) => s.id === 'filter-hubs'),
    ).toBe(false);
  });
});

describe('other rules', () => {
  it('offers grouping by type when several kinds of thing are mixed', () => {
    const mixed = [
      st('a', RDF_TYPE, { iri: 'Person' }),
      st('b', RDF_TYPE, { iri: 'Project' }),
      st('c', RDF_TYPE, { iri: 'Decision' }),
    ];
    expect(typeSpread(mixed).size).toBe(3);
    expect(suggestForView(ctx({ visible: mixed })).some((s) => s.id === 'layout-type')).toBe(true);
  });

  it('offers grouping by source when facts come from several documents', () => {
    const s = suggestForView(ctx({ visible: [st('a', 'x', { iri: 'b' })], sourceCount: 4 }));
    expect(s.some((x) => x.id === 'layout-source')).toBe(true);
  });

  it('bestSuggestion returns only ONE thing, and only if it clears the bar', () => {
    // A menu of five things to try is not help — it is homework.
    const weak = suggestForView(ctx({ visible: [st('a', 'x', { iri: 'b' })], sourceCount: 4 }));
    expect(weak.length).toBeGreaterThan(0);
    expect(bestSuggestion(ctx({ visible: [st('a', 'x', { iri: 'b' })], sourceCount: 4 }), 0.9)).toBeNull();
  });

  it('ranks the strongest suggestion first', () => {
    const events = [
      st('a', RDF_TYPE, { iri: 'Event' }),
      st('a', 'on', { lit: '2026-01-01', dt: XSD_DATE }),
      st('b', RDF_TYPE, { iri: 'Person' }),
      st('b', 'on', { lit: '2026-03-01', dt: XSD_DATE }),
      st('c', RDF_TYPE, { iri: 'Project' }),
      st('c', 'on', { lit: '2026-06-01', dt: XSD_DATE }),
    ];
    const s = suggestForView(ctx({ visible: events, selectedTypes: new Set([`${KB}Event`]) }));
    expect(s[0].id).toBe('layout-timeline'); // time beats type-grouping here
  });
});

describe('hubSkew', () => {
  it('measures how lopsided the connectivity is', () => {
    const hub = Array.from({ length: 10 }, (_, i) => st(`leaf${i}`, 'to', { iri: 'core' }));
    const skew = hubSkew(hub)!;
    expect(skew.topDegree).toBe(10);
    expect(skew.median).toBe(1);
  });

  it('is null on an empty view', () => {
    expect(hubSkew([])).toBeNull();
  });
});
