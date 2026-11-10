/**
 * How the canvas draws a statement's standing (F223.10 / kb:standing-drawn).
 *
 * One pure mapping from standing to style TOKENS, shared by the 2D and 3D renderers so they
 * cannot drift. Standing is carried by line style and node shape, never by colour alone: it
 * must read in a screenshot printed in grey.
 *
 * A QUESTION MUST NOT LOOK FILTERED OUT. The canvas already uses faintness for "not what you
 * asked for" (a filter dims everything else to GHOST_ALPHA). A question is therefore HOLLOW
 * with a dashed outline and about half fill, and a dimming multiplies on top of that, so an
 * undimmed question is always at least twice as strong as a dimmed held fact.
 */
export type DrawnStanding = 'held' | 'pending' | 'proposed' | 'question';

/** The alpha a filter dims non-matching things to. The renderers share this value. */
export const DIM_ALPHA = 0.18;

export interface StandingStyle {
  /** Edge drawn dashed; node outline dashed. */
  dashed: boolean;
  /** Node drawn as an outline with a light fill instead of a solid body. */
  hollow: boolean;
  /** Overall strength multiplier in (0,1]. Dimming multiplies on top. */
  strength: number;
  /** Which house CSS variable colours it, or null to keep the usual colour. */
  colorVar: '--data' | '--ink-2' | null;
  /** Glyph drawn in a hollow node, so the absence is a marked thing. */
  mark: string | null;
}

const STYLES: Record<DrawnStanding, StandingStyle> = {
  held: { dashed: false, hollow: false, strength: 1, colorVar: null, mark: null },
  pending: { dashed: false, hollow: false, strength: 1, colorVar: null, mark: null },
  proposed: { dashed: true, hollow: false, strength: 1, colorVar: '--data', mark: null },
  question: { dashed: true, hollow: true, strength: 0.5, colorVar: '--ink-2', mark: '?' },
};

/** Edge style for a standing. A node touched only by proposals is also drawn hollow (see nodeStyle). */
export function standingStyle(standing: DrawnStanding): StandingStyle {
  return STYLES[standing];
}

/** A node that exists only in a proposal is hollow with a dashed ring; its edges stay proposed. */
export function nodeStyle(standing: DrawnStanding): StandingStyle {
  return standing === 'proposed' ? { ...STYLES.proposed, hollow: true } : STYLES[standing];
}

/** Final alpha: the standing's strength, multiplied by the dim a filter applies. */
export function standingAlpha(standing: DrawnStanding, dimmed: boolean): number {
  return STYLES[standing].strength * (dimmed ? DIM_ALPHA : 1);
}
