#!/usr/bin/env npx tsx
/**
 * Compress a Gaussian splat PLY (F58.9.11 / kb:splat-compression).
 *
 *   npm run splat:compress -- <in.ply> [--format spz|sog] [--out file]
 *
 * The converter is @playcanvas/splat-transform (MIT), a pinned devDependency used by host scripts
 * only: it never ships to the browser, which loads the result with the renderer's own SPZ/SOG decoder.
 *
 * BOTH FORMATS ARE LOSSY. SPZ (Niantic, MIT) quantises positions, scales, rotations and colour;
 * SOG (PlayCanvas) additionally clusters the colour and spherical-harmonic data into palettes. The
 * receipt says `lossy: true` and the check below is a decode, not a promise: the compressed file is
 * converted BACK to a PLY with the same tool and must have the same Gaussian count, finite values,
 * and an extent within 2% of the source. That proves the file decodes to the same room; it does NOT
 * measure how different it looks (the F58.9.11 trial did that separately, by rendering both).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { judgeSplatPly, type SplatCheck } from '../../src/lib/3d/splat-check';

export type CompressFormat = 'spz' | 'sog';
/**
 * SPZ by default, from the F58.9.11 measurements (kb:splat-compression): on 760,719 Gaussians SPZ took
 * 4.5 s on the CPU (17.5 MB) while SOG on the CPU did not finish in over 3 hours; SOG with a GPU took
 * 9 s and was 26% smaller (12.9 MB). A default that can take hours is not a default, so SOG is opt-in
 * and needs a GPU named in RECKONS_SPLAT_GPU (the splat-transform adapter index, see --list-gpus).
 */
export const DEFAULT_FORMAT: CompressFormat = 'spz';
/** No conversion should take longer than this; SOG on a CPU would. */
const TRANSFORM_TIMEOUT_MS = 15 * 60 * 1000;

export interface CompressedReceipt {
  format: CompressFormat;
  lossy: true;
  file: string;
  sha256: string;
  bytes: number;
  /** Source PLY bytes divided by compressed bytes. */
  ratio: number;
  source: { file: string; sha256: string; bytes: number; gaussians: number; extent: number };
  gaussians: number;
  extent: number;
  tool: { name: 'splat-transform'; license: 'MIT'; version: string };
  /** The decode check: count equal, values finite, extent within tolerance. */
  check: { pass: boolean; problems: string[]; measured: Record<string, number | string> };
  durationS: number;
}

export const EXTENT_TOLERANCE = 0.02;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function transformBin(): { cmd: string; version: string } {
  // The package's `exports` hides package.json, so find it by path.
  const dir = resolve(import.meta.dirname, '../../node_modules/@playcanvas/splat-transform');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> | string };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  return { cmd: join(dir, bin), version: pkg.version };
}

/**
 * Run splat-transform. CPU by default (no GPU contention, seconds for everything except SOG). SOG
 * encoding is GPU work: pass `gpu` (an adapter index) or it is refused rather than left to run for hours on a CPU.
 */
function transform(args: string[], gpu?: string): void {
  const { cmd } = transformBin();
  execFileSync(process.execPath, [cmd, '--quiet', '--overwrite', '--gpu', gpu ?? 'cpu', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout: TRANSFORM_TIMEOUT_MS });
}

/** Reduce a PLY for shipping: drop spherical harmonics above `shDegree` and/or decimate to `maxGaussians` (adaptive). */
export function reducePly(src: string, out: string, opts: { shDegree?: number; maxGaussians?: number }): void {
  const args = [src];
  if (opts.shDegree !== undefined) args.push('--filter-harmonics', String(opts.shDegree));
  if (opts.maxGaussians) args.push('--decimate-adaptive', String(opts.maxGaussians));
  transform([...args, out]);
}

/**
 * Crop a PLY to a box (the robust box of its own centres, see src/lib/3d/robust-extent.ts), dropping
 * the floaters outside it. Lossless for the Gaussians that stay: the same tool rewrites them as PLY.
 */
export function cropPly(src: string, out: string, box: { min: number[]; max: number[] }, maxScale?: number): void {
  const args = [src, '--filter-box', [...box.min, ...box.max].map((v) => v.toPrecision(9)).join(',')];
  // Also drop Gaussians bigger than maxScale on any axis (linear scale, file units): they are the streaks, not the surfaces.
  if (maxScale) for (const k of [0, 1, 2]) args.push('--filter-value', `scale_${k},lt,${maxScale.toPrecision(6)}`);
  transform([...args, out]);
}

/** Decode a compressed splat back to PLY bytes with the same tool, for the check. */
export function decodeToPly(file: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'splat-decode-'));
  try {
    const out = join(dir, 'decoded.ply');
    transform([file, out]);
    return new Uint8Array(readFileSync(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Pure judgement: does a decoded copy describe the same room as its source? */
export function judgeCompressed(source: SplatCheck, decoded: SplatCheck): { pass: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!source.pass) problems.push(`source splat failed its own check: ${source.problems.join('; ')}`);
  if (!decoded.pass) problems.push(`compressed file does not decode to a valid splat: ${decoded.problems.join('; ')}`);
  if (problems.length) return { pass: false, problems };
  const n0 = Number(source.measured.count), n1 = Number(decoded.measured.count);
  if (n0 !== n1) problems.push(`${n1} Gaussians after compression, ${n0} before`);
  const e0 = Number(source.measured.rawExtent ?? source.measured.extent), e1 = Number(decoded.measured.rawExtent ?? decoded.measured.extent);
  if (!(Math.abs(e1 - e0) <= EXTENT_TOLERANCE * e0)) problems.push(`extent ${e1} after compression, ${e0} before (more than ${EXTENT_TOLERANCE * 100}% apart)`);
  return { pass: problems.length === 0, problems };
}

export function compressSplat(plyPath: string, opts: { format?: CompressFormat; out?: string } = {}): CompressedReceipt {
  const format = opts.format ?? DEFAULT_FORMAT;
  const src = resolve(plyPath);
  if (!/\.ply$/i.test(src) || !existsSync(src)) throw new Error(`not a PLY file: ${plyPath}`);
  const out = resolve(opts.out ?? src.replace(/\.ply$/i, `.${format}`));
  if (!out.endsWith(`.${format}`)) throw new Error(`--out must end in .${format}`);
  const t = Date.now();
  const srcBytes = new Uint8Array(readFileSync(src));
  const source = judgeSplatPly(srcBytes);
  if (!source.pass) throw new Error(`${basename(src)} is not a usable splat: ${source.problems.join('; ')}`);
  let gpu: string | undefined;
  if (format === 'sog') {
    gpu = process.env.RECKONS_SPLAT_GPU;
    if (gpu === undefined || gpu === 'cpu') throw new Error('SOG encoding needs a GPU (on the CPU it did not finish in over 3 hours on 760k Gaussians). Set RECKONS_SPLAT_GPU to an adapter index from `splat-transform --list-gpus`, or use --format spz.');
  }
  transform([src, out], gpu);
  const decoded = judgeSplatPly(decodeToPly(out));
  const verdict = judgeCompressed(source, decoded);
  const bytes = readFileSync(out);
  const rawExtent = Number(source.measured.rawExtent ?? source.measured.extent);
  return {
    format, lossy: true, file: basename(out), sha256: sha256(bytes), bytes: bytes.length,
    ratio: Number((srcBytes.length / bytes.length).toFixed(2)),
    source: { file: basename(src), sha256: sha256(srcBytes), bytes: srcBytes.length, gaussians: Number(source.measured.count), extent: rawExtent },
    gaussians: Number(decoded.measured.count), extent: Number(decoded.measured.rawExtent ?? decoded.measured.extent),
    tool: { name: 'splat-transform', license: 'MIT', version: transformBin().version },
    check: { ...verdict, measured: decoded.measured },
    durationS: Number(((Date.now() - t) / 1000).toFixed(1)),
  };
}

/** Re-verify a committed compressed file against the receipt that describes it. */
export function verifyCompressed(dir: string, r: Pick<CompressedReceipt, 'file' | 'sha256' | 'gaussians' | 'extent' | 'bytes'>): string[] {
  const file = join(dir, r.file);
  if (!existsSync(file)) return [`${r.file} missing`];
  const problems: string[] = [];
  const bytes = readFileSync(file);
  if (sha256(bytes) !== r.sha256) problems.push(`${r.file} differs from its receipt`);
  if (bytes.length !== r.bytes) problems.push(`${r.file} is ${bytes.length} bytes, receipt says ${r.bytes}`);
  try {
    const d = judgeSplatPly(decodeToPly(file));
    if (!d.pass) problems.push(...d.problems);
    else {
      if (Number(d.measured.count) !== r.gaussians) problems.push(`${r.file} decodes to ${d.measured.count} Gaussians, receipt says ${r.gaussians}`);
      const e = Number(d.measured.rawExtent ?? d.measured.extent);
      if (!(Math.abs(e - r.extent) <= EXTENT_TOLERANCE * r.extent)) problems.push(`${r.file} extent ${e}, receipt says ${r.extent}`);
    }
  } catch (e) { problems.push(`${r.file} could not be decoded: ${(e as Error).message.split('\n')[0]}`); }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const flag = (n: string) => { const i = a.findIndex((x) => x === `--${n}` || x.startsWith(`--${n}=`)); return i < 0 ? undefined : a[i].includes('=') ? a[i].split('=')[1] : a[i + 1]; };
  const input = a.find((x, i) => !x.startsWith('--') && !/^--(format|out)$/.test(a[i - 1] ?? ''));
  if (!input) { console.error('usage: npm run splat:compress -- <in.ply> [--format spz|sog] [--out file]'); process.exit(2); }
  const format = (flag('format') ?? DEFAULT_FORMAT) as CompressFormat;
  if (format !== 'spz' && format !== 'sog') { console.error('--format must be spz or sog'); process.exit(2); }
  try {
    const r = compressSplat(input, { format, out: flag('out') });
    console.log(`${r.source.file} ${(r.source.bytes / 1e6).toFixed(2)} MB -> ${r.file} ${(r.bytes / 1e6).toFixed(2)} MB (${r.ratio}x, ${format}, lossy), ${r.gaussians} Gaussians, extent ${r.extent}, ${r.durationS}s`);
    if (!r.check.pass) { console.error(`CHECK FAILED: ${r.check.problems.join('; ')}`); process.exit(1); }
    console.log(`decode check passed: ${JSON.stringify(r.check.measured)}`);
  } catch (e) { console.error(`FAILED ${(e as Error).message}`); process.exit(1); }
}
