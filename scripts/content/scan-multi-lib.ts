/**
 * Multi-scan reconstruction (F58.9.19 / kb:multi-scan-reconstruction): the pure parts. Several captures of ONE
 * object are pooled into one COLMAP run so every capture shares one coordinate frame; then one splat is trained.
 * No files, ffmpeg or COLMAP here; scripts/content/scan-multi.ts does the work.
 */
export interface CaptureSpec { raw: string; path: string; fromS?: number; toS?: number }
export interface MultiArgs { captures: CaptureSpec[]; keyframesPerCapture: number; out: string; steps: number; passthrough: string[] }

export const MIN_CAPTURES = 2;
/** A capture joined the model only if at least this many of its frames AND this fraction of them registered in it. */
export const MIN_JOIN_FRAMES = 5;
export const MIN_JOIN_FRACTION = 0.2;
/** Largest pool matched exhaustively on the CPU (n*(n-1)/2 pairs: 500 frames is about 125,000 pairs). */
export const EXHAUSTIVE_MAX_FRAMES = 500;

/** `path` or `path@10-27` (seconds): a time slice of one video, used to test the pipeline from a single recording. */
export function parseCapture(raw: string): CaptureSpec {
  const m = /^(.*)@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return { raw, path: raw };
  const fromS = Number(m[2]), toS = Number(m[3]);
  if (!(toS > fromS)) throw new Error(`capture slice ${raw}: end must be after start`);
  return { raw, path: m[1], fromS, toS };
}

const VALUE_FLAGS = ['capture', 'keyframes-per-capture', 'out', 'steps', 'box', 'track'];
export function parseMultiArgs(argv: string[]): MultiArgs {
  const caps: string[] = [];
  const val: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}; captures are given as --capture <video-or-frames-dir> (repeat it)`);
    const [flag, inline] = a.slice(2).split(/=(.*)/s);
    if (VALUE_FLAGS.includes(flag)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${flag} needs a value`);
      if (flag === 'capture') caps.push(v); else val[flag] = v;
      if (flag === 'box' || flag === 'track') passthrough.push(`--${flag}=${v}`);
    } else throw new Error(`unknown option ${a}`);
  }
  if (caps.length < MIN_CAPTURES) throw new Error(`multi-scan needs at least ${MIN_CAPTURES} --capture arguments (got ${caps.length}); for one capture use npm run scan:room`);
  if (!val.out) throw new Error('--out <dir> is required');
  const kpc = val['keyframes-per-capture'] === undefined ? 100 : Number(val['keyframes-per-capture']);
  if (!Number.isInteger(kpc) || kpc < 10) throw new Error('--keyframes-per-capture must be an integer of at least 10');
  const steps = val.steps === undefined ? 30000 : Number(val.steps);
  if (!(steps > 0)) throw new Error('--steps must be positive');
  return { captures: caps.map(parseCapture), keyframesPerCapture: kpc, out: val.out, steps, passthrough };
}

/** A short unique name per capture, from its file or folder name; collisions get a numeric suffix. Names never contain "__". */
export function captureNames(specs: CaptureSpec[]): string[] {
  const seen = new Map<string, number>();
  return specs.map((s, i) => {
    const base = (s.path.replace(/\/+$/, '').split('/').pop() ?? `c${i}`).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `c${i}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** Pooled frame name: capture, double underscore, capture-order number. Sorting names keeps each capture's frames contiguous and in order. */
export function frameName(capture: string, n: number, ext = 'jpg'): string {
  return `${capture}__${String(n).padStart(5, '0')}.${ext}`;
}
export function captureOfFrame(name: string): string {
  const i = name.indexOf('__');
  if (i < 1) throw new Error(`frame ${name} is not named capture__number`);
  return name.slice(0, i);
}

export type Matcher = 'exhaustive' | 'sequential-loop';
export interface MatcherChoice { matcher: Matcher; reason: string }
/**
 * Cross-capture matching has to compare frames of DIFFERENT captures, which sequential matching never does. Small pools
 * are matched exhaustively (every pair). Above EXHAUSTIVE_MAX_FRAMES that is too slow on the CPU, and the only other
 * cross-capture route is vocabulary-tree loop detection, which needs a vocab-tree file the pipeline does not ship.
 */
export function chooseMatcher(poolSize: number, vocabTree: string | undefined): MatcherChoice {
  if (poolSize <= EXHAUSTIVE_MAX_FRAMES) return { matcher: 'exhaustive', reason: `${poolSize} frames is at most ${EXHAUSTIVE_MAX_FRAMES}, so every pair is matched` };
  if (!vocabTree) throw new Error(`${poolSize} pooled frames is more than ${EXHAUSTIVE_MAX_FRAMES} (exhaustive matching) and no vocabulary tree is set in RECKONS_COLMAP_VOCAB_TREE; lower --keyframes-per-capture or supply a vocab tree`);
  return { matcher: 'sequential-loop', reason: `${poolSize} frames is over ${EXHAUSTIVE_MAX_FRAMES}: sequential matching plus vocabulary-tree loop detection (${vocabTree})` };
}

/** What the COLMAP step lists: for every reconstructed sub-model, the names of the images it registered. */
export interface ModelListing { models: string[][] }
export interface CaptureAccount { name: string; supplied: number; registered: number; joined: boolean; registeredElsewhere: number }
export interface JoinVerdict { captures: CaptureAccount[]; modelsFound: number; singleModel: boolean; failures: string[]; mainModelSize: number }

/**
 * Per-capture accounting against the LARGEST model (the one written for training). A capture that is not in it
 * (fewer than MIN_JOIN_FRAMES and MIN_JOIN_FRACTION of its frames) did not join: that is a failure naming the capture,
 * never a silent train on the biggest piece. Frames that registered in a smaller model are counted as registeredElsewhere.
 */
export function judgeJoin(supplied: Record<string, number>, listing: ModelListing): JoinVerdict {
  const ordered = [...listing.models].sort((a, b) => b.length - a.length);
  const main = ordered[0] ?? [];
  const count = (m: string[], c: string) => m.filter((n) => captureOfFrame(n) === c).length;
  const captures = Object.keys(supplied).map((name) => {
    const registered = count(main, name);
    const total = supplied[name];
    const elsewhere = ordered.slice(1).reduce((n, m) => n + count(m, name), 0);
    return { name, supplied: total, registered, registeredElsewhere: elsewhere, joined: registered >= Math.min(MIN_JOIN_FRAMES, total) && registered >= MIN_JOIN_FRACTION * total };
  });
  const failures = captures.filter((c) => !c.joined).map((c) =>
    `capture "${c.name}" did not join the model: ${c.registered} of ${c.supplied} frames registered in the largest model${c.registeredElsewhere ? ` (${c.registeredElsewhere} more landed in a separate sub-model)` : ''}`);
  return { captures, modelsFound: ordered.length, singleModel: failures.length === 0, failures, mainModelSize: main.length };
}

/** The receipt's multi-scan block, checked by validateReceipt. */
export interface MultiRecord {
  matcher: Matcher; matcherReason: string; modelsFound: number; singleModel: boolean;
  captures: (CaptureAccount & { source: string; keyframes: number; camera: string })[];
}
export function validateMulti(m: MultiRecord, supplied: number, registered: number): string[] {
  const p: string[] = [];
  if (!m.singleModel) p.push('multi-scan receipt: not every capture landed in one model');
  if (m.captures.length < MIN_CAPTURES) p.push('multi-scan receipt: fewer than two captures recorded');
  if (m.captures.reduce((n, c) => n + c.supplied, 0) !== supplied) p.push('multi-scan receipt: per-capture supplied counts do not add up to the pooled frames');
  if (m.captures.reduce((n, c) => n + c.registered, 0) !== registered) p.push('multi-scan receipt: per-capture registered counts do not add up to the registered total');
  for (const c of m.captures) if (!c.joined) p.push(`multi-scan receipt: capture ${c.name} did not join`);
  return p;
}
