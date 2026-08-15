import { describe, it, expect } from 'vitest';
import { previewModeFrom, legacyFlagsFor, PREVIEW_MODES } from '../preview-mode';

describe('previewModeFrom — migration must not quietly reset anyone', () => {
  it('prefers an explicit previewMode', () => {
    expect(previewModeFrom({ previewMode: 'auto', alwaysShowPreviews: true })).toBe('auto');
  });

  it('derives "all" from the legacy alwaysShowPreviews', () => {
    expect(previewModeFrom({ alwaysShowPreviews: true })).toBe('all');
  });

  it('derives "auto" from the legacy autoExpandAssets', () => {
    expect(previewModeFrom({ autoExpandAssets: true })).toBe('auto');
  });

  it('defaults to manual when nothing is set', () => {
    expect(previewModeFrom({})).toBe('manual');
  });

  it('PICKS "all" WHEN BOTH LEGACY FLAGS WERE SET — the ambiguous state', () => {
    // The combination was reachable and self-defeating: the large overlay covered the collage.
    // Resolving toward 'all' loses the less noticeable of the two behaviours.
    expect(previewModeFrom({ alwaysShowPreviews: true, autoExpandAssets: true })).toBe('all');
  });

  it('ignores a previewMode that is not a real mode rather than trusting it', () => {
    // Settings come back from IndexedDB and can be older, hand-edited, or written by another tab.
    expect(previewModeFrom({ previewMode: 'giant' as never, alwaysShowPreviews: true })).toBe('all');
    expect(previewModeFrom({ previewMode: 'giant' as never })).toBe('manual');
  });

  it('does not treat explicit false flags as a reason to change mode', () => {
    expect(previewModeFrom({ alwaysShowPreviews: false, autoExpandAssets: false })).toBe('manual');
  });
});

describe('legacyFlagsFor — the old fields stay consistent with the new one', () => {
  it('maps each mode to exactly one legacy flag, or neither', () => {
    expect(legacyFlagsFor('all')).toEqual({ alwaysShowPreviews: true, autoExpandAssets: false });
    expect(legacyFlagsFor('auto')).toEqual({ alwaysShowPreviews: false, autoExpandAssets: true });
    expect(legacyFlagsFor('manual')).toEqual({ alwaysShowPreviews: false, autoExpandAssets: false });
  });

  it('NEVER emits the contradictory both-on state the mode exists to prevent', () => {
    for (const mode of PREVIEW_MODES) {
      const f = legacyFlagsFor(mode);
      expect(f.alwaysShowPreviews && f.autoExpandAssets, mode).toBe(false);
    }
  });

  it('round-trips: writing a mode and reading it back gives the same mode', () => {
    for (const mode of PREVIEW_MODES) {
      expect(previewModeFrom(legacyFlagsFor(mode)), mode).toBe(mode);
    }
  });
});
