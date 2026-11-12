#!/usr/bin/env npx tsx
/**
 * npm run scan:multi — one splat from SEVERAL captures of the same object (F58.9.19 / kb:multi-scan-reconstruction).
 *
 *   npm run scan:multi -- --capture <video | frames dir>[@from-to] --capture <...> [--keyframes-per-capture 100] --out <dir> [--steps 30000] [--box cx,cy,size]
 *
 * Matt's decided approach (2026-11-10): ONE COLMAP layout over the pooled frames of all captures, matched ACROSS captures,
 * so every capture shares one coordinate frame; then one splat. Per capture: a video goes through the object-aware keyframe
 * selector (scan:keyframes), a frames folder is used as given. Frames are pooled as <capture>__<n>.jpg; COLMAP gets one
 * camera PER capture; then scan:room's own train, crop, check and compress stages run on the pool.
 * `video@10-27` cuts seconds 10 to 27 of a recording as one capture (to test the pipeline from a single video).
 * A capture COLMAP leaves out of the main model FAILS the run, naming it. The receipt says which matcher ran and counts per capture.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectKeyframesCli } from './select-keyframes.js';
import { scanRoom } from './scan-room.js';
import { IMAGE_EXT, VIDEO_EXT } from './scan-room-lib.js';
import { captureNames, chooseMatcher, frameName, parseMultiArgs, type MultiArgs } from './scan-multi-lib.js';

export async function scanMulti(argv: string[]) {
  const args: MultiArgs = parseMultiArgs(argv);
  const out = resolve(args.out);
  const names = captureNames(args.captures);
  const pool = join(out, 'pool');
  rmSync(pool, { recursive: true, force: true });
  mkdirSync(pool, { recursive: true });

  const manifestCaptures: { name: string; source: string; keyframes: number; camera: string }[] = [];
  for (let i = 0; i < args.captures.length; i++) {
    const cap = args.captures[i], name = names[i];
    const path = resolve(cap.path);
    if (!existsSync(path)) throw new Error(`capture ${cap.raw}: no such path ${path}`);
    let files: string[];
    if (statSync(path).isDirectory()) {
      const imgs = readdirSync(path).filter((f) => IMAGE_EXT.test(f)).sort();
      if (!imgs.length) throw new Error(`capture ${name}: no .jpg/.png images in ${path}`);
      files = imgs.map((f) => join(path, f));
      console.log(`== capture ${name}: ${files.length} frames used as given`);
    } else if (VIDEO_EXT.test(path)) {
      const kf = join(out, 'captures', name);
      rmSync(kf, { recursive: true, force: true });
      mkdirSync(kf, { recursive: true });
      console.log(`== capture ${name}: keyframes from ${cap.raw}`);
      await selectKeyframesCli([path, '--out', kf, '--windows', String(args.keyframesPerCapture), ...(cap.fromS !== undefined ? ['--from', String(cap.fromS), '--to', String(cap.toS)] : []), ...args.passthrough]);
      files = readdirSync(kf).filter((f) => IMAGE_EXT.test(f)).sort().map((f) => join(kf, f));
    } else throw new Error(`capture ${cap.raw}: not a video or a folder of images`);
    if (files.length < 10) throw new Error(`capture ${name} has only ${files.length} frames; need at least 10 to register against the others`);
    files.forEach((f, n) => copyFileSync(f, join(pool, frameName(name, n + 1, f.split('.').pop()!.toLowerCase()))));
    manifestCaptures.push({ name, source: cap.raw.split('/').pop() as string, keyframes: files.length, camera: 'SIMPLE_RADIAL' });
  }

  const total = manifestCaptures.reduce((n, c) => n + c.keyframes, 0);
  const choice = chooseMatcher(total, process.env.RECKONS_COLMAP_VOCAB_TREE);
  console.log(`== pool: ${total} frames from ${names.length} captures; matcher ${choice.matcher} (${choice.reason})`);
  const manifest = join(out, 'multi-manifest.json');
  writeFileSync(manifest, JSON.stringify({ matcher: choice.matcher, matcherReason: choice.reason, vocabTree: process.env.RECKONS_COLMAP_VOCAB_TREE ?? null, captures: manifestCaptures }, null, 2) + '\n');
  return scanRoom([pool, '--out', out, '--steps', String(args.steps), `--captures-file=${manifest}`]);
}

if (process.argv[1] && /scan-multi\.ts$/.test(process.argv[1])) {
  scanMulti(process.argv.slice(2)).catch((e) => { console.error(`\nFAILED ${e.message}`); process.exit(1); });
}
