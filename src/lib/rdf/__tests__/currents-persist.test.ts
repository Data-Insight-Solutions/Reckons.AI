import { describe, it, expect } from 'vitest';
import { diffCurrentsSettings } from '../currents-persist';
import { currentsSettingsToStatements, type CurrentsSettings } from '../currents';
import type { Statement } from '../types';

const BASE: CurrentsSettings = {
  allowedTypes: ['urn:kbase:type/Concept'],
  location: 'Colorado, US',
  currents: [
    { slug: 'hn', sourceUrl: 'https://hnrss.org/frontpage', kind: 'rss', label: 'Hacker News', cadenceMinutes: 60, enabled: true }
  ]
};

describe('diffCurrentsSettings', () => {
  it('an empty graph adds every statement and rejects/revives nothing', () => {
    const diff = diffCurrentsSettings([], BASE);
    expect(diff.toReject).toEqual([]);
    expect(diff.toRevive).toEqual([]);
    expect(diff.toAdd.map((s) => s.id).sort()).toEqual(
      currentsSettingsToStatements(BASE).map((s) => s.id).sort()
    );
  });

  it('writing the same settings twice is a no-op diff', () => {
    const existing = currentsSettingsToStatements(BASE).map((s) => ({ ...s, status: 'confirmed' as const }));
    const diff = diffCurrentsSettings(existing, BASE);
    expect(diff.toReject).toEqual([]);
    expect(diff.toRevive).toEqual([]);
    expect(diff.toAdd).toEqual([]);
  });

  it('removing a current rejects its statements and leaves the rest alone', () => {
    const existing = currentsSettingsToStatements(BASE).map((s) => ({ ...s, status: 'confirmed' as const }));
    const next: CurrentsSettings = { ...BASE, currents: [] };
    const diff = diffCurrentsSettings(existing, next);

    const removedIds = existing.filter((s) => s.s.value.startsWith('urn:reckons:currents/hn')).map((s) => s.id);
    expect(diff.toReject.sort()).toEqual(removedIds.sort());
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRevive).toEqual([]);
  });

  it('changing a value produces one add + one reject (different deterministic ids)', () => {
    const existing = currentsSettingsToStatements(BASE).map((s) => ({ ...s, status: 'confirmed' as const }));
    const next: CurrentsSettings = {
      ...BASE,
      currents: [{ ...BASE.currents[0], cadenceMinutes: 120 }]
    };
    const diff = diffCurrentsSettings(existing, next);

    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0].o.value).toBe('120');
    expect(diff.toReject).toHaveLength(1);
    const rejected = existing.find((s) => s.id === diff.toReject[0]);
    expect(rejected?.o.value).toBe('60');
  });

  it('re-adding an identical entry that was previously rejected revives it instead of duplicating', () => {
    const original = currentsSettingsToStatements(BASE).map((s) => ({ ...s, status: 'rejected' as const }));
    const diff = diffCurrentsSettings(original, BASE);

    expect(diff.toRevive.sort()).toEqual(currentsSettingsToStatements(BASE).map((s) => s.id).sort());
    expect(diff.toAdd).toEqual([]);
    expect(diff.toReject).toEqual([]);
  });

  it('ignores unrelated statements outside the currents/* namespace', () => {
    const unrelated: Statement = {
      id: 'unrelated-1',
      s: { kind: 'iri', value: 'urn:kbase:concept/foo' },
      p: { kind: 'iri', value: 'urn:kbase:predicate/bar' },
      o: { kind: 'literal', value: 'baz', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
      g: { kind: 'iri', value: 'urn:kbase:source/test' },
      sourceId: 'test',
      confidence: 1,
      status: 'confirmed',
      createdAt: 1,
      updatedAt: 1
    };
    const diff = diffCurrentsSettings([unrelated], BASE);
    expect(diff.toAdd.map((s) => s.id).sort()).toEqual(
      currentsSettingsToStatements(BASE).map((s) => s.id).sort()
    );
    expect(diff.toReject).toEqual([]);
  });
});
