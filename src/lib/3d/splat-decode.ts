/**
 * Decode an SPZ or SOG file in the browser and summarise its Gaussian centres (F58.9.11).
 *
 * This is the renderer's OWN decoder (gaussian-splat-lite's `Splats`), not a second implementation
 * of two formats: if the renderer can draw the file, this decodes it, and if it cannot, the import
 * is refused with the reason before the file is stored. It needs Web Workers, so it runs in a
 * browser and not under Node; the pure judgement over what it returns is
 * `judgeDecodedSplat` in splat-check.ts, which is unit-tested.
 *
 * Memory: the decoded splats are held while the centres are read, then released. A compressed
 * file is small, but its decoded form is not (about 60 bytes per Gaussian in the renderer).
 */
import { EXTENT_SAMPLE, type DecodedSplat, type SplatDecoder } from './splat-check';
import { loadSplatLib } from './splat';

export const decodeSplatCentres: SplatDecoder = async (file, kind) => {
  const { Splats } = await loadSplatLib();
  const splats = new Splats({ file, fileType: kind as never, fileName: `scan.${kind}` });
  try {
    await splats.initialized;
    const count = splats.getNumSplats();
    const every = Math.max(1, Math.floor(count / EXTENT_SAMPLE));
    const out: DecodedSplat = { count, nonFinite: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sample: [] };
    splats.forEachCenter((i: number, x: number, y: number, z: number) => {
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) { out.nonFinite++; return; }
      if (x < out.min[0]) out.min[0] = x; if (x > out.max[0]) out.max[0] = x;
      if (y < out.min[1]) out.min[1] = y; if (y > out.max[1]) out.max[1] = y;
      if (z < out.min[2]) out.min[2] = z; if (z > out.max[2]) out.max[2] = z;
      if (i % every === 0) out.sample.push(x, y, z);
    });
    return out;
  } finally {
    splats.dispose();
  }
};

/** Sampled centres of a splat of any kind, for fitting the floor (Level the floor). */
export async function sampleCentres(file: Blob, kind: 'spz' | 'sog'): Promise<Float32Array> {
  const d = await decodeSplatCentres(file, kind);
  return Float32Array.from(d.sample);
}
