import { REQUIRED_SPLAT_PROPS } from '../splat-check';

/** A synthetic binary 3DGS PLY with the 14 required float properties; positions come from `points`. */
export function makePly(points: ArrayLike<number> | number, opts: { nan?: boolean; truncate?: number; drop?: string } = {}): Uint8Array {
  const pts: number[] = typeof points === 'number'
    ? Array.from({ length: points * 3 }, (_, i) => (i % 3 === 0 ? i / 3 / points : 0))
    : Array.from(points);
  const n = pts.length / 3;
  const props = REQUIRED_SPLAT_PROPS.filter((p) => p !== opts.drop);
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${n}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const head = new TextEncoder().encode(header);
  const body = new DataView(new ArrayBuffer(n * props.length * 4));
  for (let i = 0; i < n; i++) {
    props.forEach((p, k) => {
      let v = 0;
      if (p === 'x') v = pts[i * 3];
      if (p === 'y') v = pts[i * 3 + 1];
      if (p === 'z') v = pts[i * 3 + 2];
      if (p === 'opacity') v = 2;
      if (p === 'rot_0') v = 1;
      if (opts.nan && i === 3 && p === 'scale_0') v = NaN;
      body.setFloat32((i * props.length + k) * 4, v, true);
    });
  }
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head, 0);
  bytes.set(new Uint8Array(body.buffer), head.length);
  return opts.truncate ? bytes.subarray(0, bytes.length - opts.truncate) : bytes;
}

/** A gzip-compressed SPZ-shaped buffer (header + packed body), for the header checks. */
export async function makeSpz(count: number, opts: { magic?: number; body?: number } = {}): Promise<Uint8Array> {
  const raw = new Uint8Array(16 + (opts.body ?? count * 19));
  const v = new DataView(raw.buffer);
  v.setUint32(0, opts.magic ?? 0x5053474e, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, count, true);
  const stream = new Response(raw as BodyInit).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
