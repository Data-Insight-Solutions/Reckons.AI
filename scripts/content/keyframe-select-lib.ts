/**
 * F58.9.6.2 — object-aware keyframe selection: the pure parts (no ffmpeg, no files).
 *
 * The automatic selection in scan-room.ts scores a downscaled WHOLE frame, so for a small object on a busy
 * board it ranks frames by the board's texture. Here the score is the variance of the Laplacian on a region of
 * interest around the object; the timeline is split into windows so every stretch of the orbit keeps a frame;
 * the sharpest frame per window wins; near-duplicates and frames under a sharpness floor are refused.
 */

export interface Roi { cx: number; cy: number; size: number } // fractions of frame width / height; size is a fraction of WIDTH
export interface TrackPoint { t: number; x: number; y: number } // object centre, fractions of width / height

/** Variance of the 4-neighbour Laplacian over the interior of a greyscale image (higher = sharper). */
export function laplacianVariance(grey: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
      sum += l; sumSq += l * l; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Object centre at time t: linear interpolation along a sorted track, clamped at the ends. */
export function trackAt(track: TrackPoint[], t: number): { x: number; y: number } {
  if (track.length === 0) throw new Error('empty track');
  const s = [...track].sort((a, b) => a.t - b.t);
  if (t <= s[0].t) return { x: s[0].x, y: s[0].y };
  const last = s[s.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  let i = 1;
  while (s[i].t < t) i++;
  const a = s[i - 1], b = s[i];
  const k = (t - a.t) / (b.t - a.t || 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Pixel box (left, top, width, height) for a region of interest, kept fully inside the frame. */
export function roiBox(frameW: number, frameH: number, roi: Roi): { left: number; top: number; width: number; height: number } {
  const side = Math.max(8, Math.min(Math.round(roi.size * frameW), frameW, frameH));
  const left = Math.min(Math.max(Math.round(roi.cx * frameW - side / 2), 0), frameW - side);
  const top = Math.min(Math.max(Math.round(roi.cy * frameH - side / 2), 0), frameH - side);
  return { left, top, width: side, height: side };
}

/** Which of `windows` equal stretches of [0, duration] a time falls in. */
export function windowOf(t: number, duration: number, windows: number): number {
  return Math.min(windows - 1, Math.max(0, Math.floor((t / duration) * windows)));
}

/** Mean absolute difference between two equal-length signatures after removing each one's mean (0 = same look, 1 = opposite). */
export function signatureDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new Error('signatures differ in length');
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= a.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - ma - (b[i] - mb));
  return d / a.length / 255;
}

export interface Scored { index: number; t: number; score: number; signature: number[] }
export type Reason = 'kept' | 'not-best-in-window' | 'below-floor' | 'near-duplicate';
export interface Decision extends Omit<Scored, 'signature'> { window: number; kept: boolean; reason: Reason }
export interface SelectOptions {
  windows: number;
  duration: number;
  /** Frames scoring under floorRatio x the median score are refused (the floor protects against windows with only blurred frames). */
  floorRatio: number;
  /** A candidate closer than this (signatureDistance) to the previously kept frame is a near-duplicate. */
  duplicateDistance: number;
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per window, take the sharpest candidate that clears the floor and is not a near-duplicate of the previously
 * kept frame (windows are walked in time order). A window with nothing eligible keeps nothing: an empty window
 * in the report is a gap in coverage the person should know about, not one to paper over with a blurred frame.
 */
export function selectKeyframes(frames: Scored[], opt: SelectOptions): { decisions: Decision[]; floor: number; emptyWindows: number[] } {
  const floor = opt.floorRatio * median(frames.map((f) => f.score));
  const byWindow = new Map<number, Scored[]>();
  for (const f of frames) {
    const w = windowOf(f.t, opt.duration, opt.windows);
    (byWindow.get(w) ?? byWindow.set(w, []).get(w)!).push(f);
  }
  const decisions: Decision[] = [];
  const emptyWindows: number[] = [];
  let prev: Scored | null = null;
  for (let w = 0; w < opt.windows; w++) {
    const cands = (byWindow.get(w) ?? []).sort((a, b) => b.score - a.score);
    let chosen: Scored | null = null;
    const reasons = new Map<number, Reason>();
    for (const c of cands) {
      if (c.score < floor) reasons.set(c.index, 'below-floor');
      else if (prev && signatureDistance(c.signature, prev.signature) < opt.duplicateDistance) reasons.set(c.index, 'near-duplicate');
      else if (!chosen) chosen = c;
      else reasons.set(c.index, 'not-best-in-window');
    }
    for (const c of cands) {
      const kept = c === chosen;
      decisions.push({ index: c.index, t: c.t, score: c.score, window: w, kept, reason: kept ? 'kept' : (reasons.get(c.index) ?? 'not-best-in-window') });
    }
    if (chosen) prev = chosen; else emptyWindows.push(w);
  }
  decisions.sort((a, b) => a.index - b.index);
  return { decisions, floor, emptyWindows };
}
