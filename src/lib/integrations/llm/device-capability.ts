/**
 * Device-capability detection for the local (in-browser WASM) AI tier.
 *
 * WHY (Matt, prod 2026-07-17): loading a WASM LLM crashes the tab on iOS Safari/WebKit — a tab
 * OOM that CANNOT be caught in JS. Every iOS browser is WebKit (Apple mandates it), so this is a
 * DEVICE-class limit, not a browser one: Firefox/Chrome on iOS crash identically (confirmed), and
 * `window.ai` (Chrome AI) is unavailable there. So prevention is the only fix — we use this to
 * AVOID auto-loading a too-big model on a constrained device and offer graceful alternatives
 * (a tiny model, the user's own Ollama, or an API key) instead.
 *
 * Pure functions with an injectable navigator so they are unit-testable without a real device.
 */

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Chrome/Android hint: approximate device RAM in GB. Absent elsewhere. */
  deviceMemory?: number;
}

/** The tiny in-browser model to offer on constrained devices — small enough to have a chance on
 *  iOS (~117–182 MB ONNX vs the ~500 MB default). Quality is weak; always offer it behind a
 *  warning, never auto-load it silently. The app already shipped HuggingFaceTB SmolLM historically
 *  (see db.ts STALE_MODELS), so the repo is known-good for transformers.js. */
export const TINY_WASM_MODEL = 'HuggingFaceTB/SmolLM2-135M-Instruct';

/** Approx upper bound (MB) for an in-browser model we'll auto-load on a memory-constrained device.
 *  Above this on a constrained device, route to the graceful offer instead of attempting a load
 *  that may OOM-crash the tab. Sized to admit the tiny model (~182 MB) but reject the ~500 MB default. */
export const CONSTRAINED_MODEL_MB_CAP = 250;

function nav(n?: NavigatorLike): NavigatorLike {
  if (n) return n;
  if (typeof navigator !== 'undefined') return navigator as NavigatorLike;
  return {};
}

/**
 * iOS / iPadOS — every browser there is WebKit and shares Safari's tight per-tab memory ceiling.
 * Detects classic iPhone/iPad UAs AND iPadOS 13+, which reports as desktop "MacIntel" but exposes
 * multiple touch points (the standard way to tell an iPad from a real Mac).
 */
export function isIosWebkit(n?: NavigatorLike): boolean {
  const c = nav(n);
  const ua = c.userAgent ?? '';
  const platform = c.platform ?? '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (platform === 'MacIntel' && (c.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

/** A device where a large in-browser model is likely to OOM-crash the tab. */
export function isMemoryConstrained(n?: NavigatorLike): boolean {
  const c = nav(n);
  if (isIosWebkit(c)) return true;
  // deviceMemory is a coarse hint (Chrome/Android): <= 4 GB → treat as constrained.
  if (typeof c.deviceMemory === 'number' && c.deviceMemory <= 4) return true;
  return false;
}

/** Should we AVOID auto-loading an in-browser model of this approximate size on this device? */
export function shouldAvoidInBrowserModel(approxMB: number, n?: NavigatorLike): boolean {
  return isMemoryConstrained(n) && approxMB > CONSTRAINED_MODEL_MB_CAP;
}
