#!/usr/bin/env npx tsx
/**
 * npm run scan:synthetic — F58.9.19.6 (kb:fusion-synthetic-captures): render several separate captures of ONE object with
 * KNOWN camera poses in headless Blender, run scan:multi on them, and measure COLMAP's registration against the truth.
 *
 *   npx tsx scripts/content/synthetic-captures.ts [--captures 3] [--frames 48] [--seed 7] [--width 960 --height 540]
 *        [--samples 24] [--mesh model.glb --object-size 2.6] [--run-dir <dir>] [--no-render]
 *
 * Output goes OUTSIDE the repo (default ~/.local/state/reckons/synthetic-captures/<run>/). With --no-render and an existing
 * --run-dir the renders are reused. Exit 0 only when every capture joined one model AND each capture's median rotation error is at most MAX_MEDIAN_ROTATION_DEG (2 deg)
 * and median position error at most MAX_MEDIAN_POSITION_SHARE (5% of object size). Those two bars are PROPOSED STARTING VALUES from one good
 * run, not measured limits. Joining alone is not enough: a first attempt registered every frame and was still 31 degrees out.
 * The numbers are printed either way.
 * HONEST LIMIT: a rendered object has no motion blur, rolling shutter or sensor noise, so this is EASIER than filmed
 * video. It checks that pooling and joining are right; the ring videos remain the real test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanMulti } from './scan-multi.js';
import { formatMeasurement, judgeRun, MAX_MEDIAN_POSITION_SHARE, MAX_MEDIAN_ROTATION_DEG, measure, parseArgs, planCaptures, type RegisteredCamera, type TruePoses } from './synthetic-captures-lib.js';

const HERE = import.meta.dirname;
const GEN = process.env.RECKONS_GEN_HOME ?? join(homedir(), '.local/share/reckons/gen');
const PY = join(GEN, 'venv/bin/python');

function blenderBin(): string {
  for (const c of ['blender', '/snap/bin/blender', '/usr/bin/blender']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* try next */ }
  }
  throw new Error('Blender not found (snap install blender)');
}

export async function syntheticCaptures(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const run = resolve(a.runDir ?? join(homedir(), '.local/state/reckons/synthetic-captures', `${stamp}-seed${a.seed}`));
  mkdirSync(run, { recursive: true });
  const plans = planCaptures(a);
  const truthFile = join(run, 'poses.json');
  console.log(`== run ${run}`);

  if (a.render) {
    const bin = blenderBin();
    for (const p of plans) {
      const outDir = join(run, p.name);
      mkdirSync(outDir, { recursive: true });
      const spec = { ...p, objectSeed: a.seed, outDir, mesh: a.mesh ? resolve(a.mesh) : null };
      const specFile = join(run, `${p.name}.spec.json`);
      writeFileSync(specFile, JSON.stringify(spec));
      console.log(`== render ${p.name}: ${p.frames.length} frames, ${p.focalMm} mm, ${p.width}x${p.height}${p.harder ? ` (HARDER: ${p.harder})` : ''}`);
      execFileSync(bin, ['--background', '--factory-startup', '--python', join(HERE, 'synthetic_captures.py'), '--', specFile], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60 * 60 * 1000 });
      if (!existsSync(join(outDir, 'poses.json'))) throw new Error(`Blender wrote no poses.json for ${p.name}`);
    }
    const per = plans.map((p) => JSON.parse(readFileSync(join(run, p.name, 'poses.json'), 'utf8')));
    const truth: TruePoses & { seed: number; captures: unknown[] } = {
      seed: a.seed, objectSize: per[0].objectSize,
      captures: per.map((c, i) => ({ name: c.name, focalMm: c.focalMm, fPx: c.fPx, width: c.width, height: c.height, harder: plans[i].harder, frames: c.frames })),
    };
    writeFileSync(truthFile, JSON.stringify(truth, null, 1));
  }
  if (!existsSync(truthFile)) throw new Error(`no ${truthFile}; render first`);
  const truth = JSON.parse(readFileSync(truthFile, 'utf8')) as TruePoses;

  const scanOut = join(run, 'scan');
  if (a.render || !existsSync(join(scanOut, 'work', 'models.json'))) {
    const steps = String(a.steps); // registration is what is measured; the splat only has to train, not look good
    const caps = truth.captures.flatMap((c) => ['--capture', join(run, c.name)]);
    try { await scanMulti([...caps, '--out', scanOut, '--steps', steps]); } catch (e) { console.log(`scan:multi stopped: ${(e as Error).message}`); }
  }
  const modelsFile = join(scanOut, 'work', 'models.json');
  const sparse = join(scanOut, 'work', 'sparse', '0');
  let cameras: RegisteredCamera[] = [], models: string[][] = [];
  if (existsSync(modelsFile) && existsSync(sparse)) {
    models = (JSON.parse(readFileSync(modelsFile, 'utf8')) as { models: string[][] }).models;
    cameras = (JSON.parse(execFileSync(PY, ['-I', join(HERE, 'synthetic_export_poses.py'), sparse], { encoding: 'utf8', maxBuffer: 1 << 28 })) as { cameras: RegisteredCamera[] }).cameras;
  }
  const m = measure(truth, cameras, models);
  writeFileSync(join(run, 'measurement.json'), JSON.stringify(m, null, 2) + '\n');
  console.log(`\nMEASURED ${new Date().toISOString().slice(0, 10)}, rendered captures with known poses (easier than filmed video):`);
  console.log(formatMeasurement(m));
  const problems = judgeRun(m);
  for (const x of problems) console.log(`  FAIL ${x}`);
  console.log(problems.length ? 'RESULT: FAIL' : `RESULT: pass (median rotation <= ${MAX_MEDIAN_ROTATION_DEG} deg, median position <= ${MAX_MEDIAN_POSITION_SHARE * 100}% of object size)`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && /synthetic-captures\.ts$/.test(process.argv[1])) {
  syntheticCaptures(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`\nFAILED ${e.message}`); process.exit(2); });
}
