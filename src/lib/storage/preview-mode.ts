/**
 * PREVIEW MODE — one setting where there used to be two booleans that could disagree.
 *
 * `alwaysShowPreviews` spreads every thumbnail out so they are all visible (F133).
 * `autoExpandAssets` blows the SELECTED node's asset up to cover most of the graph.
 * Both on meant the large overlay hid the very collage the other option had just arranged, and
 * nothing in the UI hinted that the combination was self-defeating. Matt, 2026-08-14: "maybe we
 * have that and all previews together in the same dropdown?"
 *
 * The migration matters more than it looks. People have these booleans set already, and defaulting
 * a missing `previewMode` straight to 'manual' would quietly switch their graph back to plain
 * nodes with no error and nothing to notice — the kind of silent reset that reads as data loss.
 */

export type PreviewMode = 'manual' | 'auto' | 'all';

export const PREVIEW_MODES: readonly PreviewMode[] = ['manual', 'auto', 'all'] as const;

/** Short labels for the dropdown; the tooltip carries the explanation. */
export const PREVIEW_MODE_LABELS: Record<PreviewMode, string> = {
  manual: 'manual',
  auto: 'auto-expand',
  // "preview all", not "expand all": nothing is expanded. Every node shows its normal-size
  // thumbnail and the layout spreads to fit them. Expansion is the separate, larger view you get
  // by clicking one. Matt, 2026-08-14: "They aren't really expanded."
  all: 'preview all',
};

export const PREVIEW_MODE_HINTS: Record<PreviewMode, string> = {
  manual: 'Previews show on the selected and highlighted nodes. Click a thumbnail to expand it.',
  auto: "The selected node's image opens large automatically as you move from node to node — built for story/explore walkthroughs.",
  all: 'Every node shows its preview at once, and the layout spreads out so they are all visible. Respects the active filters, and works with any force mode.',
};

/**
 * Resolve the effective mode, preferring an explicit setting and otherwise deriving one from the
 * legacy booleans.
 *
 * 'all' WINS when both legacy flags were set. The two are not equal in intent: showing everything
 * is a deliberate arrangement of the whole graph, while auto-expand is a navigation convenience,
 * and the arrangement is the thing that would be destroyed by honouring the other. Picking the
 * setting whose loss is more noticeable is the safer read of an ambiguous state.
 */
export function previewModeFrom(settings: {
  previewMode?: PreviewMode;
  alwaysShowPreviews?: boolean;
  autoExpandAssets?: boolean;
}): PreviewMode {
  if (settings.previewMode && PREVIEW_MODES.includes(settings.previewMode)) return settings.previewMode;
  if (settings.alwaysShowPreviews) return 'all';
  if (settings.autoExpandAssets) return 'auto';
  return 'manual';
}

/**
 * The legacy booleans a mode implies. Written alongside `previewMode` so anything still reading the
 * old fields — persisted settings, an older tab open on the same database — stays consistent
 * instead of drifting away from the new source of truth.
 */
export function legacyFlagsFor(mode: PreviewMode): {
  alwaysShowPreviews: boolean;
  autoExpandAssets: boolean;
} {
  return {
    alwaysShowPreviews: mode === 'all',
    autoExpandAssets: mode === 'auto',
  };
}
