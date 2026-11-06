/**
 * F275.4 — what ffmpeg needs to join a demo's picture and sound, the captions, and the receipt.
 *
 * PURE: this builds arguments, cues and the receipt; scripts/demo/render.ts spawns ffmpeg. Captions
 * come from the same narration text that was spoken, at the same offsets, so they cannot drift
 * from the audio.
 */

/** Offsets from the start of the recorded video. */
export type Mark = { stepId: string; startMs: number; endMs: number };
export type Cue = { startMs: number; endMs: number; text: string };

export function buildCues(
  marks: Mark[],
  clips: { stepId: string; durationMs: number }[],
  textByStep: Record<string, string>,
): Cue[] {
  const cues: Cue[] = [];
  for (const clip of clips) {
    const mark = marks.find((m) => m.stepId === clip.stepId);
    const text = textByStep[clip.stepId];
    if (!mark || !text) continue;
    cues.push({ startMs: mark.startMs, endMs: mark.startMs + clip.durationMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export function msToVtt(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const frac = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(frac, 3)}`;
}

export function toVtt(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${msToVtt(c.startMs)} --> ${msToVtt(c.endMs)}\n${c.text}\n\n`).join('');
}

export function ffmpegArgs(o: {
  video: string;
  clips: { path: string; offsetMs: number }[];
  out: string;
  burnVtt?: string;
}): string[] {
  const args = ['-y', '-i', o.video];
  for (const c of o.clips) args.push('-i', c.path);
  if (o.clips.length) {
    const delays = o.clips.map((c, i) => {
      const off = Math.max(0, Math.round(c.offsetMs));
      return `[${i + 1}:a]adelay=${off}:all=1[${o.clips.length === 1 ? 'aout' : `a${i + 1}`}]`;
    });
    const graph = o.clips.length === 1
      ? delays[0]
      : `${delays.join(';')};${o.clips.map((_, i) => `[a${i + 1}]`).join('')}amix=inputs=${o.clips.length}:normalize=0:duration=longest[aout]`;
    args.push('-filter_complex', graph, '-map', '0:v', '-map', '[aout]');
  } else {
    args.push('-an');
  }
  if (o.burnVtt) args.push('-vf', `subtitles=${o.burnVtt}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20');
  if (o.clips.length) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(o.out);
  return args;
}

/** Shift every cue later by `ms` (the title card's length), so captions stay on their lines. */
export function shiftCues(cues: Cue[], ms: number): Cue[] {
  return cues.map((c) => ({ ...c, startMs: c.startMs + ms, endMs: c.endMs + ms }));
}

/**
 * The final assembly: title card, the narrated recording, end card, joined into one MP4, with the
 * captions as a subtitle track inside it (a separate .vtt does not travel through a chat app).
 * Cards are still images held for their length over silence. 25 fps, 48 kHz mono, H.264/AAC.
 */
export function assembleArgs(o: {
  title: { png: string; ms: number };
  body: string;
  end: { png: string; ms: number };
  vtt?: string;
  out: string;
}): string[] {
  const s = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
  const v = 'scale=1920:1080,setsar=1,fps=25,format=yuv420p';
  const args = [
    '-y',
    '-loop', '1', '-t', s(o.title.ms), '-i', o.title.png,
    '-i', o.body,
    '-loop', '1', '-t', s(o.end.ms), '-i', o.end.png,
    '-f', 'lavfi', '-t', s(o.title.ms), '-i', 'anullsrc=r=48000:cl=mono',
    '-f', 'lavfi', '-t', s(o.end.ms), '-i', 'anullsrc=r=48000:cl=mono',
  ];
  if (o.vtt) args.push('-i', o.vtt);
  args.push(
    '-filter_complex',
    `[0:v]${v}[v0];[1:v]${v}[v1];[2:v]${v}[v2];[1:a]aresample=48000,aformat=channel_layouts=mono[a1];` +
      '[v0][3:a][v1][a1][v2][4:a]concat=n=3:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
  );
  if (o.vtt) args.push('-map', '5:s', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', o.out);
  return args;
}

export type Receipt = {
  workflow: string;
  commit: string;
  graphSha256: string;
  renderedAt: string;
  steps: { stepId: string; startMs: number; endMs: number; voice: string | null; source: string | null; clipSha256: string | null }[];
  tools: Record<string, string>;
  output: { file: string; sha256: string; durationMs: number };
  credits: string[];
};

export const HUME_CREDIT = 'Narration voice made with Hume (hume.ai).';
export const RECORDED_CREDIT = 'Narration recorded by the author.';

export function buildReceipt(i: {
  workflow: string;
  commit: string;
  graphSha256: string;
  renderedAt: string;
  marks: Mark[];
  clips: { stepId: string; voice: string; source: string; sha256: string }[];
  tools: Record<string, string>;
  output: { file: string; sha256: string; durationMs: number };
}): Receipt {
  const steps = i.marks.map((m) => {
    const c = i.clips.find((x) => x.stepId === m.stepId);
    return { stepId: m.stepId, startMs: m.startMs, endMs: m.endMs, voice: c?.voice ?? null, source: c?.source ?? null, clipSha256: c?.sha256 ?? null };
  });
  const credits: string[] = [];
  // Credit by the voice's provider, so a later provider (F275.8) is never credited to Hume.
  if (i.clips.some((c) => c.source !== 'recorded' && c.voice.startsWith('hume:'))) credits.push(HUME_CREDIT);
  if (i.clips.some((c) => c.source === 'recorded')) credits.push(RECORDED_CREDIT);
  return { workflow: i.workflow, commit: i.commit, graphSha256: i.graphSha256, renderedAt: i.renderedAt, steps, tools: i.tools, output: i.output, credits };
}
