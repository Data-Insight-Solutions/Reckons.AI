import { describe, expect, it } from 'vitest';
import { exampleTtl, type Receipt, type StageReceipt } from '../gen-assets';

const stage = (over: Partial<StageReceipt>): StageReceipt => ({
  stage: 'image', tool: { name: 't', license: 'MIT', version: 'v', repo: 'r' }, models: [], input: { prompt: 'p' }, settings: { seed: 1 },
  ranAt: '2026-10-20T00:00:00Z', durationS: 1, output: { file: 'image.webp', sha256: 'x', bytes: 1 }, check: { pass: true, problems: [], notes: [], measured: {} }, ...over,
});

describe('showcase receipts (F58.9 / kb:showcase-splat)', () => {
  const receipt: Receipt = {
    slug: 'box', label: 'A box', role: 'node', generated: true, showcase: true,
    stages: {
      image: stage({}),
      splat: stage({ stage: 'splat', output: { file: 'splat.ply', sha256: 'y', bytes: 17_000_000 }, settings: { seed: 1, gaussians: 262144 },
        compressed: { format: 'spz', lossy: true, file: 'splat.spz', sha256: 'z', bytes: 3_500_000, ratio: 5, source: { file: 'splat.ply', sha256: 'y', bytes: 17_000_000, gaussians: 262144, extent: 1 }, gaussians: 262144, extent: 1,
          tool: { name: 'splat-transform', license: 'MIT', version: '3.8.0' }, check: { pass: true, problems: [], measured: {} }, durationS: 1 } }),
    },
  };
  it('points the splat node at the compressed file, never at the uncommitted PLY, and has no video node', () => {
    const ttl = exampleTtl([receipt]);
    expect(ttl).toContain('p:splat "/generated/box/splat.spz"');
    expect(ttl).not.toContain('splat.ply');
    expect(ttl).not.toContain('ktype:Video');
  });
  it('a non-showcase splat still points at its PLY', () => {
    const ttl = exampleTtl([{ ...receipt, showcase: undefined }]);
    expect(ttl).toContain('p:splat "/generated/box/splat.ply"');
  });
});
