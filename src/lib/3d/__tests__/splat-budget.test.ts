import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { ENTITY_SPLAT_STARTUP_BUDGET, overStartupBudget, readSplatGaussianCount, splatCountFromHeader } from '../splat-budget';

function spzBody(count: number): Uint8Array {
  const b = new Uint8Array(16 + 64);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x5053474e, true); v.setUint32(4, 2, true); v.setUint32(8, count, true);
  return b;
}
const plyHead = (n: number) => new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nend_header\n`);

describe('entity splat startup budget', () => {
  it('reads the count from an SPZ header and a PLY header', () => {
    expect(splatCountFromHeader(spzBody(262_144))).toBe(262_144);
    expect(splatCountFromHeader(plyHead(5000))).toBe(5000);
    expect(splatCountFromHeader(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('defers a splat over the budget and loads one at or under it', () => {
    expect(ENTITY_SPLAT_STARTUP_BUDGET).toBe(131_072);
    expect(overStartupBudget(262_144)).toBe(true);
    expect(overStartupBudget(131_073)).toBe(true);
    expect(overStartupBudget(131_072)).toBe(false);
    expect(overStartupBudget(60_000)).toBe(false);
    expect(overStartupBudget(undefined)).toBe(false); // unreadable: load, do not hide it
  });

  it('decides from a gzipped SPZ file by its header, end to end', async () => {
    const file = (n: number) => gzipSync(Buffer.concat([spzBody(n), Buffer.alloc(4096)]));
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(new Uint8Array(url.includes('big') ? file(262_144) : file(40_000)))) as typeof fetch;
    try {
      expect(overStartupBudget(await readSplatGaussianCount('/big.spz'))).toBe(true);
      expect(overStartupBudget(await readSplatGaussianCount('/small.spz'))).toBe(false);
    } finally { globalThis.fetch = real; }
  });
});
