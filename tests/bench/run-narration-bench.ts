#!/usr/bin/env npx tsx
/**
 * Narration benchmark (F275.8.3): Kokoro against Hume's open-source TADA on the demo's eleven lines.
 *
 *   npx tsx tests/bench/run-narration-bench.ts [--workflow=generated-assets] [--whisper=base] [--gpu=<n>]
 *        [--seed=<int>] [--arms=kokoro,tada-3b,tada-1b] [--out=<dir>]
 *
 * Arms: kokoro (the app's default voice, kokoro-js on CPU), tada-3b and tada-1b (voice-prompted from cached
 * 'Shelly V1' clips by tests/bench/tada_synth.py, run in the tada venv), hume-ref (the cached Hume clips,
 * copied, never regenerated). Everything is written OUTSIDE the repository:
 *   ~/.local/state/reckons/narration-bench/<ISO run>/  (README.txt in the folder says what each file is)
 *
 * Script tier: no model judges anything here. Whisper is only a transcriber; the word error rate is computed
 * by rule. A failing arm is recorded in results.json and the run continues.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowsFromFile } from '../../scripts/lib/test-workflow';
import { cacheKey } from '../../scripts/demo/narration-plan';
import { buildBlind, wer, type BenchLine } from './narration-bench-lib';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const HUME_VOICE = 'hume:a623d3ed-612c-413b-b09f-e0a379a317f0'; // 'Shelly V1', the voice the cached clips were made with
const KOKORO_VOICE = 'af_heart'; // DEFAULT_KOKORO_VOICE in src/lib/integrations/llm/voice-catalog.ts
const SR = 24000;
const xdg = (v: string, d: string) => process.env[v] ?? join(homedir(), d);
const CACHE_DIR = join(xdg('XDG_CACHE_HOME', '.cache'), 'reckons', 'demo-tts');
const VENV_PY = join(homedir(), '.local/share/reckons/venvs/tada/bin/python');
// The ~/.local/bin/whisper script is a stale 2023 stub (its python module is gone); this venv holds openai-whisper (CPU torch).
const WHISPER = join(homedir(), '.local/share/reckons/venvs/whisper/bin/whisper');
const HERE = new URL('.', import.meta.url).pathname;

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '-');

type ClipMetric = {
  arm: string; lineId: string; ok: boolean; error?: string;
  synthSeconds: number | null; durationSeconds: number | null; rtf: number | null; peakVramMiB: number | null;
  promptClip?: string; original?: string; wav?: string; mp3?: string; transcript?: string; wer?: number;
};

function ffprobeSeconds(p: string): number {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).trim());
}

/** Two-pass loudnorm to -16 LUFS / -1.5 dBTP, 24 kHz mono WAV, so arms differ in voice and not in volume. */
function normalize(src: string, dstWav: string, dstMp3: string): void {
  const target = 'I=-16:TP=-1.5:LRA=11';
  // ffmpeg prints the loudnorm JSON on stderr, which execFileSync drops on success, so capture it here.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr);
  if (!m) throw new Error(`loudnorm measure failed for ${src}`);
  const j = JSON.parse(m[0]);
  const filter = `loudnorm=${target}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', filter, '-ar', String(SR), '-ac', '1', dstWav]);
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', dstWav, '-b:a', '192k', dstMp3]);
}

function whisperAll(files: string[], model: string, outDir: string): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  run(WHISPER, [...files, '--model', model, '--language', 'en', '--output_format', 'json', '--output_dir', outDir, '--fp16', 'False', '--verbose', 'False']);
  const out: Record<string, string> = {};
  for (const f of files) {
    const base = f.split('/').pop()!.replace(/\.[^.]+$/, '');
    out[base] = (JSON.parse(readFileSync(join(outDir, `${base}.json`), 'utf8')).text as string).trim();
  }
  return out;
}

async function main() {
  const workflowId = arg('workflow') ?? 'generated-assets';
  const whisperModel = arg('whisper') ?? 'base';
  const gpu = arg('gpu');
  const seed = Number(arg('seed') ?? 20261117);
  const armsWanted = (arg('arms') ?? 'kokoro,tada-3b,tada-1b').split(',');
  const iso = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
  const OUT = arg('out') ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'reckons', 'narration-bench', iso);
  for (const d of ['orig', 'norm', 'web', 'blind', 'transcripts', 'tmp']) mkdirSync(join(OUT, d), { recursive: true });

  const wf = loadWorkflowsFromFile().find((w) => w.id === workflowId);
  if (!wf) throw new Error(`no workflow "${workflowId}"`);
  const lines: (BenchLine & { main: boolean })[] = wf.steps.flatMap((s) => [
    ...(s.narrationLead ? [{ id: `${s.id}~lead`, text: s.narrationLead.trim(), main: false }] : []),
    ...(s.narration ? [{ id: s.id, text: s.narration.trim(), main: true }] : []),
  ]);
  console.log(`${lines.length} lines (${lines.filter((l) => l.main).length} main, ${lines.filter((l) => !l.main).length} lead-ins)`);
  const metrics: ClipMetric[] = [];
  const armInfo: Record<string, unknown> = {};

  const finish = (m: ClipMetric, original: string) => {
    const name = `${m.arm}__${safe(m.lineId)}`;
    m.original = original;
    m.wav = join(OUT, 'norm', `${name}.wav`);
    m.mp3 = join(OUT, 'web', `${name}.mp3`);
    normalize(original, m.wav, m.mp3);
    m.durationSeconds = ffprobeSeconds(m.wav);
    if (m.synthSeconds != null) m.rtf = Number((m.synthSeconds / m.durationSeconds).toFixed(3));
  };

  // ── hume-ref: the cached clips, copied ──
  for (const l of lines) {
    const src = join(CACHE_DIR, `${cacheKey(HUME_VOICE, l.text)}.mp3`);
    const m: ClipMetric = { arm: 'hume-ref', lineId: l.id, ok: existsSync(src), synthSeconds: null, durationSeconds: null, rtf: null, peakVramMiB: null };
    if (m.ok) { const dst = join(OUT, 'orig', `hume-ref__${safe(l.id)}.mp3`); copyFileSync(src, dst); finish(m, dst); }
    else m.error = 'not in the narration clip cache';
    metrics.push(m);
  }
  armInfo['hume-ref'] = { voice: HUME_VOICE, note: 'copied from the local narration clip cache, not regenerated' };

  // ── pick the voice prompts: cleanest main-line Hume clips (lowest WER, then closest to 10 s) ──
  const humeOk = metrics.filter((m) => m.arm === 'hume-ref' && m.ok);
  const humeTx = whisperAll(humeOk.map((m) => m.wav!), whisperModel, join(OUT, 'transcripts'));
  for (const m of humeOk) {
    m.transcript = humeTx[`hume-ref__${safe(m.lineId)}`];
    m.wer = wer(lines.find((l) => l.id === m.lineId)!.text, m.transcript);
  }
  const ranked = humeOk.filter((m) => lines.find((l) => l.id === m.lineId)!.main)
    .sort((a, b) => a.wer! - b.wer! || Math.abs(a.durationSeconds! - 10) - Math.abs(b.durationSeconds! - 10));
  const [p1, p2] = ranked;
  if (!p1 || !p2) throw new Error('need two main-line Hume clips to use as voice prompts');
  const promptWav = (m: ClipMetric) => {
    const w = join(OUT, 'tmp', `prompt-${safe(m.lineId)}.wav`);
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', m.original!, '-ar', String(SR), '-ac', '1', w]);
    return w;
  };
  const prompts = [p1, p2].map((m) => ({ id: m.lineId, wav: promptWav(m), text: lines.find((l) => l.id === m.lineId)!.text }));
  armInfo.promptSelection = { primary: p1.lineId, secondary: p2.lineId, rule: 'main-line hume-ref clips ranked by lowest Whisper WER, then duration closest to 10 s; the secondary prompt is used for the line that is the primary prompt, so no line is both prompt and test' };

  // ── kokoro ──
  if (armsWanted.includes('kokoro')) {
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const t0 = Date.now();
      const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' as never });
      armInfo.kokoro = { voice: KOKORO_VOICE, dtype: 'q8', device: 'cpu (kokoro-js in Node)', loadSeconds: (Date.now() - t0) / 1000 };
      for (const l of lines) {
        const m: ClipMetric = { arm: 'kokoro', lineId: l.id, ok: false, synthSeconds: null, durationSeconds: null, rtf: null, peakVramMiB: null };
        try {
          const s = Date.now();
          const a = await tts.generate(l.text, { voice: KOKORO_VOICE as never });
          m.synthSeconds = (Date.now() - s) / 1000;
          const raw = join(OUT, 'tmp', `kokoro-${safe(l.id)}.f32`);
          writeFileSync(raw, Buffer.from(a.audio.buffer, a.audio.byteOffset, a.audio.byteLength));
          const dst = join(OUT, 'orig', `kokoro__${safe(l.id)}.wav`);
          run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(a.sampling_rate ?? SR), '-ac', '1', '-i', raw, dst]);
          finish(m, dst); m.ok = true;
        } catch (e) { m.error = (e as Error).message; }
        metrics.push(m);
      }
    } catch (e) { armInfo.kokoro = { error: (e as Error).message }; for (const l of lines) metrics.push({ arm: 'kokoro', lineId: l.id, ok: false, error: (e as Error).message, synthSeconds: null, durationSeconds: null, rtf: null, peakVramMiB: null }); }
  }

  // ── TADA ──
  const tadaModels: Record<string, string> = { 'tada-3b': 'HumeAI/tada-3b-ml', 'tada-1b': 'HumeAI/tada-1b' };
  for (const arm of armsWanted.filter((a) => a in tadaModels)) {
    const resultPath = join(OUT, 'tmp', `${arm}-result.json`);
    const job = {
      model: tadaModels[arm], result: resultPath, prompts,
      items: lines.map((l) => ({ id: l.id, text: l.text, prompt: l.id === p1.lineId ? p2.lineId : p1.lineId, out: join(OUT, 'orig', `${arm}__${safe(l.id)}.wav`) })),
    };
    writeFileSync(join(OUT, 'tmp', `${arm}-job.json`), JSON.stringify(job));
    const env = { ...process.env, ...(gpu !== undefined ? { CUDA_VISIBLE_DEVICES: gpu } : {}) };
    try {
      run(VENV_PY, ['-I', join(HERE, 'tada_synth.py'), join(OUT, 'tmp', `${arm}-job.json`)], env);
    } catch (e) {
      const msg = ((e as { stderr?: string }).stderr ?? (e as Error).message).slice(-1500);
      armInfo[arm] = { error: msg };
      for (const l of lines) metrics.push({ arm, lineId: l.id, ok: false, error: 'synthesis process failed; see arm error', synthSeconds: null, durationSeconds: null, rtf: null, peakVramMiB: null });
      continue;
    }
    const res = JSON.parse(readFileSync(resultPath, 'utf8'));
    armInfo[arm] = { model: res.model, device: res.device, torch: res.torch, loadSeconds: res.load_seconds, cudaVisibleDevices: gpu ?? null, errors: res.errors };
    for (const l of lines) {
      const it = res.items.find((x: { id: string }) => x.id === l.id);
      const m: ClipMetric = { arm, lineId: l.id, ok: !!it, synthSeconds: it?.wall_seconds ?? null, durationSeconds: null, rtf: null, peakVramMiB: it?.peak_vram_mib ?? null, promptClip: it?.prompt };
      if (it) { try { finish(m, join(OUT, 'orig', `${arm}__${safe(l.id)}.wav`)); } catch (e) { m.ok = false; m.error = (e as Error).message; } }
      else m.error = res.errors.find((x: { id: string }) => x.id === l.id)?.error ?? 'no output';
      metrics.push(m);
    }
  }

  // ── Whisper on everything not yet transcribed ──
  const todo = metrics.filter((m) => m.ok && m.wav && m.transcript === undefined);
  if (todo.length) {
    const tx = whisperAll(todo.map((m) => m.wav!), whisperModel, join(OUT, 'transcripts'));
    for (const m of todo) {
      m.transcript = tx[`${m.arm}__${safe(m.lineId)}`];
      m.wer = wer(lines.find((l) => l.id === m.lineId)!.text, m.transcript);
    }
  }

  // ── summary per arm ──
  const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)) : null; };
  const arms = ['kokoro', 'tada-3b', 'tada-1b', 'hume-ref'];
  const summary = Object.fromEntries(arms.filter((a) => metrics.some((m) => m.arm === a)).map((a) => {
    const ms = metrics.filter((m) => m.arm === a);
    return [a, { clips: ms.filter((m) => m.ok).length, failures: ms.filter((m) => !m.ok).length, meanRtf: mean(ms.map((m) => m.rtf)), peakVramMiB: ms.some((m) => m.peakVramMiB != null) ? Math.max(...ms.map((m) => m.peakVramMiB ?? 0)) : null, meanWer: mean(ms.map((m) => m.wer)), meanSeconds: mean(ms.map((m) => m.durationSeconds)) }];
  }));
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({
    date: new Date().toISOString(), workflow: workflowId, whisperModel, loudness: 'loudnorm two-pass, I=-16 LUFS, TP=-1.5 dBTP, 24 kHz mono', seed,
    lines: lines.map((l) => ({ id: l.id, text: l.text, main: l.main })), arms: armInfo, summary, clips: metrics,
  }, null, 2));

  // ── blind manifest: only lines where every blind arm produced a clip ──
  const blindArms = arms.filter((a) => a !== 'hume-ref' && metrics.some((m) => m.arm === a && m.ok));
  const have = (id: string, a: string) => metrics.some((m) => m.arm === a && m.lineId === id && m.ok);
  const complete = lines.filter((l) => blindArms.every((a) => have(l.id, a)) && have(l.id, 'hume-ref'));
  const { blind, key } = buildBlind(complete, blindArms,
    () => '', (id) => `web/hume-ref__${safe(id)}.mp3`, seed);
  // File names are filled in here, after the labels are known; they carry only the line id and the label.
  const keyFor = (id: string) => key.entries.find((e) => e.lineId === id)!.labels;
  for (const e of blind.entries) for (const c of e.clips) {
    const arm = keyFor(e.lineId)[c.label];
    const rel = `blind/${safe(e.lineId)}__${c.label}.mp3`;
    copyFileSync(join(OUT, 'web', `${arm}__${safe(e.lineId)}.mp3`), join(OUT, rel));
    c.file = rel;
  }
  writeFileSync(join(OUT, 'blind.json'), JSON.stringify(blind, null, 2));
  writeFileSync(join(OUT, 'key.json'), JSON.stringify(key, null, 2));
  writeFileSync(join(OUT, 'README.txt'), [
    'Narration benchmark, Kokoro against Hume TADA (F275.8.3). Do NOT open key.json before ranking.',
    'blind.json   per line: the line text, the hume-ref clip, and clips under labels A/B/C (no arm names). Listen with this file.',
    'key.json     label -> arm for every line. Separate on purpose; open it only after the ranking is recorded.',
    'results.json every metric: per clip synth seconds, real-time factor, peak VRAM, duration, Whisper transcript, WER; per-arm summary and versions.',
    'orig/        each clip as synthesized (WAV; hume-ref MP3 as cached).',
    'norm/        loudness-matched copies, -16 LUFS, -1.5 dBTP, 24 kHz mono WAV.',
    'web/         the same as 192k MP3, named <arm>__<line>.mp3 (arm names visible: not for blind listening).',
    'blind/       the MP3s under opaque names <line>__<label>.mp3.',
    'transcripts/ Whisper JSON per clip.   tmp/ job files and voice prompts.',
    `Run: ${new Date().toISOString()}  seed: ${seed}  whisper: ${whisperModel}`,
    `Blind arms: ${blindArms.join(', ')}; lines in the manifest: ${complete.length} of ${lines.length}.`,
  ].join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`run folder: ${OUT}`);
  // A run where a requested arm failed is not a passed run. The queue reads the exit code, and on 2026-11-17
  // a run whose two TADA arms both failed exited 0 and was recorded as passed.
  const failedArms = armsWanted.filter((a) => {
    const ms = metrics.filter((m) => m.arm === a);
    return ms.length === 0 || ms.some((m) => !m.ok);
  });
  if (failedArms.length) {
    console.error(`FAILED arms: ${failedArms.join(', ')} (see results.json); the clips that did render are kept`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
