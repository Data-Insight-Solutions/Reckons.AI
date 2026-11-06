#!/usr/bin/env npx tsx
/**
 * `npm run demo:render -- --workflow=<id>` — F275: a narrated demo video rendered from a test workflow.
 *
 *   1. NARRATE  each step's kpred:narration becomes a clip: Matt's recording if one exists, else a
 *               cached synthesis, else a new one (scripts/demo/narration-plan.ts). Durations measured.
 *   2. RECORD   the workflow's own e2e test runs at 1920x1080 with video on; each step holds until its
 *               line ends (tests/e2e/demo-recorder.ts). Its assertions still run.
 *   3. MUX      clips placed at their steps' offsets, captions from the same text, H.264/AAC MP4
 *               (scripts/demo/mux.ts), and a receipt that says how to rebuild it.
 *
 * Flags:
 *   --workflow=<id>     kpred:workflow-id in static/docs-testing.ttl (required)
 *   --voice=<p:id>      override the workflow's kpred:narrator (provider-qualified, e.g. hume:<id>)
 *   --narrate-only      stop after step 1 (synthesize and cache the lines, nothing recorded)
 *   --burn-captions     burn the captions into the picture as well as writing the .vtt
 *
 * Everything written lives OUTSIDE the repository (XDG directories), because a render is output,
 * not source: recordings are large, and Matt's voice files are his.
 *   cache       $XDG_CACHE_HOME/reckons/demo-tts/<sha256>.mp3
 *   recordings  $XDG_DATA_HOME/reckons/demo-voice/<workflow>/<step>.wav   (override a line)
 *   output      <Videos>/reckons-demos/<workflow>/<timestamp>/   (xdg-user-dir VIDEOS; DEMO_OUT_DIR overrides)
 *
 * HUME ENDS ITS TTS API ON 2026-11-13 (kb:int-hume). A line cached before then keeps rendering; a new
 * or changed line after then needs another provider (F275.8). Until then a hume: voice needs
 * VITE_HUME_API_KEY (or HUME_API_KEY) in the environment or in .env.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { loadWorkflowsFromFile, ROOT, TESTING_TTL } from '../lib/test-workflow';
import { synthesizeHumeSpeech } from '../../src/lib/integrations/hume/tts';
import { holdMs, planNarration, type NarrationDeps } from './narration-plan';
import { assembleArgs, buildCues, buildReceipt, compressFilter, compressQuiet, ffmpegArgs, mapTime, shiftCues, toVtt, type Segment } from './mux';
import { cardHtml, endCardLines, renderCards } from './cards';
import type { DemoMarksFile } from '../../tests/e2e/demo-recorder';

const QUIET_CAP_MS = 5000; // a silence longer than this plays faster (at most 6x), see compressQuiet
const LEAD = '~lead';     // clip id suffix for a step's lead-in question
const TITLE_MS = 3500; // title card
const END_MS = 6000;   // end card with the credits
const DEFAULT_VOICE = 'hume:a623d3ed-612c-413b-b09f-e0a379a317f0'; // 'Warm Female Assistant Voice' (Matt, 2026-11-05)

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => process.argv.includes(`--${name}`);
const fail = (msg: string): never => { console.error(`demo:render: ${msg}`); process.exit(1); };

const xdg = (envName: string, fallback: string) => process.env[envName] || join(homedir(), fallback);
const CACHE_DIR = join(xdg('XDG_CACHE_HOME', '.cache'), 'reckons', 'demo-tts');
const VOICE_DIR = join(xdg('XDG_DATA_HOME', '.local/share'), 'reckons', 'demo-voice');
// Rendered videos go to the person's Videos folder, NOT a hidden directory: snap-packaged players
// (VLC on Ubuntu) cannot read hidden folders in home, and the first render, kept under
// ~/.local/share, would not open (2026-11-05). DEMO_OUT_DIR overrides.
function videosDir(): string {
  try {
    const d = execFileSync('xdg-user-dir', ['VIDEOS'], { encoding: 'utf8' }).trim();
    if (d && d !== homedir()) return d;
  } catch { /* not a desktop with xdg-user-dirs */ }
  return join(homedir(), 'Videos');
}
const OUT_ROOT = process.env.DEMO_OUT_DIR || join(videosDir(), 'reckons-demos');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Read one key from the environment, else from the repo's .env (never printed). */
function secret(...names: string[]): string | null {
  for (const n of names) if (process.env[n]?.trim()) return process.env[n]!.trim();
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && names.includes(m[1]) && m[2]) return m[2].replace(/^["']|["']$/g, '');
  }
  return null;
}

async function synth(text: string, voice: string): Promise<Uint8Array> {
  const [provider, id] = [voice.slice(0, voice.indexOf(':')), voice.slice(voice.indexOf(':') + 1)];
  if (provider !== 'hume') throw new Error(`no synthesizer for voice provider "${provider}" (F275.8 adds the next one)`);
  const key = secret('VITE_HUME_API_KEY', 'HUME_API_KEY');
  if (!key) throw new Error('a hume: voice needs VITE_HUME_API_KEY or HUME_API_KEY');
  const blob = await synthesizeHumeSpeech({ text, voiceId: id, auth: { header: 'X-Hume-Api-Key', value: key } });
  return new Uint8Array(await blob.arrayBuffer());
}

function probeMs(path: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  const s = parseFloat(out.trim());
  if (!Number.isFinite(s)) throw new Error(`ffprobe gave no duration for ${path}`);
  return Math.round(s * 1000);
}

function version(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return 'unknown'; }
}

function findVideo(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.webm') && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  if (existsSync(dir)) walk(dir);
  return best ? (best as { path: string }).path : null;
}

async function main() {
  const workflowId = arg('workflow') ?? fail('--workflow=<id> is required');
  const workflow = loadWorkflowsFromFile().find((w) => w.id === workflowId) ?? fail(`no workflow "${workflowId}" in ${relative(ROOT, TESTING_TTL)}`);
  const voice = arg('voice') ?? workflow.narrator ?? DEFAULT_VOICE;
  const steps = workflow.steps.map((s) => ({ id: s.id, narration: s.narration, lead: s.narrationLead }));
  // Each step may speak twice: a lead-in question as it begins, then its line at the key moment.
  const lines = steps.flatMap((s) => [...(s.lead ? [{ id: s.id + LEAD, narration: s.lead }] : []), { id: s.id, narration: s.narration }]);
  if (steps.every((s) => !s.narration)) fail(`workflow "${workflowId}" has no kpred:narration on any step; nothing to narrate`);

  // 1. NARRATE
  const deps: NarrationDeps = {
    overrideDir: VOICE_DIR,
    cacheDir: CACHE_DIR,
    exists: existsSync,
    readFile: (p) => new Uint8Array(readFileSync(p)),
    writeFile: (p, bytes) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); },
    synth,
    probeDurationMs: async (p) => probeMs(p),
  };
  const { clips, silent } = await planNarration(workflowId, lines, voice, deps);
  for (const c of clips) console.log(`  ${c.stepId.padEnd(18)} ${c.source.padEnd(11)} ${(c.durationMs / 1000).toFixed(1)} s`);
  if (silent.length) console.log(`  silent steps (minimum hold): ${silent.join(', ')}`);
  if (has('narrate-only')) { console.log(`narrated ${clips.length} line(s); cache ${CACHE_DIR}`); return; }

  // 2. RECORD
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(OUT_ROOT, workflowId, stamp);
  const pwOut = join(out, 'playwright');
  mkdirSync(pwOut, { recursive: true });
  const holds: Record<string, number> = {};
  const leads: Record<string, number> = {};
  for (const s of steps) {
    holds[s.id] = holdMs(clips.find((c) => c.stepId === s.id)?.durationMs ?? null);
    const lead = clips.find((c) => c.stepId === s.id + LEAD);
    if (lead) leads[s.id] = lead.durationMs;
  }
  const timings = join(out, 'timings.json');
  const marksPath = join(out, 'marks.json');
  writeFileSync(timings, JSON.stringify({ holds, leads }, null, 2));
  const pw = spawnSync('npx', ['playwright', 'test', '--config=playwright.demo.config.ts', workflow.testFile], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, DEMO_OUT: pwOut, DEMO_TIMINGS: timings, DEMO_MARKS: marksPath },
  });
  if (pw.status !== 0) fail(`the workflow test failed (exit ${pw.status}); a demo is not recorded of an app that fails its own test`);
  const video = findVideo(pwOut) ?? fail(`no recording under ${pwOut}`);
  const { marks, endedAtMs } = JSON.parse(readFileSync(marksPath, 'utf8')) as DemoMarksFile;

  // The video starts when the page opens, a little before the test body's clock; shift by that gap.
  const lead = Math.max(0, probeMs(video) - endedAtMs);
  const shifted = marks.map((m) => ({ ...m, startMs: m.startMs + lead, endMs: m.endMs + lead }));
  // Each line (and its caption) starts when the step's subject came on screen, not at the step's start.
  const rawSpoken = shifted.flatMap((m) => [
    ...(leads[m.stepId] ? [{ stepId: m.stepId + LEAD, startMs: m.startMs, endMs: m.startMs + leads[m.stepId] }] : []),
    { stepId: m.stepId, startMs: (m.speakMs ?? m.startMs - lead) + lead, endMs: m.endMs },
  ]);
  // Silences longer than the cap play faster: the pause stays, the clicking is fast-forwarded.
  const videoMs = probeMs(video);
  const talk = rawSpoken.map((x) => ({ fromMs: x.startMs, toMs: x.startMs + (clips.find((c) => c.stepId === x.stepId)?.durationMs ?? 0) }))
    .sort((a, b) => a.fromMs - b.fromMs);
  const quiet: { fromMs: number; toMs: number }[] = [];
  let cursor = 0;
  for (const t of talk) { if (t.fromMs > cursor) quiet.push({ fromMs: cursor, toMs: t.fromMs }); cursor = Math.max(cursor, t.toMs); }
  if (cursor < videoMs) quiet.push({ fromMs: cursor, toMs: videoMs });
  const segments: Segment[] = compressQuiet(videoMs, quiet, QUIET_CAP_MS);
  let picture = video;
  if (segments.some((g) => g.speed > 1)) {
    picture = join(out, 'compressed.mp4');
    const cp = spawnSync('ffmpeg', ['-y', '-i', video, '-filter_complex', compressFilter(segments), '-map', '[vc]', '-an', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', picture], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (cp.status !== 0) fail(`ffmpeg (fast-forward of long silences) failed (exit ${cp.status})`);
  }
  const spoken = rawSpoken.map((x) => ({ ...x, startMs: Math.round(mapTime(segments, x.startMs)), endMs: Math.round(mapTime(segments, x.endMs)) }));

  // 3. MUX
  const textByStep = Object.fromEntries(lines.filter((s) => s.narration).map((s) => [s.id, s.narration as string]));
  const cues = buildCues(spoken, clips, textByStep);
  const bodyVtt = join(out, 'body.vtt');
  writeFileSync(bodyVtt, toVtt(cues));
  const vtt = join(out, `${workflowId}.vtt`);
  writeFileSync(vtt, toVtt(shiftCues(cues, TITLE_MS)));
  const body = join(out, 'body.mp4');
  const mp4 = join(out, `${workflowId}.mp4`);
  const placed = clips.flatMap((c) => {
    const m = spoken.find((x) => x.stepId === c.stepId);
    return m ? [{ path: c.path, offsetMs: m.startMs }] : [];
  });
  const ff = spawnSync('ffmpeg', ffmpegArgs({ video: picture, clips: placed, out: body, ...(has('burn-captions') ? { burnVtt: bodyVtt } : {}) }), { stdio: ['ignore', 'ignore', 'inherit'] });
  if (ff.status !== 0) fail(`ffmpeg failed (exit ${ff.status})`);

  // Title and end cards; the end card carries every credit (F275: Hume narration is said on screen).
  const credits = buildReceipt({ workflow: workflowId, commit: '', graphSha256: '', renderedAt: '', marks: [], clips: clips.map((c) => ({ stepId: c.stepId, voice: c.voice, source: c.source, sha256: c.sha256 })), tools: {}, output: { file: '', sha256: '', durationMs: 0 } }).credits;
  const titleCard = { heading: workflow.title, lines: ['A Reckons.AI walkthrough, recorded from the app on made-up example data.'] };
  const endCard = { heading: 'Made on your own computer', lines: endCardLines(credits) };
  const titlePng = join(out, 'title.png');
  const endPng = join(out, 'end.png');
  await renderCards([{ html: cardHtml(titleCard, ROOT), out: titlePng }, { html: cardHtml(endCard, ROOT), out: endPng }]);
  const fin = spawnSync('ffmpeg', assembleArgs({ title: { png: titlePng, ms: TITLE_MS }, body, end: { png: endPng, ms: END_MS }, vtt, out: mp4 }), { stdio: ['ignore', 'ignore', 'inherit'] });
  if (fin.status !== 0) fail(`ffmpeg (title, body, end) failed (exit ${fin.status})`);

  const commit = version('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
  const dirty = version('git', ['-C', ROOT, 'status', '--porcelain', '--', 'static', 'src', 'tests', 'scripts']) !== '';
  const receipt = buildReceipt({
    workflow: workflowId,
    commit: dirty ? `${commit} (uncommitted changes)` : commit,
    graphSha256: sha256(new Uint8Array(readFileSync(TESTING_TTL))),
    renderedAt: new Date().toISOString(),
    marks: shifted.map((m) => ({ ...m, startMs: Math.round(mapTime(segments, m.startMs)) + TITLE_MS, endMs: Math.round(mapTime(segments, m.endMs)) + TITLE_MS })),
    clips: clips.map((c) => ({ stepId: c.stepId, voice: c.voice, source: c.source, sha256: c.sha256 })),
    tools: { ffmpeg: version('ffmpeg', ['-version']), playwright: version('npx', ['playwright', '--version']), node: process.version },
    output: { file: mp4, sha256: sha256(new Uint8Array(readFileSync(mp4))), durationMs: probeMs(mp4) },
  });
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ ...receipt, fastForward: segments.filter((g) => g.speed > 1).map((g) => ({ ...g, speed: Number(g.speed.toFixed(2)) })), cards: { title: { ...titleCard, ms: TITLE_MS }, end: { ...endCard, ms: END_MS } } }, null, 2));
  console.log(`\ndemo: ${mp4}\ncaptions: ${vtt}\nreceipt: ${join(out, 'receipt.json')}`);
  for (const c of receipt.credits) console.log(`credits: ${c}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
