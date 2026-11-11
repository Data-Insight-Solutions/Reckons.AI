#!/usr/bin/env npx tsx
/**
 * One generation job for the review story's pictures and scans (garden-story.ts SLOTS), run by the local
 * job queue. It calls the repository's own pipeline (generateStage in scripts/content/gen-assets.ts), so
 * every output comes with the receipt and the independent check that pipeline always writes; nothing is
 * installed or downloaded here, and a missing tool makes the job fail loudly instead of faking an output.
 *
 *   npx tsx scripts/review-spaces/generate-assets.ts --slot=north-lawn --stages=image,splat [--workspace=<dir>]
 *
 * Output: <workspace>/kbs/review-community-garden/assets/generated/<slot>/{image.webp, splat.ply, receipt.json}.
 * Then `build-garden.ts` copies them into the space and attaches the scans.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generationAvailability, generateStage, type Brief, type Stage } from '../content/gen-assets.js';
import * as S from './garden-story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const slot = S.SLOTS.find((s) => s.id === arg('slot'));
  if (!slot) { console.error(`unknown --slot; one of: ${S.SLOTS.map((s) => s.id).join(', ')}`); process.exit(2); }
  const stages = (arg('stages') ?? 'image').split(',') as Stage[];
  for (const st of stages) {
    const a = generationAvailability(st);
    if (!a.available) { console.error(`${st}: not set up here (${a.reason}); nothing was generated`); process.exit(3); }
  }
  const workspace = path.resolve(arg('workspace') ?? path.join(ROOT, 'reckons-workspace'));
  const dir = path.join(workspace, 'kbs', S.SLUG, 'assets', 'generated', slot.id);
  mkdirSync(dir, { recursive: true });
  const brief: Brief = { slug: slot.id, label: slot.splat?.label ?? slot.id, imagePrompt: slot.prompt, videoPrompt: '', seed: slot.seed, gaussians: 32768, role: 'node' };
  const rfile = path.join(dir, 'receipt.json');
  const receipt = existsSync(rfile) ? JSON.parse(readFileSync(rfile, 'utf8')) : { slug: slot.id, label: brief.label, role: 'node', generated: true, stages: {} };
  let failed = false;
  for (const stage of stages) {
    if (stage === 'splat' && !existsSync(path.join(dir, 'image.webp'))) { console.error('splat needs the picture first'); process.exit(4); }
    const r = await generateStage(stage, brief, dir);
    receipt.stages[stage] = r;
    writeFileSync(rfile, JSON.stringify(receipt, null, 2) + '\n');
    console.log(`${slot.id} / ${stage} … ${r.check.pass ? 'accepted' : 'REJECTED'} in ${r.durationS}s ${JSON.stringify(r.check.measured)}`);
    if (!r.check.pass) { failed = true; console.error(r.check.problems.join('; ')); }
  }
  process.exit(failed ? 1 : 0);
}
void main();
