/**
 * Splat file acceptance checks, pure over the bytes (F58.9.1 / F58.9.7).
 *
 * One implementation for two callers: scripts/content/asset-checks.ts (the generation pipeline's
 * independent check) and the browser's "Import a scan", which refuses a file that fails here with
 * the reason shown. The tool's or the exporter's say-so is not evidence; the bytes are.
 */

export interface SplatCheck {
  pass: boolean;
  /** Why it failed, or empty. */
  problems: string[];
  notes: string[];
  /** Measured values, recorded in a receipt. */
  measured: Record<string, number | string>;
}

const PLY_SIZES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

/** The properties a 3DGS renderer needs. Higher-order SH (f_rest_*) is optional. */
export const REQUIRED_SPLAT_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header\n');
  const limit = Math.min(bytes.length - marker.length, 64 * 1024);
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    return i + marker.length;
  }
  return -1;
}

/** Parse a binary little-endian 3DGS PLY and judge it. Pure over the bytes. */
export function judgeSplatPly(bytes: Uint8Array, expect?: { count?: number }): SplatCheck {
  const problems: string[] = [];
  const fail = (p: string): SplatCheck => ({ pass: false, problems: [p], notes: [], measured: {} });
  const headEnd = findHeaderEnd(bytes);
  if (headEnd < 0) return fail('no PLY header (end_header not found)');
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd)).split('\n').map((l) => l.trim());
  if (header[0] !== 'ply') return fail('not a PLY file');
  if (!header.includes('format binary_little_endian 1.0')) return fail('only binary_little_endian PLY is checked');
  let count = 0;
  let inVertex = false;
  const props: { name: string; type: string; offset: number }[] = [];
  let stride = 0;
  for (const line of header) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') { inVertex = parts[1] === 'vertex'; if (inVertex) count = Number(parts[2]); }
    else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') return fail('list properties are not a 3DGS layout');
      const size = PLY_SIZES[parts[1]];
      if (!size) return fail(`unknown property type ${parts[1]}`);
      props.push({ name: parts[2], type: parts[1], offset: stride });
      stride += size;
    }
  }
  const missing = REQUIRED_SPLAT_PROPS.filter((p) => !props.some((q) => q.name === p));
  if (missing.length) problems.push(`missing properties: ${missing.join(', ')}`);
  if (!(count > 0)) problems.push('no Gaussians');
  if (expect?.count && count !== expect.count) problems.push(`${count} Gaussians, expected ${expect.count}`);
  const body = bytes.length - headEnd;
  if (body < count * stride) problems.push(`truncated: ${body} bytes of body for ${count} x ${stride}`);
  if (problems.length) return { pass: false, problems, notes: [], measured: { count } };

  const view = new DataView(bytes.buffer, bytes.byteOffset + headEnd, count * stride);
  const off = (n: string) => props.find((p) => p.name === n)!.offset;
  const floatProps = props.filter((p) => p.type === 'float' || p.type === 'float32');
  const [ox, oy, oz, oo] = [off('x'), off('y'), off('z'), off('opacity')];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let nonFinite = 0;
  let visible = 0;
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    for (const p of floatProps) if (!Number.isFinite(view.getFloat32(base + p.offset, true))) { nonFinite++; break; }
    const xyz = [view.getFloat32(base + ox, true), view.getFloat32(base + oy, true), view.getFloat32(base + oz, true)];
    for (let k = 0; k < 3; k++) { if (xyz[k] < min[k]) min[k] = xyz[k]; if (xyz[k] > max[k]) max[k] = xyz[k]; }
    // Opacity is stored as a logit; sigmoid > 0.05 is a Gaussian a viewer would actually draw.
    if (1 / (1 + Math.exp(-view.getFloat32(base + oo, true))) > 0.05) visible++;
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (nonFinite) problems.push(`${nonFinite} Gaussian(s) with non-finite values`);
  if (!(extent > 1e-4)) problems.push(`degenerate extent ${extent}`);
  if (visible < count * 0.05) problems.push(`only ${visible} of ${count} Gaussians are visible (opacity)`);
  return {
    pass: problems.length === 0, problems, notes: [],
    measured: { count, bytesPerGaussian: stride, extent: Number(extent.toFixed(4)), visibleFraction: Number((visible / count).toFixed(3)) },
  };
}

/** Gaussian centres (x y z triples) of a binary PLY splat, for fitting the floor. Empty if unparseable. */
export function plyCentres(bytes: Uint8Array, maxPoints = 20000): Float32Array {
  const headEnd = findHeaderEnd(bytes);
  if (headEnd < 0) return new Float32Array(0);
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd)).split('\n').map((l) => l.trim());
  let count = 0, inVertex = false, stride = 0;
  const off: Record<string, number> = {};
  for (const line of header) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') { inVertex = parts[1] === 'vertex'; if (inVertex) count = Number(parts[2]); }
    else if (parts[0] === 'property' && inVertex) {
      const size = PLY_SIZES[parts[1]];
      if (!size) return new Float32Array(0);
      off[parts[2]] = stride; stride += size;
    }
  }
  if (!(count > 0) || off.x === undefined || off.y === undefined || off.z === undefined) return new Float32Array(0);
  count = Math.min(count, Math.floor((bytes.length - headEnd) / stride));
  const view = new DataView(bytes.buffer, bytes.byteOffset + headEnd, count * stride);
  const step = Math.max(1, Math.floor(count / maxPoints));
  const out: number[] = [];
  for (let i = 0; i < count; i += step) {
    const x = view.getFloat32(i * stride + off.x, true), y = view.getFloat32(i * stride + off.y, true), z = view.getFloat32(i * stride + off.z, true);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push(x, y, z);
  }
  return Float32Array.from(out);
}

/** An SPZ file after gunzip: magic 'NGSP', version, point count, then the packed Gaussians. */
export function judgeSplatSpzBytes(raw: Uint8Array): SplatCheck {
  const fail = (p: string): SplatCheck => ({ pass: false, problems: [p], notes: [], measured: {} });
  if (raw.length < 16) return fail('too short to be an SPZ file');
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(0, true) !== 0x5053474e) return fail('not an SPZ file (missing NGSP header after decompression)');
  const version = v.getUint32(4, true), count = v.getUint32(8, true);
  if (version < 1 || version > 4) return fail(`unsupported SPZ version ${version}`);
  if (!(count > 0)) return fail('no Gaussians');
  // 19 bytes is the floor per Gaussian (position 9, alpha 1, colour 3, scale 3, rotation 3).
  if (raw.length - 16 < count * 19) return fail(`truncated: ${raw.length - 16} bytes of body for ${count} Gaussians`);
  return { pass: true, problems: [], notes: ['SPZ is checked for header, count and length only; values are not decoded'], measured: { count, version } };
}

export type SplatKind = 'ply' | 'spz';

/** The extension decides the kind; anything else is refused with the reason. */
export function splatKindOf(filename: string): SplatKind | null {
  const m = /\.(ply|spz)$/i.exec(filename);
  return m ? (m[1].toLowerCase() as SplatKind) : null;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Judge a file chosen by the person. Never throws: a failure is a failed check with a reason. */
export async function judgeSplatFile(filename: string, bytes: Uint8Array): Promise<SplatCheck & { kind: SplatKind | null }> {
  const kind = splatKindOf(filename);
  if (!kind) return { kind, pass: false, problems: [`"${filename}" is not a .ply or .spz file`], notes: [], measured: {} };
  if (bytes.length === 0) return { kind, pass: false, problems: ['the file is empty'], notes: [], measured: {} };
  try {
    if (kind === 'ply') return { kind, ...judgeSplatPly(bytes) };
    return { kind, ...judgeSplatSpzBytes(await gunzip(bytes)) };
  } catch (e) {
    return { kind, pass: false, problems: [`could not read the file: ${(e as Error).message}`], notes: [], measured: {} };
  }
}
