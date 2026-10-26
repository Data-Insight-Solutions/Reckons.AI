/** Deterministic image fidelity for the synthetic room (kb:synthetic-room-benchmark).
 * RGB PSNR uses all pixels; SSIM is the mean of non-overlapping 8x8 luminance windows.
 * This named metric is deliberately fixed: changing its implementation needs a new version.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export const METRIC_VERSION = 'rgb-psnr-luma-block8-ssim-v1';
type Frame = { file_path: string; transform_matrix: number[][] };
type Transforms = { camera_angle_x: number; w: number; h: number; frames: Frame[] };
export type RoomManifest = {
  schema: number; scene: string; synthetic: boolean; generatorSha256: string; blender: string;
  seed: number; frames: number; samples: number; width: number; height: number; evalEvery: number;
};
export type Dataset = { manifest: RoomManifest; train: Transforms; test: Transforms; sha256: string };

export function validateDataset(manifest: RoomManifest, train: Transforms, test: Transforms): void {
  if (manifest.schema !== 1 || manifest.scene !== 'reckons-synthetic-room' || manifest.synthetic !== true)
    throw new Error('Expected a synthetic room benchmark dataset (ROOM_BENCHMARK=1)');
  if (!Number.isInteger(manifest.frames) || manifest.frames < 32 || manifest.evalEvery !== 8
    || !Number.isInteger(manifest.width) || manifest.width < 16
    || !Number.isInteger(manifest.height) || manifest.height < 16
    || !/^[a-f0-9]{64}$/.test(manifest.generatorSha256)) throw new Error('Invalid benchmark manifest');
  const seen = new Set<string>();
  for (const [name, split] of [['train', train], ['test', test]] as const) {
    if (split.w !== manifest.width || split.h !== manifest.height || !Number.isFinite(split.camera_angle_x)
      || split.camera_angle_x <= 0 || split.camera_angle_x >= Math.PI || !Array.isArray(split.frames) || !split.frames.length)
      throw new Error(`Invalid ${name} camera or empty split`);
    for (const frame of split.frames) {
      const match = /^f_(\d{4})\.png$/.exec(frame.file_path);
      const n = match ? Number(match[1]) : 0;
      if (!n || n > manifest.frames || seen.has(frame.file_path)) throw new Error('Invalid, duplicate or overlapping view');
      if (((n - 1) % 8 === 0) !== (name === 'test')) throw new Error('Training/evaluation split mismatch');
      seen.add(frame.file_path);
      const m = frame.transform_matrix;
      if (!Array.isArray(m) || m.length !== 4 || m.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((v) => !Number.isFinite(v))))
        throw new Error('Invalid camera pose');
    }
  }
  if (seen.size !== manifest.frames || train.camera_angle_x !== test.camera_angle_x) throw new Error('Incomplete or inconsistent dataset');
}

/** Hash the actual images AND camera/scene metadata, so changed views cannot compare as one benchmark. */
export async function readDataset(dir: string): Promise<Dataset> {
  const hash = createHash('sha256');
  const readJson = (name: string) => {
    const bytes = readFileSync(join(dir, name)); hash.update(name).update(bytes);
    return JSON.parse(bytes.toString());
  };
  const manifest = readJson('benchmark.json') as RoomManifest;
  const train = readJson('transforms_train.json') as Transforms;
  const test = readJson('transforms_test.json') as Transforms;
  validateDataset(manifest, train, test);
  // Brush prefers transforms.json / transforms_val.json if present, and searches recursively.
  // Never validate one split while letting the trainer silently load a different one.
  const allowed = new Set(['benchmark.json', 'transforms_train.json', 'transforms_test.json', 'render.log',
    ...train.frames.map((f) => f.file_path), ...test.frames.map((f) => f.file_path)]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !allowed.has(entry.name)) throw new Error(`Unexpected dataset entry: ${entry.name}`);
  }
  for (const frame of [...train.frames, ...test.frames].sort((a, b) => a.file_path.localeCompare(b.file_path))) {
    const bytes = readFileSync(join(dir, frame.file_path));
    const meta = await sharp(bytes).metadata();
    if (meta.width !== manifest.width || meta.height !== manifest.height) throw new Error(`Wrong reference dimensions: ${frame.file_path}`);
    hash.update(frame.file_path).update(bytes);
  }
  return { manifest, train, test, sha256: hash.digest('hex') };
}

export const psnr = (mse: number): number | null => mse === 0 ? null : 10 * Math.log10(255 ** 2 / mse);
export type Fidelity = { mse: number; psnrDb: number | null; ssim: number };

export function imageFidelity(reference: Uint8Array, rendered: Uint8Array, width: number, height: number): Fidelity {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || reference.length !== width * height * 3 || rendered.length !== reference.length) throw new Error('RGB dimensions do not match');
  let squared = 0;
  for (let i = 0; i < reference.length; i++) squared += (reference[i] - rendered[i]) ** 2;
  const mse = squared / reference.length;
  const luma = (rgb: Uint8Array, i: number) => 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let ssim = 0, windows = 0;
  for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
    let n = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0;
    for (let yy = y; yy < Math.min(y + 8, height); yy++) for (let xx = x; xx < Math.min(x + 8, width); xx++) {
      const i = (yy * width + xx) * 3, u = luma(reference, i), v = luma(rendered, i);
      n++; a += u; b += v; aa += u * u; bb += v * v; ab += u * v;
    }
    a /= n; b /= n;
    const va = Math.max(0, aa / n - a * a), vb = Math.max(0, bb / n - b * b), cov = ab / n - a * b;
    ssim += ((2 * a * b + c1) * (2 * cov + c2)) / ((a * a + b * b + c1) * (va + vb + c2));
    windows++;
  }
  return { mse, psnrDb: psnr(mse), ssim: ssim / windows };
}

export async function scoreViews(dataset: Dataset, referenceDir: string, renderedDir: string) {
  const views: (Fidelity & { file: string })[] = [];
  for (const frame of dataset.test.frames) {
    const decode = async (dir: string) => {
      const { data, info } = await sharp(join(dir, frame.file_path)).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== dataset.manifest.width || info.height !== dataset.manifest.height || info.channels !== 3)
        throw new Error(`Wrong evaluation dimensions: ${frame.file_path}; never resize to hide a mismatch`);
      return data;
    };
    const reference = await decode(referenceDir), rendered = await decode(renderedDir);
    views.push({ file: frame.file_path, ...imageFidelity(reference, rendered, dataset.manifest.width, dataset.manifest.height) });
  }
  const mse = views.reduce((n, v) => n + v.mse, 0) / views.length;
  return {
    metric: METRIC_VERSION, views,
    aggregate: { mse, psnrDb: psnr(mse), ssim: views.reduce((n, v) => n + v.ssim, 0) / views.length, worstSsim: Math.min(...views.map((v) => v.ssim)) },
  };
}

export function assertComparable(a: { datasetSha256: string; metric: string }, b: { datasetSha256: string; metric: string }): void {
  if (a.datasetSha256 !== b.datasetSha256 || a.metric !== b.metric) throw new Error('Not comparable: dataset bytes, poses, split or metric differ');
}
