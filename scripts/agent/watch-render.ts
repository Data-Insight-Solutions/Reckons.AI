/**
 * agent:watch decoration and thresholds — the PURE parts (F74.7). No I/O except loadThresholds().
 *
 * Matt, 2026-09-30: "make it more pretty with console art Reckons.AI and cute turtle … thresholds
 * turning text yellow and red." Data always wins over decoration: art is dropped when the terminal
 * is narrower than the art, and the turtle's mood is DERIVED from the same levels that colour the
 * numbers, so the face can never disagree with the text.
 *
 * Shelly is a turtle (TurtleChatPanel, the "turtle companion" in settings/turtle, "name it after your
 * turtle"), so the mascot is a turtle. WEAKNESS: the repo has no sprite or logo for her, so this is a
 * new hand-made drawing, not the app's artwork. QUEUE LENGTH has a threshold and a classifier but
 * nothing feeds it: runner.ts has no side-effect-free queue reader (see watch.ts header).
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Level = 'ok' | 'warn' | 'bad';
export type Band = { yellow: number; red: number };
export type Thresholds = {
  /** GPU utilization, percent. */
  gpuUtil: Band;
  /** VRAM used / total per GPU, percent. */
  vramPct: Band;
  /** Model latency in seconds (applied to p50 of today and to the last request). */
  latencySec: Band;
  /** Running job's elapsed time as a multiple of that job's previous median duration. */
  jobElapsedRatio: Band;
  /** Failed runs in the last hour (all jobs). */
  failuresLastHour: Band;
  /** Queue length. Classifier only; see the header. */
  queueLength: Band;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  gpuUtil: { yellow: 85, red: 98 },
  vramPct: { yellow: 85, red: 95 },
  latencySec: { yellow: 30, red: 120 },
  jobElapsedRatio: { yellow: 1.5, red: 3 },
  failuresLastHour: { yellow: 1, red: 3 },
  queueLength: { yellow: 5, red: 15 },
};

export const configPath = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'reckons', 'watch.json');

/** Override defaults per metric; ignores anything not a finite number or a known metric. Pure. */
export function mergeThresholds(over: unknown, base: Thresholds = DEFAULT_THRESHOLDS): Thresholds {
  const out: Thresholds = JSON.parse(JSON.stringify(base));
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(out) as (keyof Thresholds)[]) {
    const o = (over as Record<string, unknown>)[k] as Partial<Band> | undefined;
    if (!o || typeof o !== 'object') continue;
    if (typeof o.yellow === 'number' && Number.isFinite(o.yellow)) out[k].yellow = o.yellow;
    if (typeof o.red === 'number' && Number.isFinite(o.red)) out[k].red = o.red;
  }
  return out;
}

export function loadThresholds(file: string = configPath()): Thresholds {
  try {
    return mergeThresholds(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return mergeThresholds(undefined);
  }
}

/** value >= red is bad, >= yellow is warn. NaN/undefined is ok (unknown is not an alarm). Pure. */
export function classify(value: number | undefined, band: Band): Level {
  if (value === undefined || Number.isNaN(value)) return 'ok';
  return value >= band.red ? 'bad' : value >= band.yellow ? 'warn' : 'ok';
}

/** yellow at max-1 (one more failure opens the breaker), red at max or an open circuit. */
export function attemptLevel(attempt: number, max: number, circuitOpen = false): Level {
  return circuitOpen || attempt >= max ? 'bad' : attempt >= max - 1 && max > 1 ? 'warn' : 'ok';
}

export const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Elapsed vs this job's own previous median; unknown (no history) is ok. Pure. */
export function elapsedLevel(elapsedMs: number, previousMedianMs: number | undefined, band: Band): Level {
  return previousMedianMs && previousMedianMs > 0 ? classify(elapsedMs / previousMedianMs, band) : 'ok';
}

export const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');

export const LEGEND = 'green ok · yellow watch · red act now — limits: ~/.config/reckons/watch.json';

// ── art ────────────────────────────────────────────────────────────────────

const GLYPHS: Record<string, string[]> = {
  R: ['█▀█', '█▀▄', '▀ ▀'],
  e: ['▄▀▄', '█▀▀', '▀▄▄'],
  c: ['▄▀▀', '█  ', '▀▄▄'],
  k: ['█ █', '█▀▄', '▀ ▀'],
  o: ['▄▀▄', '█ █', '▀▄▀'],
  n: ['█▀▄', '█ █', '▀ ▀'],
  s: ['▄▀▀', '▀▀▄', '▄▄▀'],
  '.': [' ', ' ', '▄'],
  A: ['▄▀▄', '█▀█', '▀ ▀'],
  I: ['█', '█', '█'],
};

/** "Reckons.AI" in 3-row half-block letters. */
export function banner(text = 'Reckons.AI'): string[] {
  return [0, 1, 2].map((row) => [...text].map((ch) => (GLYPHS[ch] ?? ['?', '?', '?'])[row]).join(' '));
}

export const FACES: Record<Level, string> = { ok: '^‿^', warn: 'o_o', bad: 'O_O' };
const FLIPPERS: [string, string][] = [['/', '\\'], ['_', '\\'], ['_', '_'], ['/', '_']];
export const TURTLE_FRAMES = FLIPPERS.length;

/** Frame n of the swim cycle (any integer, wraps), face by mood. Three rows, equal width. */
export function turtle(frame: number, mood: Level): string[] {
  const [a, b] = FLIPPERS[((frame % TURTLE_FRAMES) + TURTLE_FRAMES) % TURTLE_FRAMES];
  const bob = frame % 2 === 0 ? '' : ' ';
  const rows = [`     .-'''-.${bob}`, `(${FACES[mood]})(o o o)`, `    ${a}"""""${b}`];
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => r.padEnd(w));
}

/**
 * Banner beside turtle when both fit, the banner alone when only it fits, nothing otherwise.
 * `width` is the terminal's columns; unknown (undefined) means no art. Pure.
 */
export function fitArt(width: number | undefined, frame: number, mood: Level): string[] {
  if (!width) return [];
  const b = banner();
  const t = turtle(frame, mood);
  const bw = Math.max(...b.map((r) => [...r].length));
  const tw = Math.max(...t.map((r) => r.length));
  if (width >= bw + 3 + tw) return b.map((r, i) => r + ' '.repeat(bw - [...r].length + 3) + t[i]);
  if (width >= bw) return b;
  return [];
}
