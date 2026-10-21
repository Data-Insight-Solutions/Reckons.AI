// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCapabilities, parseJob, parseRequest, validateReceipt, verifyOutput,
  type GenerationReceipt, type GenerationRequest,
} from '../protocol';

vi.stubGlobal('crypto', webcrypto);
const request: GenerationRequest = {
  version: 1, id: 'd67cf353-5af2-404b-b93d-41d10ffb6f15', spaceId: 'synthetic-space',
  stage: 'image', prompt: 'A watercolor lighthouse', seed: 42,
};
const receipt: GenerationReceipt = {
  stage: 'image', tool: { name: 'fixture', version: '1', license: 'MIT' },
  models: [{ file: 'fixture', sha256: 'a'.repeat(64), license: 'MIT' }],
  input: { prompt: request.prompt }, settings: { seed: 42 }, ranAt: '2026-10-20T12:00:00Z',
  durationS: 1, output: { file: 'image.webp', sha256: 'a'.repeat(64), bytes: 3 }, check: { pass: true },
};

describe('generation authority and receipts', () => {
  it('preserves literal prompts while dropping executable fields', () => {
    const prompt = 'a lighthouse "$(touch /tmp/no)" `echo no`\nwith waves';
    expect(parseRequest({ ...request, prompt, command: 'rm -rf /', output: '/tmp/x', extraArgs: ['--evil'] }))
      .toEqual({ ...request, prompt });
  });
  it.each([
    { id: '../escape' }, { stage: 'shell' }, { prompt: '' }, { prompt: 'x'.repeat(2001) },
    { seed: -1 }, { seed: NaN }, { seed: 1.5 }, { parentId: request.id }, { spaceId: '' },
    { stage: 'video' }, { stage: 'splat', parentId: '../../other' },
  ])('rejects an invalid request: %j', patch => {
    expect(() => parseRequest({ ...request, ...patch })).toThrow('Invalid generation request');
  });
  it('refuses a result from a different space, prompt, or job', () => {
    for (const patch of [{ spaceId: 'other' }, { prompt: 'other' }, { seed: 13 }]) {
      expect(() => parseJob({ request: { ...request, ...patch }, state: 'completed', receipt }, request)).toThrow();
    }
  });
  it('requires an accepted, bounded, consistent receipt', () => {
    expect(() => validateReceipt(receipt, request)).not.toThrow();
    for (const patch of [
      { check: { pass: false } }, { stage: 'video' }, { input: { prompt: 'different' } },
      { settings: { seed: 1 } }, { output: { ...receipt.output, file: '../image.webp' } },
      { output: { ...receipt.output, bytes: 101 * 1024 * 1024 } },
    ]) expect(() => validateReceipt({ ...receipt, ...patch }, request)).toThrow();
  });
  it('rejects corrupted file bytes even when the receipt claims success', async () => {
    await expect(verifyOutput(new Uint8Array([1, 2, 3]).buffer, receipt)).rejects.toThrow('does not match');
  });
  it('requires a recent runner heartbeat and exactly one entry per supported stage', () => {
    const caps = {
      version: 1, workspaceId: request.id, heartbeat: 10_000,
      stages: ['image', 'video', 'splat'].map(stage => ({ stage, available: true })),
    };
    expect(parseCapabilities(caps, 20_000)).toEqual(caps);
    expect(() => parseCapabilities(caps, 41_000)).toThrow('offline');
    expect(() => parseCapabilities({ ...caps, stages: [caps.stages[0], caps.stages[0], caps.stages[2]] }, 20_000)).toThrow();
  });
});
