/** F303.1 cross-device request validation: synthetic ids and hashes only. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readCapabilityTerms, validateCrossDeviceRequest } from '../cross-device-request.js';
import { verifyInputs } from '../../cross-device-inputs.js';
import type { ChannelJob } from '../job-request.js';

const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const NOW = new Date('2026-11-18T10:00:00.000Z');
const JOBS: Record<string, ChannelJob> = { report: { does: 'fixture', argv: ['node', 'f.js'], params: { dry: { type: 'bool' } }, gpu: false, ollama: false } };
const terms = readCapabilityTerms(readFileSync(path.join(import.meta.dirname, '..', '..', '..', '..', 'static', 'reckons-capabilities.ttl'), 'utf8'));
const SHA = 'a'.repeat(64);
const good = { id: 'r1', job: 'report', space: 'demo', args: { dry: true }, requester: ME, createdAt: NOW.toISOString(),
  needs: [{ term: 'gpu-memory-gib', atLeast: 16 }, { term: 'tool:blender' }], inputs: [{ path: 'assets/a.ply', sha256: SHA }] };
const run = (r: object, thisDeviceId = ME) => validateCrossDeviceRequest(r as never, { thisDeviceId, terms, jobs: JOBS, spaces: ['demo'], now: NOW });
const reason = (r: object, id = ME) => { const v = run(r, id); return v.ok ? '' : v.reason; };

describe('validateCrossDeviceRequest', () => {
  it('reads the defined terms from the capability graph', () => {
    expect(terms.numeric.has('gpu-memory-gib')).toBe(true);
    expect([...terms.families].sort()).toEqual(['model', 'tool']);
  });
  it('accepts this device\'s own unsigned request and keeps every part, marked unsigned', () => {
    expect(run(good)).toMatchObject({ ok: true, requester: ME, signed: false, needs: good.needs, inputs: good.inputs, job: 'report' });
  });
  it('an unsigned request from another device is refused with a stated reason', () => {
    expect(reason({ ...good, requester: OTHER })).toContain('another device is refused');
  });
  it('another device is refused even with a signature, because none can be verified yet', () => {
    expect(reason({ ...good, requester: OTHER, signature: 'AAAA' })).toContain('signatures are not verified');
  });
  it('requires an opaque device id, never a host or user name', () => {
    for (const requester of ['my-laptop', 'matt', 'DESKTOP-1', '', 7, undefined, ME.toUpperCase()]) expect(reason({ ...good, requester })).toContain('opaque device id');
  });
  it('still refuses an undefined job, a foreign space, and undeclared arguments (the F74.14 rules)', () => {
    expect(reason({ ...good, job: 'rm-everything' })).toContain('not one of the defined jobs');
    expect(reason({ ...good, space: 'elsewhere' })).toContain('not in this workspace');
    expect(reason({ ...good, args: { shell: 'x' } })).toContain('not a parameter');
  });
  it('refuses unknown or malformed need terms', () => {
    for (const needs of [[{ term: 'quantum-bits' }], [{ term: 'tool:' }], [{ term: 'tool:Bad Name' }], [{ term: 'vendor:x' }], [{ term: 'tool:blender', atLeast: 1 }],
      [{ term: 'gpu-memory-gib', atLeast: -1 }], [{ term: 'gpu-memory-gib', atLeast: 'lots' }], [{ term: 'gpu-memory-gib', extra: 1 }], [{}], ['gpu-memory-gib'], 'gpu', {}]) {
      expect(reason({ ...good, needs }), JSON.stringify(needs)).not.toBe('');
    }
    expect(reason({ ...good, needs: Array.from({ length: 17 }, () => ({ term: 'ram-gib' })) })).toContain('at most');
  });
  it('accepts a model family term with a tag', () => {
    expect(run({ ...good, needs: [{ term: 'model:qwen3-coder:30b' }] }).ok).toBe(true);
  });
  it('refuses hostile input paths and malformed hashes', () => {
    for (const p of ['../secret', '/etc/passwd', 'a/../../b', 'a//b', './a', 'a b', 'a\\b', '', `${'x'.repeat(201)}`, '~/x']) {
      expect(reason({ ...good, inputs: [{ path: p, sha256: SHA }] }), p).toContain('input path');
    }
    for (const sha256 of ['abc', 'A'.repeat(64), 'g'.repeat(64), 5, undefined]) expect(reason({ ...good, inputs: [{ path: 'a.ply', sha256 }] })).toContain('sha256');
    expect(reason({ ...good, inputs: [{ path: 'a.ply', sha256: SHA, url: 'http://x' }] })).toContain('only have path and sha256');
  });
  it('refuses a missing or far-future createdAt and an oversized signature', () => {
    expect(reason({ ...good, createdAt: undefined })).toContain('createdAt');
    expect(reason({ ...good, createdAt: 'yesterday' })).toContain('createdAt');
    expect(reason({ ...good, createdAt: '2026-12-30T00:00:00Z' })).toContain('future');
    expect(reason({ ...good, signature: 'x'.repeat(3000) })).toContain('signature');
  });
  it('treats absent needs and inputs as empty', () => {
    const { needs: _n, inputs: _i, ...bare } = good;
    expect(run(bare)).toMatchObject({ ok: true, needs: [], inputs: [] });
  });
});

describe('verifyInputs', () => {
  const body = Buffer.from('synthetic input');
  const sha = createHash('sha256').update(body).digest('hex');
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'inputs-'));
    try { mkdirSync(path.join(dir, 'assets')); writeFileSync(path.join(dir, 'assets', 'a.bin'), body); fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('accepts a file whose hash matches', () => withDir((d) => expect(verifyInputs(d, [{ path: 'assets/a.bin', sha256: sha }])).toEqual({ ok: true })));
  it('refuses a request whose input hash does not match the file it finds', () => withDir((d) => {
    expect(verifyInputs(d, [{ path: 'assets/a.bin', sha256: SHA }])).toEqual({ ok: false, reason: 'input assets/a.bin does not match its sha256' });
  }));
  it('refuses missing files, directories and symbolic links', () => withDir((d) => {
    writeFileSync(path.join(os.tmpdir(), 'inputs-outside.txt'), 'x');
    symlinkSync(path.join(os.tmpdir(), 'inputs-outside.txt'), path.join(d, 'assets', 'link.bin'));
    expect(verifyInputs(d, [{ path: 'assets/none.bin', sha256: sha }])).toMatchObject({ ok: false, reason: expect.stringContaining('not found') });
    expect(verifyInputs(d, [{ path: 'assets', sha256: sha }])).toMatchObject({ ok: false, reason: expect.stringContaining('not a plain file') });
    expect(verifyInputs(d, [{ path: 'assets/link.bin', sha256: sha }])).toMatchObject({ ok: false, reason: expect.stringContaining('symbolic link') });
    rmSync(path.join(os.tmpdir(), 'inputs-outside.txt'), { force: true });
  }));
});
