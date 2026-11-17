/**
 * F299.1 / F299.2 — the receipt of a built part, and the check that compares it to the spec.
 *
 * The receipt records what was asked (spec and its hash), what built it (tool versions), what
 * came out (volume, bounding box measured by the CAD kernel, file hashes) and, after the Blender
 * stage, the GLB and render frames. `checkReceipt` is a rule, not a judgement: it fails loudly on
 * a wrong size, a missing or changed file, or an impossible volume.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { expectedBbox, specSha256, validateSpec, type PartSpec } from './spec';

export const BBOX_TOLERANCE_MM = 0.1;

export interface FileRecord { name: string; sha256: string; bytes: number }

export interface CadReceipt {
  schema: 1;
  spec: PartSpec;
  specSha256: string;
  scriptSha256: string;
  tools: { build123d: string; ocp: string; python: string; blender?: string };
  volumeMm3: number;
  bboxMm: { x: number; y: number; z: number };
  files: { step: FileRecord; stl: FileRecord; glb?: FileRecord };
  blender?: {
    material: { color: [number, number, number]; metallic: number; roughness: number };
    glb: { meshes: number; vertices: number };
    frames: Array<FileRecord & { variation: number }>;
  };
  /** How the part came to be. A CAD part is modelled from parameters, never scanned. */
  origin: 'modelled from parameters';
  builtAt: string;
}

export const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function fileRecord(dir: string, name: string): FileRecord {
  const buf = readFileSync(path.join(dir, name));
  return { name, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

/**
 * Compare a receipt to its spec and (when `dir` is given) to the files on disk.
 * Returns the problems; an empty list means the part is what the spec said.
 */
export function checkReceipt(r: CadReceipt, dir?: string): string[] {
  const problems: string[] = [];
  const specProblems = validateSpec(r.spec);
  if (specProblems.length) return [`receipt carries an invalid spec: ${specProblems.join('; ')}`];
  if (specSha256(r.spec) !== r.specSha256) problems.push('specSha256 does not match the spec in the receipt');
  if (r.origin !== 'modelled from parameters') problems.push(`origin must be "modelled from parameters", not ${JSON.stringify(r.origin)}`);

  const want = expectedBbox(r.spec);
  for (const axis of ['x', 'y', 'z'] as const) {
    const got = r.bboxMm?.[axis];
    if (typeof got !== 'number' || !Number.isFinite(got)) { problems.push(`bounding box ${axis} missing`); continue; }
    if (Math.abs(got - want[axis]) > BBOX_TOLERANCE_MM) {
      problems.push(`bounding box ${axis} is ${got.toFixed(3)} mm, spec says ${want[axis]} mm (tolerance ${BBOX_TOLERANCE_MM} mm)`);
    }
  }
  const boxVolume = want.x * want.y * want.z;
  if (!(r.volumeMm3 > 0)) problems.push(`volume ${r.volumeMm3} mm3 is not positive`);
  else if (r.volumeMm3 > boxVolume * 1.001) problems.push(`volume ${r.volumeMm3.toFixed(1)} mm3 exceeds its own bounding box (${boxVolume.toFixed(1)} mm3)`);

  if (dir) {
    const files = [r.files.step, r.files.stl, ...(r.files.glb ? [r.files.glb] : []), ...(r.blender?.frames ?? [])];
    for (const f of files) {
      const p = path.join(dir, f.name);
      if (!existsSync(p)) { problems.push(`${f.name} is missing`); continue; }
      if (sha256File(p) !== f.sha256) problems.push(`${f.name} differs from the hash in the receipt`);
    }
  }
  return problems;
}
