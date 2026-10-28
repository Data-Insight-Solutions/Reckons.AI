import { describe, it, expect } from 'vitest';
import { offerApplied, parsePageOffer, parseSettingOffer } from '../story-offers';
import { extractStories } from '../story';
import { isMetaPredicate, type Statement, type Term } from '../types';

describe('what a story step may offer (F261)', () => {
  it('offers only allowlisted settings and values', () => {
    expect(parseSettingOffer('tripleCheckEnabled=true')).toMatchObject({ key: 'tripleCheckEnabled', value: true });
    expect(parseSettingOffer('tripleCheckWebEnabled=false')).toMatchObject({ value: false });
    // A story can never turn the internet on, pick a backend or point anywhere.
    for (const raw of ['tripleCheckWebEnabled=true', 'preferredBackend=claude', 'ollamaBaseUrl=http://evil.test', 'claudeApiKey=x', 'tripleCheckEnabled=yes', '']) {
      expect(parseSettingOffer(raw), raw).toBeNull();
    }
  });
  it('opens only pages inside this app', () => {
    expect(parsePageOffer('/review?group=source')).toEqual({ kind: 'page', path: '/review?group=source', label: 'Open Review' });
    for (const raw of ['//evil.test', 'https://evil.test', 'javascript:alert(1)', '/\\evil.test', '/unknown-page', 'review']) {
      expect(parsePageOffer(raw), raw).toBeNull();
    }
  });
  it('knows an unset setting by its default', () => {
    const on = parseSettingOffer('tripleCheckEnabled=true')!, webOff = parseSettingOffer('tripleCheckWebEnabled=false')!;
    expect(offerApplied(on, {})).toBe(false);
    expect(offerApplied(on, { tripleCheckEnabled: true })).toBe(true);
    expect(offerApplied(webOff, {})).toBe(false); // unset means the web half is ON
    expect(offerApplied(webOff, { tripleCheckWebEnabled: false })).toBe(true);
  });
  it('a step carries its offers; anything off the list is dropped; offers are not drawn', () => {
    const iri = (value: string) => ({ kind: 'iri' as const, value }), lit = (value: string): Term => ({ kind: 'literal', value });
    const S = 'urn:reckons:story/';
    const rows: [string, string, Term][] = [
      ['urn:t', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', iri(`${S}Story`)],
      ['urn:t/1', `${S}partOf`, iri('urn:t')], ['urn:t/1', `${S}order`, lit('1')], ['urn:t/1', `${S}title`, lit('One')],
      ['urn:t/1', `${S}offerSetting`, lit('tripleCheckEnabled=true')], ['urn:t/1', `${S}offerSetting`, lit('preferredBackend=claude')],
      ['urn:t/1', `${S}openPage`, lit('/review?group=source')],
      ['urn:t/2', `${S}partOf`, iri('urn:t')], ['urn:t/2', `${S}order`, lit('2')], ['urn:t/2', `${S}title`, lit('Two')],
    ];
    const stmts = rows.map(([s, p, o], i): Statement => ({ id: `s${i}`, s: iri(s), p: { kind: 'iri', value: p }, o, g: iri('urn:g'), sourceId: 'x', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1 }));
    const [story] = extractStories(stmts);
    expect(story.steps[0].offers?.map((o) => o.label)).toEqual(['Turn on Triple Check for this space', 'Open Review']);
    expect(story.steps[1].offers).toEqual([]);
    expect(isMetaPredicate(`${S}offerSetting`) && isMetaPredicate(`${S}openPage`)).toBe(true);
  });
});
