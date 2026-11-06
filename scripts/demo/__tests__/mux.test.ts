import { describe, expect, it } from 'vitest';
import { buildCues, buildReceipt, ffmpegArgs, HUME_CREDIT, msToVtt, RECORDED_CREDIT, toVtt } from '../mux';

/** F275.4 — ffmpeg arguments, captions and the receipt, built without running ffmpeg. */
describe('captions', () => {
  it('formats VTT timestamps', () => {
    expect(msToVtt(3_723_004)).toBe('01:02:03.004');
    expect(msToVtt(0)).toBe('00:00:00.000');
  });
  it('makes one cue per narrated step with a mark, at the mark, as long as the clip', () => {
    const cues = buildCues(
      [{ stepId: 'b', startMs: 9000, endMs: 15000 }, { stepId: 'a', startMs: 1000, endMs: 8000 }, { stepId: 'c', startMs: 16000, endMs: 18000 }],
      [{ stepId: 'a', durationMs: 4000 }, { stepId: 'b', durationMs: 5000 }, { stepId: 'z', durationMs: 1 }],
      { a: 'First.', b: 'Second.', z: 'No mark.' },
    );
    expect(cues).toEqual([{ startMs: 1000, endMs: 5000, text: 'First.' }, { startMs: 9000, endMs: 14000, text: 'Second.' }]);
    expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nFirst.\n\n00:00:09.000 --> 00:00:14.000\nSecond.\n\n');
  });
});

describe('ffmpegArgs', () => {
  it('places each clip at its offset and mixes them over the video', () => {
    const a = ffmpegArgs({ video: 'v.webm', clips: [{ path: 'a.mp3', offsetMs: 1000 }, { path: 'b.mp3', offsetMs: 9000.4 }], out: 'o.mp4' });
    expect(a.slice(0, 7)).toEqual(['-y', '-i', 'v.webm', '-i', 'a.mp3', '-i', 'b.mp3']);
    expect(a[a.indexOf('-filter_complex') + 1]).toBe('[1:a]adelay=1000:all=1[a1];[2:a]adelay=9000:all=1[a2];[a1][a2]amix=inputs=2:normalize=0:duration=longest[aout]');
    expect(a).toContain('[aout]');
    expect(a.slice(-1)).toEqual(['o.mp4']);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac']));
  });
  it('skips the mix for one clip, drops audio for none, and can burn captions', () => {
    const one = ffmpegArgs({ video: 'v', clips: [{ path: 'a', offsetMs: 0 }], out: 'o' });
    expect(one[one.indexOf('-filter_complex') + 1]).toBe('[1:a]adelay=0:all=1[aout]');
    const none = ffmpegArgs({ video: 'v', clips: [], out: 'o', burnVtt: 'c.vtt' });
    expect(none).toContain('-an');
    expect(none).not.toContain('-c:a');
    expect(none[none.indexOf('-vf') + 1]).toBe('subtitles=c.vtt');
  });
});

describe('buildReceipt', () => {
  const base = {
    workflow: 'wf', commit: 'abc', graphSha256: 'g', renderedAt: '2026-11-05T00:00:00Z',
    marks: [{ stepId: 'a', startMs: 0, endMs: 3000 }, { stepId: 'b', startMs: 3000, endMs: 6000 }],
    tools: { ffmpeg: 'x' }, output: { file: 'o.mp4', sha256: 'h', durationMs: 6000 },
  };
  it('records every step, null for a silent one, and credits Hume when a Hume voice spoke', () => {
    const r = buildReceipt({ ...base, clips: [{ stepId: 'a', voice: 'hume:id', source: 'cache', sha256: 's' }] });
    expect(r.steps).toEqual([
      { stepId: 'a', startMs: 0, endMs: 3000, voice: 'hume:id', source: 'cache', clipSha256: 's' },
      { stepId: 'b', startMs: 3000, endMs: 6000, voice: null, source: null, clipSha256: null },
    ]);
    expect(r.credits).toEqual([HUME_CREDIT]);
    expect(Object.keys(r).sort()).toEqual(['commit', 'credits', 'graphSha256', 'output', 'renderedAt', 'steps', 'tools', 'workflow']);
  });
  it('credits a recording to the author and never credits Hume for another provider', () => {
    const r = buildReceipt({ ...base, clips: [{ stepId: 'a', voice: 'recorded', source: 'recorded', sha256: 's' }, { stepId: 'b', voice: 'local:magpie', source: 'synthesized', sha256: 't' }] });
    expect(r.credits).toEqual([RECORDED_CREDIT]);
  });
});

import { assembleArgs, shiftCues } from '../mux';
import { cardHtml, endCardLines } from '../cards';
import { resolve } from 'node:path';

describe('title, body and end assembly', () => {
  it('shifts captions by the title card', () => {
    expect(shiftCues([{ startMs: 1000, endMs: 2000, text: 'x' }], 3500)).toEqual([{ startMs: 4500, endMs: 5500, text: 'x' }]);
  });
  it('joins card, body, card over silence for the cards, with captions as a subtitle track', () => {
    const a = assembleArgs({ title: { png: 't.png', ms: 3500 }, body: 'b.mp4', end: { png: 'e.png', ms: 6000 }, vtt: 'c.vtt', out: 'o.mp4' });
    expect(a.slice(0, 7)).toEqual(['-y', '-loop', '1', '-t', '3.500', '-i', 't.png']);
    expect(a).toEqual(expect.arrayContaining(['-i', 'b.mp4', '-i', 'e.png', '-i', 'c.vtt', '-c:s', 'mov_text', '-map', '5:s']));
    expect(a[a.indexOf('-filter_complex') + 1]).toMatch(/\[v0\]\[3:a\]\[v1\]\[a1\]\[v2\]\[4:a\]concat=n=3:v=1:a=1\[v\]\[a\]$/);
    expect(a.slice(-1)).toEqual(['o.mp4']);
  });
  it('without captions maps no subtitle stream', () => {
    const a = assembleArgs({ title: { png: 't', ms: 1000 }, body: 'b', end: { png: 'e', ms: 1000 }, out: 'o' });
    expect(a).not.toContain('mov_text');
  });
});

describe('cards', () => {
  it('the end card carries every credit it is given, and the card escapes text', () => {
    const lines = endCardLines(['Narration voice made with Hume (hume.ai).']);
    expect(lines).toContain('Narration voice made with Hume (hume.ai).');
    const html = cardHtml({ heading: 'A <b> & C', lines }, resolve(import.meta.dirname, '../../..'));
    expect(html).toContain('A &lt;b&gt; &amp; C');
    expect(html).toContain('Narration voice made with Hume (hume.ai).');
    expect(html).toContain('<svg');
  });
});
