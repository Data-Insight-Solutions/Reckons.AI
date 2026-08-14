/**
 * Reactive download consent gate.
 *
 * Registers consent handlers with wasm.ts, whisper-stt.ts, and embed.ts
 * so that any uncached model download prompts the user for confirmation.
 *
 * The consent dialog is rendered by DownloadConsentDialog.svelte (mounted
 * in +layout.svelte). This store bridges the imperative consent callbacks
 * from the model modules to the reactive Svelte dialog.
 */

import { setDownloadConsentHandler } from '$lib/integrations/llm/wasm';
import { setEmbedConsentHandler, setEmbeddingModel } from '$lib/embed';
import { shouldAvoidInBrowserModel } from '$lib/integrations/llm/device-capability';

/** Pending consent request — when non-null, the dialog should be shown. */
let _pending = $state<{
  model: string;
  approxMB: number;
  /** True on a memory-constrained device (iOS) for a model big enough to risk an OOM tab-crash.
   *  The dialog shows the graceful "try tiny / Ollama / API key" offer instead of a plain download. */
  constrained: boolean;
  resolve: (ok: boolean) => void;
} | null>(null);

export function pendingConsent() {
  return _pending;
}

export function resolveConsent(ok: boolean) {
  _pending?.resolve(ok);
  _pending = null;
}

function makeHandler(model: string, approxMB: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A SECOND request while one is already pending used to silently overwrite `_pending`,
    // discarding the first `resolve` — the caller behind it then awaited a promise that could
    // never settle. That caused the first-run ingest hang (2026-07-18): semanticEnrichDiff embeds
    // subjects and predicates in parallel, so two consent requests raced and one was orphaned
    // forever, with no error and no log.
    //
    // embed.ts now shares one in-flight load so the race should not recur, but a single-slot
    // queue that DROPS callers is a trap for the next caller too. Same model: piggy-back on the
    // dialog already showing. Different model: resolve the older one false so its caller fails
    // fast and visibly, rather than hanging.
    if (_pending) {
      if (_pending.model === model) {
        const previous = _pending.resolve;
        const merged = _pending;
        merged.resolve = (ok: boolean) => { previous(ok); resolve(ok); };
        _pending = merged;
        return;
      }
      console.warn(
        `[download-consent] a consent for "${_pending.model}" was superseded by "${model}"; ` +
        `declining the first so its caller does not hang.`,
      );
      _pending.resolve(false);
    }

    // Only the large in-browser LLM (~500MB) trips this on a constrained device; the small
    // embedding (~33MB) / whisper (~40MB) models stay under the cap and get the normal prompt.
    _pending = { model, approxMB, constrained: shouldAvoidInBrowserModel(approxMB), resolve };
  });
}

/**
 * Call once on app init to register consent handlers with all model modules.
 * Whisper is lazily imported so we register its handler on first use.
 */
export function initDownloadConsent() {
  setDownloadConsentHandler((model, approxMB) => makeHandler(model, approxMB));
  setEmbedConsentHandler((model, approxMB) => makeHandler(model, approxMB));

  // Whisper handler is registered lazily since whisper-stt.ts is dynamically imported.
  // We hook into the module the first time it's loaded via a proxy on the import.
  // Instead, we export a helper that callers (TurtleChatPanel) can call after import.
}

/**
 * Register the consent handler with the whisper module after it's been imported.
 * Call this after `await import('$lib/integrations/llm/whisper-stt')`.
 */
export async function registerWhisperConsent() {
  const { setWhisperConsentHandler } = await import('$lib/integrations/llm/whisper-stt');
  setWhisperConsentHandler((model, approxMB) => makeHandler(model, approxMB));
}
