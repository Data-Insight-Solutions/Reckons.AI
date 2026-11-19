#!/usr/bin/env npx tsx
/**
 * F299.1 + F299.2 — build a part from a spec, then show it.
 *
 *   npx tsx scripts/content/cad/run.ts --spec part.json [--out DIR] [--blender]
 *   npx tsx scripts/content/cad/run.ts --check DIR      re-verify a finished part's receipt
 *
 * build123d is an OPTIONAL local tool, like Blender: it lives in its own virtualenv outside this
 * repository (CAD_PYTHON, default $XDG_DATA_HOME/reckons/venvs/cad/bin/python) and nothing in the
 * app or CI depends on it. Output goes to $XDG_STATE_HOME/reckons/cad/<name>-<hash8>, outside the
 * repository. Python is run with an argv array, never a shell string.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { blenderBin, checkGlb, exportGlb, render, type Scene } from '../blender-render';
import { specToBuild123d } from './generate';
import { checkReceipt, fileRecord, type CadReceipt } from './receipt';
import { assertValidSpec, specSha256, type PartSpec } from './spec';

export function cadPython(): string {
  return process.env.CAD_PYTHON ?? path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local/share'), 'reckons/venvs/cad/bin/python');
}

export function cadAvailable(): boolean {
  const py = cadPython();
  if (!existsSync(py)) return false;
  try { execFileSync(py, ['-c', 'import build123d'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export function defaultOutDir(spec: PartSpec): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state');
  return path.join(state, 'reckons/cad', `${spec.name}-${specSha256(spec).slice(0, 8)}`);
}

/** Build STEP + STL from a spec and write the receipt. Throws when the CAD kernel fails or the
 *  receipt does not match the spec: a part that is not the one asked for is not an output. */
export function buildPart(spec: PartSpec, outDir = defaultOutDir(spec)): { receipt: CadReceipt; outDir: string } {
  assertValidSpec(spec);
  mkdirSync(outDir, { recursive: true });
  const script = specToBuild123d(spec);
  const scriptPath = path.join(outDir, 'part.py');
  writeFileSync(scriptPath, script);
  const stdout = execFileSync(cadPython(), [scriptPath, outDir], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const line = stdout.split('\n').find((l) => l.startsWith('RECEIPT_JSON:'));
  if (!line) throw new Error('build123d script printed no measurements');
  const m = JSON.parse(line.slice('RECEIPT_JSON:'.length));
  const receipt: CadReceipt = {
    schema: 1,
    spec,
    specSha256: specSha256(spec),
    scriptSha256: createHash('sha256').update(script).digest('hex'),
    tools: { build123d: m.build123d, ocp: m.ocp, python: m.python },
    volumeMm3: m.volume_mm3,
    bboxMm: m.bbox_mm,
    files: { step: fileRecord(outDir, 'part.step'), stl: fileRecord(outDir, 'part.stl') },
    origin: 'modelled from parameters',
    builtAt: new Date().toISOString(),
  };
  const problems = checkReceipt(receipt, outDir);
  writeReceipt(outDir, receipt);
  if (problems.length) throw new Error(`part does not match its spec: ${problems.join('; ')}`);
  return { receipt, outDir };
}

function writeReceipt(outDir: string, r: CadReceipt) {
  writeFileSync(path.join(outDir, 'cad-receipt.json'), JSON.stringify(r, null, 2) + '\n');
}

export const MATERIAL = { color: [0.72, 0.74, 0.78] as [number, number, number], metallic: 0.6, roughness: 0.4 };
/** Display scale: the STL is in millimetres; one scene unit = 100 mm keeps the part about 1 unit across. */
const DISPLAY_SCALE = 0.01;
export const TURNTABLE_FRAMES = 4;

/** F299.2: material, turntable frames and GLB through the existing headless Blender path. */
export function showPart(receipt: CadReceipt, outDir: string): CadReceipt {
  const stl = path.join(outDir, 'part.stl');
  const { x, y, z } = receipt.bboxMm;
  const reach = Math.max(x, y, z) * DISPLAY_SCALE;
  const objects = [{ shape: 'stl' as const, stl, scale: DISPLAY_SCALE, ...MATERIAL, color: MATERIAL.color }];
  const base: Scene = { objects, resolution: [480, 480], samples: 24, background: [0.12, 0.13, 0.16] };

  const frames: NonNullable<CadReceipt['blender']>['frames'] = [];
  for (let i = 0; i < TURNTABLE_FRAMES; i++) {
    const a = (i / TURNTABLE_FRAMES) * Math.PI * 2 + Math.PI / 5;
    const r = reach * 2.1;
    const file = path.join(outDir, `turntable-${i}.png`);
    const res = render({ ...base, camera: { location: [Math.cos(a) * r, Math.sin(a) * r, reach * 1.3], look_at: [0, 0, (z * DISPLAY_SCALE) / 2] } }, file);
    if (!res.ok) throw new Error(`turntable frame ${i} rejected: ${res.check.reason}`);
    frames.push({ ...fileRecord(outDir, `turntable-${i}.png`), variation: Number(res.check.variation.toFixed(3)) });
  }
  const glbPath = path.join(outDir, 'part.glb');
  const glb = exportGlb(base, glbPath);
  if (!glb.ok) throw new Error(`GLB rejected: ${glb.check.reason}`);

  const out: CadReceipt = {
    ...receipt,
    tools: { ...receipt.tools, blender: execFileSync(blenderBin(), ['--version'], { encoding: 'utf8' }).split('\n')[0].trim() },
    files: { ...receipt.files, glb: fileRecord(outDir, 'part.glb') },
    blender: { material: MATERIAL, glb: { meshes: glb.check.meshes, vertices: glb.check.vertices }, frames },
  };
  const problems = checkReceipt(out, outDir);
  writeReceipt(outDir, out);
  if (problems.length) throw new Error(`receipt check failed: ${problems.join('; ')}`);
  return out;
}

/** Copy the small, shippable subset (GLB, STEP, STL, first render frame, receipt) into the example's
 *  asset folder. The receipt is trimmed to the files that are copied, so the committed folder still
 *  verifies on its own. */
export function publishPart(receipt: CadReceipt, outDir: string, destRoot: string): string {
  if (!receipt.files.glb || !receipt.blender) throw new Error('run the Blender stage first (--blender)');
  const dest = path.join(destRoot, `cad-${receipt.spec.name}`);
  mkdirSync(dest, { recursive: true });
  const frame = receipt.blender.frames[0];
  for (const f of [receipt.files.step, receipt.files.stl, receipt.files.glb, frame]) copyFileSync(path.join(outDir, f.name), path.join(dest, f.name));
  const trimmed: CadReceipt = { ...receipt, blender: { ...receipt.blender, frames: [frame] } };
  const problems = checkReceipt(trimmed, dest);
  if (problems.length) throw new Error(`published copy does not verify: ${problems.join('; ')}`);
  writeFileSync(path.join(dest, 'cad-receipt.json'), JSON.stringify(trimmed, null, 2) + '\n');
  return dest;
}

function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const checkDir = arg('check');
  if (checkDir) {
    const r = JSON.parse(readFileSync(path.join(checkDir, 'cad-receipt.json'), 'utf8')) as CadReceipt;
    const problems = checkReceipt(r, checkDir);
    if (r.files.glb) { const g = checkGlb(path.join(checkDir, 'part.glb')); if (!g.ok) problems.push(g.reason); }
    console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : `OK ${r.spec.name} bbox ${JSON.stringify(r.bboxMm)} volume ${r.volumeMm3.toFixed(1)} mm3`);
    process.exit(problems.length ? 1 : 0);
  }
  const specFile = arg('spec');
  if (!specFile) { console.error('usage: run.ts --spec part.json [--out DIR] [--blender] | --check DIR'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as PartSpec;
  if (!cadAvailable()) { console.error(`build123d is not available at ${cadPython()} (optional local tool; see kb:cad-creation).`); process.exit(2); }
  let { receipt, outDir } = buildPart(spec, arg('out'));
  console.log(`built ${spec.name}: bbox ${JSON.stringify(receipt.bboxMm)} volume ${receipt.volumeMm3.toFixed(1)} mm3 -> ${outDir}`);
  if (process.argv.includes('--blender')) {
    receipt = showPart(receipt, outDir);
    const pub = arg('publish');
    if (pub) console.log(`published to ${publishPart(receipt, outDir, pub)}`);
    console.log(`shown: ${receipt.blender!.frames.length} frames, glb ${receipt.files.glb!.bytes} bytes, ${receipt.blender!.glb.vertices} vertices`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
