/**
 * npm run scan:keyframes — pick training frames from a video by how sharp the OBJECT is (F58.9.6.2).
 *
 *   npm run scan:keyframes -- <video> --out <dir> [--fps 30] [--windows 220] [--floor-ratio 0.5] [--dup 0.03]
 *       [--box cx,cy,size | --track track.json] [--height 1600] [--sheet-cell 150]
 *
 *   --box    object region as fractions: centre x, centre y, side as a fraction of frame width (default 0.5,0.5,0.45)
 *   --track  JSON [{ "t": seconds, "x": 0..1, "y": 0..1 }, ...]: the object's centre over time (interpolated), for an
 *            object that moves across the frame as the camera orbits. The object is not detected here; the person (or
 *            an agent) supplies where it is.
 * Writes <out>/f0001.jpg… (kept frames, capture order: a folder scan:room takes as is) and, in <out>/review/, report.json and contact
 * sheets (kept-sheet-NN.jpg, rejected-sheet-NN.jpg) showing each frame's object crop with its score.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { laplacianVariance, median, roiBox, selectKeyframes, trackAt, type Roi, type Scored, type TrackPoint } from './keyframe-select-lib.js';

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
}

async function contactSheet(items: { file: string; label: string; box: ReturnType<typeof roiBox> }[], cell: number, out: string) {
  const cols = 10, rows = Math.ceil(items.length / cols);
  const tiles = await Promise.all(items.map(async (it, i) => {
    const buf = await sharp(it.file).extract(it.box).resize(cell, cell).jpeg({ quality: 85 }).toBuffer();
    const label = Buffer.from(`<svg width="${cell}" height="16" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000a"/><text x="3" y="12" font-size="11" fill="#fff" font-family="monospace">${it.label}</text></svg>`);
    const tile = await sharp(buf).composite([{ input: label, top: cell - 16, left: 0 }]).jpeg().toBuffer();
    return { input: tile, left: (i % cols) * cell, top: Math.floor(i / cols) * cell };
  }));
  await sharp({ create: { width: cols * cell, height: rows * cell, channels: 3, background: '#222' } }).composite(tiles).jpeg({ quality: 80 }).toFile(out);
}

export async function selectKeyframesCli(argv: string[]) {
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(out|fps|windows|floor-ratio|dup|box|track|height|sheet-cell)$/.test(argv[i - 1])));
  const video = positional[0] && resolve(positional[0]);
  const outArg = arg(argv, 'out');
  if (!video || !existsSync(video) || !outArg) throw new Error('usage: npm run scan:keyframes -- <video> --out <dir> [--fps 30] [--windows 220] [--box cx,cy,size | --track file.json]');
  const out = resolve(outArg);
  const fps = Number(arg(argv, 'fps', '30'));
  const windows = Number(arg(argv, 'windows', '220'));
  const floorRatio = Number(arg(argv, 'floor-ratio', '0.5'));
  const duplicateDistance = Number(arg(argv, 'dup', '0.03'));
  const height = Number(arg(argv, 'height', '1600'));
  const cell = Number(arg(argv, 'sheet-cell', '150'));
  const trackFile = arg(argv, 'track');
  const track: TrackPoint[] | null = trackFile ? JSON.parse(readFileSync(resolve(trackFile), 'utf8')) : null;
  const [bx, by, bs] = (arg(argv, 'box', '0.5,0.5,0.45') as string).split(',').map(Number);
  const roi: Roi = { cx: bx, cy: by, size: bs };

  const work = join(out, '.work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', `fps=${fps},scale=-2:${height}`, '-q:v', '2', join(work, '%05d.jpg')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').slice(-400)}`);
  const files = readdirSync(work).filter((f) => f.endsWith('.jpg')).sort();
  const duration = files.length / fps;

  const scored: Scored[] = [];
  const boxes = new Map<number, ReturnType<typeof roiBox>>();
  for (let i = 0; i < files.length; i++) {
    const file = join(work, files[i]);
    const t = i / fps;
    const meta = await sharp(file).metadata();
    const c = track ? trackAt(track, t) : { x: roi.cx, y: roi.cy };
    const box = roiBox(meta.width!, meta.height!, { cx: c.x, cy: c.y, size: roi.size });
    boxes.set(i, box);
    const g = await sharp(file).extract(box).greyscale().raw().toBuffer({ resolveWithObject: true });
    const sig = await sharp(file).extract(box).greyscale().resize(16, 16).raw().toBuffer();
    scored.push({ index: i, t, score: laplacianVariance(g.data, g.info.width, g.info.height), signature: [...sig] });
  }

  const { decisions, floor, emptyWindows } = selectKeyframes(scored, { windows, duration, floorRatio, duplicateDistance });
  const kept = decisions.filter((d) => d.kept);
  kept.forEach((d, n) => copyFileSync(join(work, files[d.index]), join(out, `f${String(n + 1).padStart(4, '0')}.jpg`)));

  const sheetOf = async (list: typeof decisions, name: string) => {
    for (let s = 0; s * 100 < list.length; s++) {
      const part = list.slice(s * 100, s * 100 + 100);
      await contactSheet(part.map((d) => ({ file: join(work, files[d.index]), box: boxes.get(d.index)!, label: `${d.t.toFixed(2)}s ${d.score.toFixed(0)}${d.kept ? '' : ' ' + d.reason.slice(0, 8)}` })), cell, join(out, 'review', `${name}-sheet-${String(s + 1).padStart(2, '0')}.jpg`));
    }
  };
  // Sheets and the report go in review/, NOT beside the frames: scan:room takes every image in the folder as a frame.
  const review = join(out, 'review');
  mkdirSync(review, { recursive: true });
  await sheetOf(kept, 'kept');
  // Rejected sheet: the sharpest rejects, the ones a person is most likely to want back.
  await sheetOf([...decisions.filter((d) => !d.kept)].sort((a, b) => b.score - a.score).slice(0, 100).sort((a, b) => a.index - b.index), 'rejected');

  const keptScores = kept.map((d) => d.score);
  const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
  const report = {
    video: video.split('/').pop(), fps, height, windows, duration: Number(duration.toFixed(2)), floorRatio, floor: Number(floor.toFixed(1)), duplicateDistance,
    region: track ? { kind: 'track', points: track.length, size: roi.size } : { kind: 'box', ...roi },
    candidates: scored.length, kept: kept.length, emptyWindows,
    reasons: decisions.reduce<Record<string, number>>((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {}),
    keptScore: { min: q(keptScores, 0), p25: q(keptScores, 0.25), median: median(keptScores), p75: q(keptScores, 0.75), max: q(keptScores, 1) },
    allScoreMedian: median(scored.map((s) => s.score)),
    frames: decisions.map((d) => ({ index: d.index, t: Number(d.t.toFixed(3)), score: Number(d.score.toFixed(1)), window: d.window, kept: d.kept, reason: d.reason })),
  };
  writeFileSync(join(review, 'report.json'), JSON.stringify(report, null, 1));
  rmSync(work, { recursive: true, force: true });
  console.log(`${scored.length} candidates, ${kept.length} kept, ${emptyWindows.length} empty windows; kept score median ${report.keptScore.median.toFixed(0)}, floor ${floor.toFixed(0)}`);
  return report;
}

if (process.argv[1] && /select-keyframes\.ts$/.test(process.argv[1])) {
  selectKeyframesCli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
