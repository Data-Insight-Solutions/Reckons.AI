import { describe, expect, it } from 'vitest';
import { assess, dateOf, readEntities, type Entity } from '../offline/human-recheck';

/** F34.6 (Matt, 2026-11-25): "One human validation in the past, does not mean a feature is validated now." */
const e = (over: Partial<Entity>): Entity => ({ iri: 'urn:kbase:concept/x', checked: [], asked: [], files: [], ...over });
const changed = (m: Record<string, string>) => (f: string) => m[f] ?? null;

describe('human recheck', () => {
  it('reads the leading date of a dated literal, and nothing else', () => {
    expect(dateOf('2026-11-25: listened in Firefox')).toBe('2026-11-25');
    expect(dateOf('listened 2026-11-25')).toBeNull();
  });

  it('a recheck asked for and not yet done is OPEN', () => {
    expect(assess(e({ asked: ['2026-11-25: listen after a reload'] }), changed({}))?.state).toBe('OPEN');
  });

  it('a check made after the request closes it, and is CURRENT while its files stay unchanged', () => {
    const v = assess(e({ asked: ['2026-11-25: listen'], checked: ['2026-11-26: Matt listened'], files: ['a.ts'] }), changed({ 'a.ts': '2026-11-20' }));
    expect(v?.state).toBe('CURRENT');
  });

  it('a check goes STALE when a linked file changes after it, naming the newest change', () => {
    const v = assess(e({ checked: ['2026-11-01: Matt looked'], files: ['a.ts', 'b.ts'] }), changed({ 'a.ts': '2026-11-10', 'b.ts': '2026-11-20' }));
    expect(v).toMatchObject({ state: 'STALE', why: 'checked 2026-11-01; b.ts changed 2026-11-20' });
  });

  it('a request newer than the last check reopens it, and an undated request never counts as answered', () => {
    expect(assess(e({ asked: ['2026-11-25: again'], checked: ['2026-11-01: once'] }), changed({}))?.state).toBe('OPEN');
    expect(assess(e({ asked: ['no date given'], checked: ['2026-11-01: once'] }), changed({}))?.state).toBe('OPEN');
  });

  it('says nothing about an entity nobody asked about or checked', () => {
    expect(assess(e({ files: ['a.ts'] }), changed({ 'a.ts': '2026-11-20' }))).toBeNull();
  });

  it('collects the records, requests and files of each entity from quads', () => {
    const q = (s: string, p: string, o: string) => ({ subject: { value: s }, predicate: { value: 'urn:kbase:predicate/' + p }, object: { value: o } });
    const [x] = readEntities([q('urn:x', 'human-checked', '2026-11-01: ok'), q('urn:x', 'tested-by', 't.ts'), q('urn:y', 'touches-file', 'y.ts')]);
    expect(x).toMatchObject({ iri: 'urn:x', checked: ['2026-11-01: ok'], files: ['t.ts'] });
  });
});
