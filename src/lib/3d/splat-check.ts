/**
 * Splat file acceptance checks (F58.9.1 / F58.9.7).
 *
 * One implementation for two callers: scripts/content/asset-checks.ts (the generation pipeline's
 * independent check) and the browser's "Import a scan", which refuses a file that fails here with
 * the reason shown. The tool's or the exporter's say-so is not evidence; the bytes are.
 *
 * A reconstructed room is big (measured on the scan:room lane, 2026-10-14: 102 MB and 432,501
 * Gaussians at Brush's default 30k steps, 21 MB and 88k at 3k steps). So the PLY check never needs
 * the whole file in memory: it reads the header, then walks the body in chunks (a ByteSource), and
 * keeps only running totals. The same code judges a small in-memory buffer.
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

/** Something that can be read a range at a time: an in-memory buffer, or a File on disk. */
export interface ByteSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (a, b) => bytes.subarray(a, Math.min(b, bytes.length)) };
}

/** A Blob or File, read in slices so the whole file is never held as one buffer. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (a, b) => {
      const part = blob.slice(a, Math.min(b, blob.size));
      const buf = typeof part.arrayBuffer === 'function' ? await part.arrayBuffer() : await new Response(part).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header\n');
  const limit = Math.min(bytes.length - marker.length, 64 * 1024);
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    return i + marker.length;
  }
  return -1;
}

interface PlyLayout { headEnd: number; count: number; stride: number; props: { name: string; type: string; offset: number }[] }

function parsePlyHeader(head: Uint8Array): PlyLayout | string {
  const headEnd = findHeaderEnd(head);
  if (headEnd < 0) return 'no PLY header (end_header not found)';
  const header = new TextDecoder().decode(head.subarray(0, headEnd)).split('\n').map((l) => l.trim());
  if (header[0] !== 'ply') return 'not a PLY file';
  if (!header.includes('format binary_little_endian 1.0')) return 'only binary_little_endian PLY is checked';
  let count = 0, inVertex = false, stride = 0;
  const props: PlyLayout['props'] = [];
  for (const line of header) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') { inVertex = parts[1] === 'vertex'; if (inVertex) count = Number(parts[2]); }
    else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') return 'list properties are not a 3DGS layout';
      const size = PLY_SIZES[parts[1]];
      if (!size) return `unknown property type ${parts[1]}`;
      props.push({ name: parts[2], type: parts[1], offset: stride });
      stride += size;
    }
  }
  return { headEnd, count, stride, props };
}

const CHUNK_BYTES = 4 * 1024 * 1024;

/** Walk the Gaussians of a PLY in chunks, calling `visit` with a view positioned at each chunk. */
async function walkPly(src: ByteSource, lay: PlyLayout, visit: (view: DataView, first: number, n: number) => void) {
  const per = Math.max(1, Math.floor(CHUNK_BYTES / lay.stride));
  for (let i = 0; i < lay.count; i += per) {
    const n = Math.min(per, lay.count - i);
    const chunk = await src.read(lay.headEnd + i * lay.stride, lay.headEnd + (i + n) * lay.stride);
    visit(new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength), i, n);
  }
}

/** Judge a binary little-endian 3DGS PLY, reading it in chunks. */
export async function judgePlySource(src: ByteSource, expect?: { count?: number }): Promise<SplatCheck> {
  const fail = (p: string): SplatCheck => ({ pass: false, problems: [p], notes: [], measured: {} });
  const lay = parsePlyHeader(await src.read(0, 64 * 1024 + 16));
  if (typeof lay === 'string') return fail(lay);
  const { count, stride, props, headEnd } = lay;
  const problems: string[] = [];
  const missing = REQUIRED_SPLAT_PROPS.filter((p) => !props.some((q) => q.name === p));
  if (missing.length) problems.push(`missing properties: ${missing.join(', ')}`);
  if (!(count > 0)) problems.push('no Gaussians');
  if (expect?.count && count !== expect.count) problems.push(`${count} Gaussians, expected ${expect.count}`);
  const body = src.size - headEnd;
  if (body < count * stride) problems.push(`truncated: ${body} bytes of body for ${count} x ${stride}`);
  if (problems.length) return { pass: false, problems, notes: [], measured: { count } };

  const off = (n: string) => props.find((p) => p.name === n)!.offset;
  const floatProps = props.filter((p) => p.type === 'float' || p.type === 'float32');
  const [ox, oy, oz, oo] = [off('x'), off('y'), off('z'), off('opacity')];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let nonFinite = 0, visible = 0;
  await walkPly(src, lay, (view, _first, n) => {
    for (let i = 0; i < n; i++) {
      const base = i * stride;
      for (const p of floatProps) if (!Number.isFinite(view.getFloat32(base + p.offset, true))) { nonFinite++; break; }
      const xyz = [view.getFloat32(base + ox, true), view.getFloat32(base + oy, true), view.getFloat32(base + oz, true)];
      for (let k = 0; k < 3; k++) { if (xyz[k] < min[k]) min[k] = xyz[k]; if (xyz[k] > max[k]) max[k] = xyz[k]; }
      // Opacity is stored as a logit; sigmoid > 0.05 is a Gaussian a viewer would actually draw.
      if (1 / (1 + Math.exp(-view.getFloat32(base + oo, true))) > 0.05) visible++;
    }
  });
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (nonFinite) problems.push(`${nonFinite} Gaussian(s) with non-finite values`);
  if (!(extent > 1e-4)) problems.push(`degenerate extent ${extent}`);
  if (visible < count * 0.05) problems.push(`only ${visible} of ${count} Gaussians are visible (opacity)`);
  return {
    pass: problems.length === 0, problems, notes: [],
    measured: { count, bytesPerGaussian: stride, extent: Number(extent.toFixed(4)), visibleFraction: Number((visible / count).toFixed(3)) },
  };
}

/** Synchronous twin of judgePlySource for buffers already in memory (the generation pipeline). Same checks, same messages. */
export function judgeSplatPly(bytes: Uint8Array, expect?: { count?: number }): SplatCheck {
  const fail = (p: string): SplatCheck => ({ pass: false, problems: [p], notes: [], measured: {} });
  const lay = parsePlyHeader(bytes);
  if (typeof lay === 'string') return fail(lay);
  const { count, stride, props, headEnd } = lay;
  const problems: string[] = [];
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
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let nonFinite = 0, visible = 0;
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    for (const p of floatProps) if (!Number.isFinite(view.getFloat32(base + p.offset, true))) { nonFinite++; break; }
    const xyz = [view.getFloat32(base + ox, true), view.getFloat32(base + oy, true), view.getFloat32(base + oz, true)];
    for (let k = 0; k < 3; k++) { if (xyz[k] < min[k]) min[k] = xyz[k]; if (xyz[k] > max[k]) max[k] = xyz[k]; }
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

/** Sampled Gaussian centres (x y z triples) of a PLY, for fitting the floor, read in chunks. Empty if unparseable. */
export async function plyCentresFromSource(src: ByteSource, maxPoints = 20000): Promise<Float32Array> {
  const lay = parsePlyHeader(await src.read(0, 64 * 1024 + 16));
  if (typeof lay === 'string') return new Float32Array(0);
  const off = (n: string) => lay.props.find((p) => p.name === n)?.offset;
  const [ox, oy, oz] = [off('x'), off('y'), off('z')];
  if (!(lay.count > 0) || ox === undefined || oy === undefined || oz === undefined) return new Float32Array(0);
  const count = Math.min(lay.count, Math.floor((src.size - lay.headEnd) / lay.stride));
  const step = Math.max(1, Math.floor(count / maxPoints));
  const out: number[] = [];
  await walkPly(src, { ...lay, count }, (view, first, n) => {
    for (let i = (step - (first % step)) % step; i < n; i += step) {
      const x = view.getFloat32(i * lay.stride + ox, true), y = view.getFloat32(i * lay.stride + oy, true), z = view.getFloat32(i * lay.stride + oz, true);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push(x, y, z);
    }
  });
  return Float32Array.from(out);
}

/** In-memory convenience over plyCentresFromSource. */
export const plyCentres = (bytes: Uint8Array, maxPoints = 20000) => plyCentresFromSource(bytesSource(bytes), maxPoints);

/** An SPZ file after gunzip: magic 'NGSP', version, point count, then the packed Gaussians. */
export function judgeSplatSpzBytes(raw: Uint8Array, totalLength = raw.length): SplatCheck {
  const fail = (p: string): SplatCheck => ({ pass: false, problems: [p], notes: [], measured: {} });
  if (totalLength < 16 || raw.length < 16) return fail('too short to be an SPZ file');
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(0, true) !== 0x5053474e) return fail('not an SPZ file (missing NGSP header after decompression)');
  const version = v.getUint32(4, true), count = v.getUint32(8, true);
  if (version < 1 || version > 4) return fail(`unsupported SPZ version ${version}`);
  if (!(count > 0)) return fail('no Gaussians');
  // 19 bytes is the floor per Gaussian (position 9, alpha 1, colour 3, scale 3, rotation 3).
  if (totalLength - 16 < count * 19) return fail(`truncated: ${totalLength - 16} bytes of body for ${count} Gaussians`);
  return { pass: true, problems: [], notes: ['SPZ is checked for header, count and length only; values are not decoded'], measured: { count, version } };
}

export type SplatKind = 'ply' | 'spz';

/** The extension decides the kind; anything else is refused with the reason. */
export function splatKindOf(filename: string): SplatKind | null {
  const m = /\.(ply|spz)$/i.exec(filename);
  return m ? (m[1].toLowerCase() as SplatKind) : null;
}

/** Decompress a gzip stream keeping only the first 16 bytes and the total length: no whole-file buffer. */
async function gunzipHeader(body: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; total: number }> {
  const reader = body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const head = new Uint8Array(16);
  let have = 0, total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (have < 16) { const take = Math.min(16 - have, value.length); head.set(value.subarray(0, take), have); have += take; }
    total += value.length;
  }
  return { head: head.subarray(0, have), total };
}

/** Judge a file chosen by the person. Never throws: a failure is a failed check with a reason. */
export async function judgeSplatFile(filename: string, file: Blob | Uint8Array): Promise<SplatCheck & { kind: SplatKind | null }> {
  const kind = splatKindOf(filename);
  const size = file instanceof Uint8Array ? file.length : file.size;
  if (!kind) return { kind, pass: false, problems: [`"${filename}" is not a .ply or .spz file`], notes: [], measured: {} };
  if (size === 0) return { kind, pass: false, problems: ['the file is empty'], notes: [], measured: {} };
  try {
    if (kind === 'ply') return { kind, ...(await judgePlySource(file instanceof Uint8Array ? bytesSource(file) : blobSource(file))) };
    const body = (file instanceof Uint8Array ? new Response(file as BodyInit).body : typeof file.stream === 'function' ? file.stream() : new Response(file).body)!;
    const { head, total } = await gunzipHeader(body as ReadableStream<Uint8Array>);
    return { kind, ...judgeSplatSpzBytes(head, total) };
  } catch (e) {
    return { kind, pass: false, problems: [`could not read the file: ${(e as Error).message}`], notes: [], measured: {} };
  }
}
