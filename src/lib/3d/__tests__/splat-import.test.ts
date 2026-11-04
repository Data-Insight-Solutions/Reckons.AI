/**
 * F58.9.7: importing a scan. A file is judged by its bytes and refused with a reason, a good one is
 * stored under its content hash and referenced by a resolvable name (never a data: URI), and the
 * entity written for it says where it came from.
 */
import { describe, it, expect } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { makePly, makeSpz } from './ply-fixture';
import { judgeSplatFile, judgeDecodedSplat, judgeSogHeader, judgeSplatSpzV4Header, splatKindOf, plyCentres, type DecodedSplat } from '../splat-check';
import {
  isSplatUrl, isLocalSplatUrl, splatOrientationFor, splatOriginOf, scanStatements, scanEntityIri, backgroundSplatFrom,
  BACKGROUND_SPLAT_PREDICATE, SPACE_SUBJECT,
} from '../splat';
import { importSplatFile, readSplatFile, localSplatId } from '../../storage/splat-files';
import type { KBaseDB } from '../../storage/db';

const fileOf = (name: string, bytes: Uint8Array) => Object.assign(new NodeBlob([bytes as never]), { name }) as unknown as File;

/** The one table importSplatFile touches. */
function fakeDb() {
  const rows = new Map<string, { id: string; blob: Blob; filename: string }>();
  return { rows, db: { splatFiles: { get: async (id: string) => rows.get(id), put: async (r: { id: string; blob: Blob; filename: string }) => { rows.set(r.id, r); } } } as unknown as KBaseDB };
}

describe('judgeSplatFile', () => {
  it('accepts a good PLY and an SPZ header, by extension', async () => {
    expect((await judgeSplatFile('room.ply', makePly(64))).pass).toBe(true);
    const spz = await judgeSplatFile('room.SPZ', await makeSpz(100));
    expect(spz.pass).toBe(true);
    expect(spz.kind).toBe('spz');
  });

  it('refuses each failure with its reason', async () => {
    expect((await judgeSplatFile('room.obj', makePly(8))).problems[0]).toMatch(/not a \.ply, \.spz or \.sog/);
    expect((await judgeSplatFile('room.ply', new Uint8Array(0))).problems[0]).toMatch(/empty/);
    expect((await judgeSplatFile('room.ply', new TextEncoder().encode('hello'))).problems[0]).toMatch(/no PLY header/);
    expect((await judgeSplatFile('room.ply', makePly(64, { truncate: 40 }))).problems.join()).toMatch(/truncated/);
    expect((await judgeSplatFile('room.ply', makePly(64, { nan: true }))).problems.join()).toMatch(/non-finite/);
    expect((await judgeSplatFile('room.ply', makePly(64, { drop: 'rot_3' }))).problems.join()).toMatch(/missing properties: rot_3/);
    expect((await judgeSplatFile('room.ply', makePly([0, 0, 0, 0, 0, 0]))).problems.join()).toMatch(/degenerate extent/);
    expect((await judgeSplatFile('room.spz', new TextEncoder().encode('not gzip'))).problems[0]).toMatch(/could not read|not an SPZ/);
    expect((await judgeSplatFile('room.spz', await makeSpz(10, { magic: 1 }))).problems[0]).toMatch(/NGSP/);
    expect((await judgeSplatFile('room.spz', await makeSpz(1000, { body: 50 }))).problems[0]).toMatch(/truncated/);
  });

  it('knows the extension and samples centres', async () => {
    expect(splatKindOf('a.PLY')).toBe('ply');
    expect(splatKindOf('a.glb')).toBeNull();
    expect(Array.from(await plyCentres(makePly([1, 2, 3, 4, 5, 6])))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('large files', () => {
  it('judges in chunks and agrees with the in-memory check', async () => {
    const bytes = makePly(5000);
    let reads = 0, biggest = 0;
    const src = { size: bytes.length, read: async (a: number, b: number) => { reads++; biggest = Math.max(biggest, b - a); return bytes.subarray(a, b); } };
    const { judgePlySource, judgeSplatPly } = await import('../splat-check');
    const chunked = await judgePlySource(src);
    expect(chunked).toEqual(judgeSplatPly(bytes));
    expect(reads).toBeGreaterThan(1);
    expect(biggest).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('warns above the size threshold but still imports; refuses above the limit with guidance', async () => {
    const { WARN_SPLAT_BYTES, MAX_SPLAT_BYTES } = await import('../../storage/splat-files');
    const { db } = fakeDb();
    const good = fileOf('big.ply', makePly(64));
    const warnBig = Object.defineProperty(good, 'size', { value: WARN_SPLAT_BYTES + 1 });
    const w = await importSplatFile(warnBig, db);
    expect(w.ok && w.warnings[0]).toMatch(/fewer training steps/);
    const huge = Object.defineProperty(fileOf('huge.ply', makePly(64)), 'size', { value: MAX_SPLAT_BYTES + 1 });
    const r = await importSplatFile(huge, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/limit.*\.sog or \.spz/s);
  });
});

describe('SOG and decoded SPZ/SOG (F58.9.11)', () => {
  const zip = (n: number) => { const b = new Uint8Array(n); b.set([0x50, 0x4b, 3, 4]); return b; };
  const decoded = (over: Partial<DecodedSplat> = {}): DecodedSplat => ({
    count: 100, nonFinite: 0, min: [-2, 0, -2], max: [2, 2.6, 2],
    sample: Array.from({ length: 300 }, (_, i) => [(i % 7) - 3, (i % 3), (i % 5) - 2][i % 3]), ...over,
  });

  it('knows .sog by extension, without regard to case', () => {
    expect(splatKindOf('room.SOG')).toBe('sog');
    expect(isSplatUrl('/generated/x/room.sog')).toBe(true);
    expect(isLocalSplatUrl('asset:splat/0123abcd.sog')).toBe(true);
  });
  it('a SOG that is not a ZIP is refused; one that is passes on its header and SAYS values were not decoded', async () => {
    expect((await judgeSplatFile('room.sog', new TextEncoder().encode('x'.repeat(100)))).problems[0]).toMatch(/not a \.sog file/);
    const ok = await judgeSplatFile('room.sog', zip(100));
    expect(ok.pass).toBe(true);
    expect(ok.kind).toBe('sog');
    expect(ok.notes.join()).toMatch(/not decoded/);
    expect(judgeSogHeader(zip(8), 8).problems[0]).toMatch(/too short/);
  });
  it('accepts SPZ version 4 (raw NGSP, not gzip) by its header and refuses a truncated or wrong-version one', async () => {
    const v4 = (count: number, size: number, version = 4) => {
      const b = new Uint8Array(size);
      const v = new DataView(b.buffer);
      v.setUint32(0, 0x5053474e, true); v.setUint32(4, version, true); v.setUint32(8, count, true);
      return b;
    };
    const ok = await judgeSplatFile('room.spz', v4(1000, 2000));
    expect(ok.pass).toBe(true);
    expect(ok.measured.version).toBe(4);
    expect(judgeSplatSpzV4Header(v4(1000, 100), 100).problems[0]).toMatch(/truncated/);
    expect(judgeSplatSpzV4Header(v4(1000, 2000, 5), 2000).problems[0]).toMatch(/unsupported SPZ version 5/);
    expect(judgeSplatSpzV4Header(v4(0, 2000), 2000).problems[0]).toMatch(/no Gaussians/);
  });
  it('with a decoder, an SPZ/SOG gets a real count and extent', async () => {
    const dec = async () => decoded();
    const sog = await judgeSplatFile('room.sog', zip(100), dec);
    expect(sog.pass).toBe(true);
    expect(sog.measured.count).toBe(100);
    expect(Number(sog.measured.rawExtent)).toBeCloseTo(4);
    expect(sog.notes.join()).toMatch(/decoded/);
    const spz = await judgeSplatFile('room.spz', await makeSpz(100), dec);
    expect(spz.pass).toBe(true);
    expect(spz.measured.extent).toBeDefined();
  });
  it('refuses a decode that disagrees with the header, has NaNs, or has no extent', async () => {
    expect((await judgeSplatFile('room.spz', await makeSpz(100), async () => decoded({ count: 99 }))).problems.join()).toMatch(/header says 100.*99 decoded/);
    expect(judgeDecodedSplat('sog', decoded({ nonFinite: 3 })).problems.join()).toMatch(/3 Gaussian\(s\) with non-finite centres/);
    expect(judgeDecodedSplat('sog', decoded({ min: [0, 0, 0], max: [0, 0, 0] })).problems.join()).toMatch(/degenerate extent/);
    expect(judgeDecodedSplat('spz', decoded({ count: 0 })).problems.join()).toMatch(/no Gaussians/);
  });
  it('a decoder that throws becomes a failed check, not an exception', async () => {
    const r = await judgeSplatFile('room.sog', zip(100), async () => { throw new Error('worker died'); });
    expect(r.pass).toBe(false);
    expect(r.problems[0]).toMatch(/could not read the file: worker died/);
  });
  it('the measured extent of a decoded file ignores far floaters', () => {
    const sample: number[] = [];
    for (let i = 0; i < 3000; i++) sample.push(((i * 37) % 100) / 20 - 2.5, ((i * 11) % 100) / 40, ((i * 53) % 100) / 25 - 2);
    for (let i = 0; i < 5; i++) sample.push(400 + i, 300, 0);
    const r = judgeDecodedSplat('sog', { count: 3005, nonFinite: 0, min: [-2.5, 0, -2], max: [404, 300, 2], sample });
    expect(Number(r.measured.rawExtent)).toBeGreaterThan(400);
    expect(Number(r.measured.extent)).toBeLessThan(7);
  });
});

describe('importSplatFile', () => {
  it('stores a good file under its content hash and returns a resolvable reference', async () => {
    const { db, rows } = fakeDb();
    const res = await importSplatFile(fileOf('my room.ply', makePly(64)), db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toMatch(/^asset:splat\/[0-9a-f]{32}\.ply$/);
    expect(res.url.startsWith('data:')).toBe(false);
    expect(isSplatUrl(res.url)).toBe(true);
    expect(rows.size).toBe(1);
    expect(rows.get(localSplatId(res.url)!)!.filename).toBe('my room.ply');
    const back = await readSplatFile(res.url, db);
    expect(back?.kind).toBe('ply');
    expect(back?.blob.size).toBe(makePly(64).length);
    const again = await importSplatFile(fileOf('copy.ply', makePly(64)), db);
    expect(again.ok && again.alreadyHad).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('stores nothing for a refused file', async () => {
    const { db, rows } = fakeDb();
    const res = await importSplatFile(fileOf('bad.ply', makePly(64, { nan: true })), db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.join()).toMatch(/non-finite/);
    expect(rows.size).toBe(0);
  });

  it('reads nothing for a reference that is not local, or not present', async () => {
    const { db } = fakeDb();
    expect(await readSplatFile('/generated/x/splat.ply', db)).toBeNull();
    expect(await readSplatFile('asset:splat/abc.ply', db)).toBeNull();
  });
});

describe('scan entity', () => {
  const url = 'asset:splat/0123456789abcdef0123456789abcdef.ply';
  let n = 0;
  const sts = scanStatements(url, 'living room', 'reconstructed', () => `id${n++}`, 1);

  it('is a GaussianSplat with the splat reference and its origin', () => {
    const by = (p: string) => sts.find((s) => s.p.value.endsWith(p))!.o.value;
    expect(by('#type')).toBe('urn:kbase:type/GaussianSplat');
    expect(by('/splat')).toBe(url);
    expect(by('/splat-origin')).toBe('reconstructed');
    expect(sts.every((s) => s.s.value === scanEntityIri(url))).toBe(true);
  });

  it('a reconstructed splat gets no TripoSplat correction; generated and unmarked ones do', () => {
    expect(splatOriginOf(sts, url)).toBe('reconstructed');
    expect(splatOrientationFor(sts, url)).toBe('none');
    const gen = scanStatements(url, 'x', 'generated', () => 'g' + n++, 1);
    expect(splatOrientationFor(gen, url)).toBe('triposplat');
    expect(splatOrientationFor([], '/generated/x.ply')).toBe('triposplat');
  });

  it('is accepted as a background reference', () => {
    const bg = { ...sts[0], id: 'bg', s: { kind: 'iri' as const, value: SPACE_SUBJECT }, p: { kind: 'iri' as const, value: BACKGROUND_SPLAT_PREDICATE }, o: { kind: 'literal' as const, value: url } };
    expect(backgroundSplatFrom([bg])).toBe(url);
    expect(isLocalSplatUrl('asset:splat/../../etc.ply')).toBe(false);
    expect(isSplatUrl('asset:splat/x.glb')).toBe(false);
  });
});
