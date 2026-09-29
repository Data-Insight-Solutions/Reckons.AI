/**
 * Qualitative UX impression from a screenshot, read by the LOCAL VLM — the "how
 * does this screen FEEL" arm of visual testing, sitting beside vlmGate's "is X
 * present".
 *
 * WHY THIS IS SHAPED DIFFERENTLY FROM A GATE. A gate asks a question with a
 * verifiable answer, so it can be scored against tests/visual/vlm-golden.ts and
 * it is allowed to fail a build. "Does this screen look crowded" has no ground
 * truth to score against, so this module is PROPOSAL-ONLY by construction: it
 * never gates, and every reading is something a human accepts or rejects. There
 * is no golden set behind these labels and there cannot easily be one — say that
 * out loud wherever the output is reported.
 *
 * WHY ANCHORED LABELS AND NOT NUMBERS. Ask a 7B VLM for "crowding: 6.5/10" and
 * it will return a number with no calibration behind it, which then gets
 * averaged, charted, and treated as measurement. An ordinal with named anchors
 * (airy | balanced | busy | crowded) is a distinction the model can actually
 * make, and it degrades into "unparsed" rather than into false precision.
 *
 * WHAT IS DELIBERATELY NOT HERE. Touch-target size, blank screens and contrast
 * ratios are all measurable in plain JS — button-crawl.ts and vision-local
 * already do it, deterministically and for free. Per the work tiering (F74.3) a
 * judgment tier must not re-answer a question the script tier answers exactly,
 * so this module only asks what nothing cheaper can.
 *
 * Every scored dimension CITES the rubric guideline it reads, so a finding points
 * at kb:web-uiux-rubric rather than at this file's opinion.
 */
import { reviewImageVLM, VLM_MODEL } from './vision-vlm';

export interface UxDimension {
  /** Stable key — also the line prefix the model must emit. */
  key: string;
  /** What is being judged, in first-time-visitor language, not design jargon. */
  ask: string;
  /** Anchored ordinal, ordered BEST → WORST. The index is the rank. */
  scale: readonly string[];
  /** Rank at or past which the reading is worth a human look. */
  flagAt: number;
  /** Rubric entity in kb:web-uiux-rubric this reading cites. */
  cites: string;
}

/**
 * The generic pass — asked of any screen, in any app state. Keep this list short:
 * each dimension is another chance for the model to drift, and a six-line answer
 * from a 7B VLM parses far more reliably than a twenty-line one.
 */
export const UX_DIMENSIONS: readonly UxDimension[] = [
  {
    key: 'crowding',
    ask: 'how densely packed the screen is — whether it has room to breathe',
    scale: ['airy', 'balanced', 'busy', 'crowded'],
    flagAt: 2,
    cites: 'kb:guideline-progressive-disclosure',
  },
  {
    key: 'hierarchy',
    ask: 'how easily you can tell which single element is the most important',
    scale: ['obvious', 'discernible', 'competing', 'unclear'],
    flagAt: 2,
    cites: 'kb:guideline-visual-hierarchy',
  },
  {
    key: 'legibility',
    ask: 'how comfortably the text reads at this size and contrast',
    scale: ['easy', 'adequate', 'strained', 'unreadable'],
    flagAt: 2,
    cites: 'kb:guideline-legibility',
  },
  {
    key: 'balance',
    ask: 'how evenly visual weight is spread across the screen',
    scale: ['balanced', 'slightly-uneven', 'lopsided', 'one-sided'],
    flagAt: 2,
    cites: 'kb:principle-balance',
  },
  {
    key: 'consistency',
    ask: 'whether the parts look like one designed system or several bolted together',
    scale: ['consistent', 'mostly-consistent', 'mixed', 'clashing'],
    flagAt: 2,
    cites: 'kb:guideline-consistency',
  },
] as const;

export interface UxReading {
  key: string;
  /** null when the model answered with something outside the scale. */
  label: string | null;
  /** Index into the dimension's scale; null when unparsed. */
  rank: number | null;
  /** The model's one-line reason, or '' if it gave none. */
  reason: string;
  /** rank >= flagAt. An unparsed reading is never flagged — absence is not evidence. */
  flagged: boolean;
  cites: string;
}

export interface UxImpression {
  readings: UxReading[];
  /** Readings at or past their flag threshold, worst first. */
  flagged: UxReading[];
  /** One sentence: what a first-time visitor would think this screen is for. */
  impression: string;
  /** The single biggest visual problem, or '' when the model said none. */
  worst: string;
  /** How many of UX_DIMENSIONS came back inside their scale. */
  parsed: number;
  /** Raw completion, kept so a human can see what was actually said. */
  raw: string;
  model: string;
}

/**
 * Built fresh each call rather than stored as a constant, so adding a dimension
 * cannot leave the prompt and the parser disagreeing about what was asked.
 */
export function impressionPrompt(dims: readonly UxDimension[] = UX_DIMENSIONS): string {
  const lines = dims.map((d) => `${d.key}: one of [${d.scale.join(' | ')}] — ${d.ask}`);
  return (
    'You are looking at a screenshot of an app screen as a FIRST-TIME visitor who ' +
    'knows nothing about the product. Judge only what you can actually see. Do not ' +
    'guess at features that are off-screen.\n\n' +
    'Reply with one line per item below, in exactly this format:\n' +
    '<name>: <label> — <short reason>\n\n' +
    'Choose the label from the list given. Do not invent labels and do not use ' +
    'numbers or percentages.\n\n' +
    lines.join('\n') +
    '\n\nThen these two final lines:\n' +
    'impression: <one sentence on what a first-time visitor would think this screen is for>\n' +
    'worst: <the single biggest visual problem, or the word none>'
  );
}

/** `key: label — reason`, tolerating em-dash, en-dash, hyphen or nothing. */
function lineFor(raw: string, key: string): { value: string; reason: string } | null {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${key}\\*{0,2}\\s*[:=]\\s*(.+)$`, 'im');
  const m = raw.match(re);
  if (!m) return null;
  const rest = m[1].trim().replace(/\*+/g, '');
  // Split only on a SPACED hyphen (or any em/en dash). Splitting on a bare
  // hyphen ate both halves of the data: it truncated prose at the first
  // hyphenated word ("a knowledge-graph product" -> "a knowledge") AND cut every
  // multi-word scale label in half ("mostly-consistent" -> "mostly"), which the
  // parser would then have reported as an unreadable answer.
  const split = rest.match(/^(.+?)(?:\s*[—–]\s*|\s+-\s+)(.*)$/);
  if (split) return { value: split[1].trim(), reason: split[2].trim() };
  return { value: rest, reason: '' };
}

/**
 * Parse a completion into readings. Anything outside a dimension's scale is kept
 * as an UNPARSED reading rather than coerced to the nearest label — a local model
 * that answers "crowding: quite busy actually" has not answered the question, and
 * quietly rounding it to `busy` would launder a miss into a measurement.
 */
export function parseImpression(
  raw: string,
  dims: readonly UxDimension[] = UX_DIMENSIONS,
  model = VLM_MODEL,
): UxImpression {
  const readings: UxReading[] = dims.map((d) => {
    const hit = lineFor(raw, d.key);
    const value = hit?.value.toLowerCase().replace(/\s+/g, '-') ?? '';
    const rank = d.scale.indexOf(value);
    const ok = rank >= 0;
    return {
      key: d.key,
      label: ok ? d.scale[rank] : null,
      rank: ok ? rank : null,
      reason: hit?.reason ?? '',
      flagged: ok && rank >= d.flagAt,
      cites: d.cites,
    };
  });
  const worstLine = lineFor(raw, 'worst');
  const worstRaw = worstLine ? [worstLine.value, worstLine.reason].filter(Boolean).join(' — ') : '';
  return {
    readings,
    flagged: readings.filter((r) => r.flagged).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)),
    impression: lineFor(raw, 'impression')?.value ?? '',
    worst: /^\s*none\b/i.test(worstRaw) ? '' : worstRaw,
    parsed: readings.filter((r) => r.rank !== null).length,
    raw,
    model,
  };
}

/** Ask the local VLM for a qualitative read of one screenshot (base64 PNG). */
export async function uxImpression(
  imgB64: string,
  dims: readonly UxDimension[] = UX_DIMENSIONS,
  model = VLM_MODEL,
): Promise<UxImpression> {
  const raw = await reviewImageVLM(imgB64, impressionPrompt(dims), model);
  return parseImpression(raw, dims, model);
}

/** One-line human summary, e.g. `crowded · competing hierarchy · 5/5 read`. */
export function summarize(imp: UxImpression): string {
  const parts = imp.flagged.map((r) => `${r.label} ${r.key}`);
  const head = parts.length ? parts.join(' · ') : 'nothing flagged';
  return `${head} · ${imp.parsed}/${imp.readings.length} read`;
}
