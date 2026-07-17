/**
 * One clipboard helper for the whole app (found by the button-crawl: "copy full" on /settings threw
 * `Failed to execute 'writeText' on 'Clipboard': permission denied` — an UNHANDLED rejection).
 *
 * navigator.clipboard.writeText fails, by throwing, in real situations: an insecure context (plain
 * http, not https/localhost), a browser that blocks clipboard without a gesture, or an old browser
 * with no async clipboard API. Every call site that awaited it unguarded could crash the same way —
 * near-identical code copy-pasted, the exact "separate code for nearly the same task" this consolidates.
 *
 * copyText NEVER throws: it tries the modern API, falls back to the legacy hidden-textarea +
 * execCommand('copy') (which works on http and old browsers), and returns whether it succeeded so a
 * caller can show "copied" or "copy failed" instead of exploding.
 */

/** Copy text to the clipboard. Returns true on success. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  // Modern async clipboard — needs a secure context + permission; may reject.
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path — do not let the rejection escape
  }

  // Legacy fallback: a hidden textarea + document.execCommand('copy'). Works on http and older
  // browsers where the async API is absent or blocked.
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
