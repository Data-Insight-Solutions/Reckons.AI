// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationRunner, lockOwnerAlive, prepareParent } from '../generation-runner';
import type { GenerationJob, GenerationRequest } from '../../../src/lib/generation/protocol';

vi.mock('../gen-assets.js', () => ({
  generationAvailability: () => ({ available: false, reason: 'Synthetic missing model' }),
  generateStage: vi.fn(),
}));
const directories: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'generation-test-')); directories.push(dir); return dir; };
afterEach(() => directories.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const parent: GenerationRequest = {
  version: 1, id: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', spaceId: 'synthetic-space',
  stage: 'image', prompt: 'Synthetic landscape', seed: 42,
};
const request: GenerationRequest = {
  ...parent, id: '6c6da8a8-1574-46bb-97fd-453db308379d', stage: 'splat', parentId: parent.id,
};
function parentFixture(jobs: string) {
  const bytes = Buffer.from('synthetic checked image bytes');
  const dir = join(jobs, parent.id);
  mkdirSync(dir);
  const job: GenerationJob = { request: parent, state: 'completed', receipt: {
    stage: 'image', tool: { name: 'fixture', version: '1', license: 'MIT' },
    models: [{ file: 'fixture', sha256: 'a'.repeat(64), license: 'MIT' }],
    input: { prompt: parent.prompt }, settings: { seed: 42 }, durationS: 1,
    ranAt: '2026-10-20T12:00:00Z', check: { pass: true },
    output: { file: 'image.webp', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  } };
  writeFileSync(join(dir, 'request.json'), JSON.stringify(parent));
  writeFileSync(join(dir, 'status.json'), JSON.stringify(job));
  writeFileSync(join(dir, 'image.webp'), bytes);
  return { dir, bytes, job };
}

describe('private generation queue', () => {
  it('derives only from verified completed images in the originating space', () => {
    const jobs = temp();
    const { bytes, dir, job } = parentFixture(jobs);
    const output = join(jobs, request.id);
    mkdirSync(output);
    expect(() => prepareParent(jobs, { ...request, spaceId: 'another-space' }, output)).toThrow('same space');
    prepareParent(jobs, request, output);
    expect(readFileSync(join(output, 'image.webp'))).toEqual(bytes);
    writeFileSync(join(dir, 'image.webp'), 'corrupt');
    expect(() => prepareParent(jobs, request, output)).toThrow('receipt');
    writeFileSync(join(dir, 'image.webp'), bytes);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...job, state: 'failed' }));
    expect(() => prepareParent(jobs, request, output)).toThrow('completed image');
    writeFileSync(join(dir, 'status.json'), JSON.stringify(job));
    writeFileSync(join(dir, 'cancel.json'), '{}');
    expect(() => prepareParent(jobs, request, output)).toThrow('completed image');
  });
  it('keeps one runner per workspace and records missing models without claiming an asset', () => {
    const workspace = temp();
    const runner = new GenerationRunner(workspace);
    try {
      expect(() => new GenerationRunner(workspace)).toThrow();
      const dir = join(runner.jobs, parent.id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'request.json'), JSON.stringify(parent));
      runner.tick();
      const result = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
      expect(result).toMatchObject({ state: 'failed', error: 'Synthetic missing model' });
      expect(existsSync(join(dir, 'image.webp'))).toBe(false);
      runner.tick();
      expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))).toEqual(result);
    } finally { runner.close(); }
  });
  it('honors cancellation before dispatch and refuses replay of interrupted jobs', () => {
    const runner = new GenerationRunner(temp());
    try {
      const dir = join(runner.jobs, parent.id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'request.json'), JSON.stringify(parent));
      writeFileSync(join(dir, 'cancel.json'), '{}');
      runner.tick();
      expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).state).toBe('cancelled');
      rmSync(join(dir, 'cancel.json'));
      writeFileSync(join(dir, 'status.json'), JSON.stringify({ request: parent, state: 'running' }));
      runner.tick();
      expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).state).toBe('failed');
    } finally { runner.close(); }
  });
  it('fails corrupt metadata without blocking later jobs or replaying either request', () => {
    const runner = new GenerationRunner(temp());
    try {
      for (const job of [parent, { ...parent, id: 'f67cf353-5af2-404b-b93d-41d10ffb6f15' }]) {
        const dir = join(runner.jobs, job.id);
        mkdirSync(dir);
        writeFileSync(join(dir, 'request.json'), JSON.stringify(job));
      }
      writeFileSync(join(runner.jobs, parent.id, 'status.json'), '{unfinished');
      runner.tick();
      expect(JSON.parse(readFileSync(join(runner.jobs, parent.id, 'status.json'), 'utf8')).error).toContain('metadata');
      expect(JSON.parse(readFileSync(join(runner.jobs, 'f67cf353-5af2-404b-b93d-41d10ffb6f15', 'status.json'), 'utf8')).error).toContain('missing model');
    } finally { runner.close(); }
  });
});

describe('runner lock', () => {
  it('reclaims a lock left by a runner that died', () => {
    const workspace = temp();
    const lock = join(workspace, '.reckons-generation', 'runner.lock');
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 7 }));
    const runner = new GenerationRunner(workspace);
    try {
      expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toEqual({ pid: process.pid });
    } finally { runner.close(); }
  });
  it('counts a lock owner as alive only while its pid is still a generation runner', () => {
    const live = () => true;
    const gone = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    expect(lockOwnerAlive(4242, () => false)).toBe(false);
    expect(lockOwnerAlive(4242, live, () => 'node tsx scripts/content/generation-runner.ts --workspace=x')).toBe(true);
    expect(lockOwnerAlive(4242, live, () => 'code eslint-server')).toBe(false);
    expect(lockOwnerAlive(4242, live, gone, () => true)).toBe(false);
    expect(lockOwnerAlive(4242, live, gone, () => false)).toBe(true);
    expect(lockOwnerAlive(process.pid)).toBe(true);
    expect(lockOwnerAlive(undefined)).toBe(false);
  });
});

describe('lastErrorLine', () => {
  it('names the error line from a crashed worker, not the stack frame or the Node banner', async () => {
    const { lastErrorLine } = await import('../generation-runner');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'worker-log-'));
    const log = join(dir, 'worker.log');
    writeFileSync(log, "node:internal/modules/package_json_reader:256\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /x/\n    at Object.getPackageJSONURL (node:internal)\n\nNode.js v22.17.1\n");
    expect(lastErrorLine(log)).toBe("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /x/");
    expect(lastErrorLine(join(dir, 'missing.log'))).toBe('');
  });
});
