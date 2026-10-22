/**
 * "Your room" showed no room for a person who had opened the example before the room was rebuilt:
 * the copy saved in their browser still named splat.ply, a file deleted when the room became a
 * smaller splat.spz, so the fetch answered 404 (observed 2026-10-21 on a copy of real browser data).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundSplatFrom, splatMapFrom, splatOriginOf, currentSplatUrl, BACKGROUND_SPLAT_PREDICATE, SPLAT_PREDICATE, SPLAT_ORIGIN_PREDICATE, SPACE_SUBJECT } from '../splat';

const OLD = '/generated/synthetic-room/splat.ply';
const NEW = '/generated/synthetic-room/splat.spz';
type Row = Parameters<typeof backgroundSplatFrom>[0][number];
const st = (s: string, p: string, o: string): Row => ({ id: s + p, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: o }, status: 'confirmed' } as unknown as Row);

describe('a saved copy that names a replaced bundled splat', () => {
  it('reads the old room address as the current file', () => {
    expect(currentSplatUrl(OLD)).toBe(NEW);
    expect(backgroundSplatFrom([st(SPACE_SUBJECT, BACKGROUND_SPLAT_PREDICATE, OLD)])).toBe(NEW);
    expect(splatMapFrom([st('urn:x:room', SPLAT_PREDICATE, OLD)]).get('urn:x:room')).toBe(NEW);
  });
  it('still finds the origin of an item whose saved address is the old one', () => {
    const rows = [st('urn:x:room', SPLAT_PREDICATE, OLD), st('urn:x:room', SPLAT_ORIGIN_PREDICATE, 'synthetic')];
    const url = [...splatMapFrom(rows).values()][0];
    expect(splatOriginOf(rows, url)).toBe('synthetic');
  });
  it('leaves other addresses alone', () => {
    expect(currentSplatUrl('/generated/carved-turtle/splat.ply')).toBe('/generated/carved-turtle/splat.ply');
  });
});

describe('every bundled splat that a starter example names exists', () => {
  const root = join(__dirname, '../../../..');
  for (const f of readdirSync(join(root, 'static')).filter((n) => /^starter-.*\.ttl$/.test(n))) {
    const urls = [...readFileSync(join(root, 'static', f), 'utf8').matchAll(/"(\/generated\/[^"]+\.(?:ply|spz|sog))"/g)].map((m) => m[1]);
    for (const u of new Set(urls)) it(`${f}: ${u}`, () => expect(existsSync(join(root, 'static', currentSplatUrl(u)))).toBe(true));
  }
});
