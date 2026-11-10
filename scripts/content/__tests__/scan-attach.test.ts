import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_QUESTION, DERIVED_FROM, linkRows, parseLinkFrom,
  AttachError, appendAttachRows, assertTargeted, attachFinishedScan, attachRows, attachSplat, contentId, copySplatToSpace, requireSpace,
} from '../scan-attach';
import type { ScanReceipt } from '../scan-room-lib';

// Synthetic fixtures only: a temp workspace and a few fake bytes. Nothing here is a real scan or space.
let root: string;
let workspace: string;
let queue: string;
const FAKE = Buffer.from('not a real splat, just bytes for the copy path');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-attach-'));
  workspace = join(root, 'workspace');
  queue = join(workspace, 'knowledge.pending.jsonl');
  mkdirSync(join(workspace, 'kbs', 'demo-space'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeScan(over: Partial<ScanReceipt> = {}, bytes = FAKE): string {
  const dir = join(root, 'scan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'splat.spz'), bytes);
  const ok = { pass: true, problems: [], notes: [], measured: {} };
  const h = 'a'.repeat(64);
  const receipt: ScanReceipt = {
    origin: 'reconstructed',
    input: { kind: 'video', name: 'fake.mp4', sha256: h, bytes: 10 },
    frames: { extracted: 240, kept: 200, registered: 190, fps: 30 },
    tools: { ffmpeg: 'ffmpeg 7', pycolmap: '4', brush: 'brush 1' },
    settings: { totalSteps: 1 },
    stagesS: { frames: 1, poses: 1, train: 1 },
    gaussians: 1000,
    output: { file: 'splat.ply', sha256: h, bytes: 99 },
    checks: { registration: ok, splat: ok },
    compressed: { format: 'spz', lossy: true, file: 'splat.spz', sha256: sha(bytes), bytes: bytes.length, ratio: 5, gaussians: 1000, extent: 3, check: { pass: true, problems: [] } },
    ranAt: '2026-11-10T00:00:00Z',
    notes: [],
    ...over,
  };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
  return dir;
}

describe('rows are addressed', () => {
  it('every scan row carries the kb target, the scanStatements set, and is a proposal', () => {
    const rows = attachRows('demo-space', 'abc.spz', 'room scan');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.kb === 'demo-space')).toBe(true);
    expect(rows.find((r) => r.predicate === 'urn:kbase:predicate/splat')?.object).toBe('asset:splat/abc.spz');
    expect(rows.every((r) => r.type === 'suggestion')).toBe(true);
  });

  it('refuses a scan row with no kb target, and writes nothing', () => {
    const rows = attachRows('demo-space', 'abc.spz', 'x');
    const untargeted = [...rows, { ...rows[0], kb: '' }];
    expect(() => assertTargeted(untargeted)).toThrow(AttachError);
    expect(() => appendAttachRows(queue, untargeted)).toThrow(/no kb target/);
    expect(existsSync(queue)).toBe(false);
    const { kb: _kb, ...bare } = rows[0];
    expect(() => assertTargeted([bare])).toThrow(/no kb target/);
  });
});

describe('content-addressed copy', () => {
  it('writes the same result twice without changing anything', () => {
    const src = join(root, 'a.spz');
    writeFileSync(src, FAKE);
    const space = requireSpace(workspace, 'demo-space');
    const first = copySplatToSpace(src, space);
    expect(first.copied).toBe(true);
    expect(first.id).toBe(contentId(FAKE, 'spz'));
    const before = statSync(first.dest).mtimeMs;
    utimesSync(first.dest, new Date(1_000_000), new Date(1_000_000));
    const second = copySplatToSpace(src, space);
    expect(second).toMatchObject({ id: first.id, copied: false });
    expect(statSync(second.dest).mtimeMs).toBe(1_000_000 * 1); // untouched: not rewritten
    expect(before).toBeGreaterThan(0);
    expect(readdirSync(join(space, 'assets', 'splats'))).toEqual([first.id]);
  });

  it('queues the rows once, not twice', () => {
    const src = join(root, 'a.spz');
    writeFileSync(src, FAKE);
    const one = attachSplat({ splat: src, workspace, space: 'demo-space' });
    const two = attachSplat({ splat: src, workspace, space: 'demo-space' });
    expect(one).toMatchObject({ copied: true, rows: 5, rowsAlreadyQueued: 0 }); // four base rows plus the capture question
    expect(two).toMatchObject({ copied: false, rows: 0, rowsAlreadyQueued: 0 });
    const lines = readFileSync(queue, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => JSON.parse(l).kb)).toEqual(Array(5).fill('demo-space'));
  });
});

describe('space lookup', () => {
  it('refuses a slug that is not in the workspace, and creates nothing', () => {
    expect(() => requireSpace(workspace, 'no-such-space')).toThrow(/no space "no-such-space"/);
    const src = join(root, 'a.spz');
    writeFileSync(src, FAKE);
    expect(() => attachSplat({ splat: src, workspace, space: 'no-such-space' })).toThrow(AttachError);
    expect(existsSync(join(workspace, 'kbs', 'no-such-space'))).toBe(false);
    expect(existsSync(queue)).toBe(false);
  });
  it('refuses a name that could leave kbs/', () => {
    expect(() => requireSpace(workspace, '../escape')).toThrow(/not a usable space name/);
    expect(() => requireSpace(workspace, 'a/b')).toThrow(/not a usable space name/);
  });
});

describe('attach-only mode', () => {
  it('attaches a finished scan whose receipt passed', () => {
    const r = attachFinishedScan({ scanDir: makeScan(), workspace, space: 'demo-space' });
    expect(r.rows).toBe(5);
    expect(existsSync(r.file)).toBe(true);
  });
  it('refuses a scan whose receipt did not pass', () => {
    const bad = { pass: false, problems: ['registered 3 of 200'], notes: [], measured: {} };
    const dir = makeScan({ checks: { registration: bad, splat: bad } });
    expect(() => attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space' })).toThrow(/receipt did not pass/);
    expect(existsSync(queue)).toBe(false);
    expect(existsSync(join(workspace, 'kbs', 'demo-space', 'assets'))).toBe(false);
  });
  it('refuses a scan with no receipt, and one whose file no longer matches it', () => {
    expect(() => attachFinishedScan({ scanDir: join(root, 'empty'), workspace, space: 'demo-space' })).toThrow(/no receipt.json/);
    const dir = makeScan();
    writeFileSync(join(dir, 'splat.spz'), 'tampered');
    expect(() => attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space' })).toThrow(/does not match its receipt hash/);
  });
});

describe('links (Defect 2): a splat does not arrive as a silent island', () => {
  const CAPTURE = 'urn:test:capture/one';
  const FOLDER = 'urn:test:set/siblings';
  const REL = 'urn:test:rel/contains';
  const rowsOf = () => readFileSync(queue, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const splatIri = (id: string) => `urn:kbase:concept/scan-${id.slice(0, 12)}`;

  it('--derived-from emits <splat> prov:wasDerivedFrom <iri>, targeted and pending-shaped', () => {
    const r = attachFinishedScan({ scanDir: makeScan(), workspace, space: 'demo-space', links: { derivedFrom: [CAPTURE] } });
    const row = rowsOf().find((x) => x.predicate === DERIVED_FROM);
    expect(row).toMatchObject({ subject: splatIri(r.id), object: CAPTURE, objectKind: 'iri', kb: 'demo-space', type: 'suggestion' });
    expect(rowsOf().some((x) => x.type === 'question')).toBe(false);
    expect(r.rows).toBe(5);
  });

  it('--link-from emits <subject> <predicate> <splat>', () => {
    const r = attachFinishedScan({ scanDir: makeScan(), workspace, space: 'demo-space', links: { linkFrom: [[FOLDER, REL]] } });
    expect(rowsOf().find((x) => x.subject === FOLDER)).toMatchObject({ predicate: REL, object: splatIri(r.id), objectKind: 'iri', kb: 'demo-space' });
  });

  it('refuses a value that is not an absolute IRI, before copying anything', () => {
    expect(() => attachFinishedScan({ scanDir: makeScan(), workspace, space: 'demo-space', links: { derivedFrom: ['capture one'] } })).toThrow(/not an absolute IRI/);
    expect(() => attachFinishedScan({ scanDir: makeScan(), workspace, space: 'demo-space', links: { linkFrom: [[FOLDER, 'rel']] } })).toThrow(/not an absolute IRI/);
    expect(() => parseLinkFrom(['only-one'])).toThrow(/needs/);
    expect(existsSync(join(workspace, 'kbs', 'demo-space', 'assets'))).toBe(false);
    expect(existsSync(queue)).toBe(false);
  });

  it('with no link, emits exactly one question row shaped as a partial fact', () => {
    const rows = linkRows('demo-space', 'abc.spz', {}, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ predicate: DERIVED_FROM, type: 'question', question: CAPTURE_QUESTION, kb: 'demo-space' });
    expect(rows[0].object).toBeUndefined();
    expect(linkRows('demo-space', 'abc.spz', { derivedFrom: [CAPTURE] }, true).some((r) => r.type === 'question')).toBe(false);
  });

  it('adds links to an already-attached scan: only the new link rows, no second copy, no base rows', () => {
    const dir = makeScan();
    const first = attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space' });
    writeFileSync(queue, ''); // the app drained the queue
    const again = attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space', links: { derivedFrom: [CAPTURE] } });
    expect(again).toMatchObject({ id: first.id, copied: false, rows: 1 });
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ predicate: DERIVED_FROM, object: CAPTURE });
  });

  it('--links-only emits just the link rows and refuses a scan that is not attached, or no link', () => {
    const dir = makeScan();
    expect(() => attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space', links: { derivedFrom: [CAPTURE] }, linksOnly: true })).toThrow(/not attached/);
    attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space', links: { derivedFrom: [CAPTURE] } });
    writeFileSync(queue, '');
    const r = attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space', links: { linkFrom: [[FOLDER, REL]] }, linksOnly: true });
    expect(r.rows).toBe(1);
    expect(rowsOf()).toHaveLength(1);
    expect(() => attachFinishedScan({ scanDir: dir, workspace, space: 'demo-space', linksOnly: true })).toThrow(/at least one/);
  });
});
