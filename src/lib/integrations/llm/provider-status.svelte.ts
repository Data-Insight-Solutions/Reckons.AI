/**
 * Provider Status — tracks which LLM providers are configured and ready.
 *
 * Design goals (GDrive-style UX):
 *  - Every provider is "available" in the sense that its code is code-split
 *    and only fetched when first used.
 *  - "Configured" = has a key (or needs no key, e.g. Ollama, WASM, Chrome AI).
 *  - "Ready" = configured AND the SDK chunk (if any) has been loaded.
 *  - Providers without SDK deps (Claude, OpenAI, Gemini, OpenRouter) are
 *    immediately ready once a key is entered — they use native fetch.
 *  - Providers with SDK deps (Hume, Transformers.js) show a "loading SDK"
 *    state on first activation so users know something is being fetched.
 *
 * Consumers (settings page, ingest indicator) subscribe to providerStatus()
 * to render an appropriate badge: configured / not-configured / loading / ready.
 */

import { settings } from '../../stores/settings.svelte';

export type ProviderKey =
  | 'claude' | 'openai' | 'gemini' | 'openrouter'
  | 'ollama' | 'wasm' | 'chrome-ai' | 'reckons'
  | 'hume' | 'mistral' | 'firecrawl';

export type ProviderState =
  | 'not-configured'  // no key / not enabled
  | 'configured'      // key present, SDK not needed or already loaded
  | 'sdk-loading'     // key present, SDK chunk is being fetched
  | 'sdk-error'       // SDK chunk failed to load
  | 'ready';          // fully operational

export type ProviderInfo = {
  key: ProviderKey;
  label: string;
  /** Approximate size of the lazy JS chunk, displayed during loading. */
  sdkSize?: string;
  /** Whether this provider ships a lazy SDK chunk (vs pure fetch). */
  hasLazySdk: boolean;
  state: ProviderState;
};

// ── State ─────────────────────────────────────────────────────────────────────

const _sdkState = $state<Record<string, 'loading' | 'ready' | 'error'>>({});

export function getSdkState(key: ProviderKey): 'loading' | 'ready' | 'error' | 'idle' {
  return (_sdkState as Record<string, string>)[key] as 'loading' | 'ready' | 'error' ?? 'idle';
}

// ── Provider config ───────────────────────────────────────────────────────────

const PROVIDER_META: Record<ProviderKey, { label: string; sdkSize?: string; hasLazySdk: boolean }> = {
  claude:      { label: 'Claude',         hasLazySdk: false },
  openai:      { label: 'OpenAI',         hasLazySdk: false },
  gemini:      { label: 'Gemini',         hasLazySdk: false },
  openrouter:  { label: 'OpenRouter',     hasLazySdk: false },
  ollama:      { label: 'Ollama',         hasLazySdk: false },
  wasm:        { label: 'WASM',           sdkSize: '~50 MB on first use', hasLazySdk: true },
  'chrome-ai': { label: 'Chrome AI',      hasLazySdk: false },
  reckons:     { label: 'Reckons.AI',     hasLazySdk: false },
  hume:        { label: 'Hume.AI',        sdkSize: '~300 KB on first connect', hasLazySdk: true },
  mistral:     { label: 'Mistral OCR',    hasLazySdk: false },
  firecrawl:   { label: 'Firecrawl',      hasLazySdk: false },
};

function isConfigured(key: ProviderKey): boolean {
  const s = settings();
  switch (key) {
    case 'claude':     return !!s.claudeApiKey;
    case 'openai':     return !!s.openaiApiKey;
    case 'gemini':     return !!s.geminiApiKey;
    case 'openrouter': return !!s.openrouterApiKey;
    case 'mistral':    return !!s.mistralApiKey;
    case 'firecrawl':  return !!s.firecrawlApiKey;
    case 'hume':       return !!s.humeAiApiKey;
    case 'reckons':    return !!s.reckonsApiKey;
    // These need no key
    case 'ollama':
    case 'wasm':
    case 'chrome-ai':  return true;
  }
}

/**
 * Returns the current status of every provider.
 * Reactive — re-computes whenever settings() or _sdkState changes.
 */
export function providerStatus(): ProviderInfo[] {
  return (Object.entries(PROVIDER_META) as [ProviderKey, typeof PROVIDER_META[ProviderKey]][])
    .map(([key, meta]) => {
      const configured = isConfigured(key);
      const sdkStateVal = (_sdkState as Record<string, string>)[key];

      let state: ProviderState;
      if (!configured) {
        state = 'not-configured';
      } else if (!meta.hasLazySdk) {
        state = 'ready';
      } else if (sdkStateVal === 'ready') {
        state = 'ready';
      } else if (sdkStateVal === 'loading') {
        state = 'sdk-loading';
      } else if (sdkStateVal === 'error') {
        state = 'sdk-error';
      } else {
        // Configured, has lazy SDK, not yet loaded — "configured" (will load on first use)
        state = 'configured';
      }

      return { key, ...meta, state };
    });
}

/** Convenience: providers used for at least one current task. */
export function activeProviders(): ProviderInfo[] {
  const s = settings();
  const analyzeDefault = s.analyzeBackend ?? s.preferredBackend;
  const used = new Set([
    s.ingestBackend ?? s.preferredBackend,
    analyzeDefault,
    s.diffSummaryBackend ?? analyzeDefault,
    s.mergeAnalysisBackend ?? analyzeDefault,
    s.chatBackend ?? s.preferredBackend,
    s.humeAiApiKey ? 'hume' : null,
    s.mistralApiKey ? 'mistral' : null,
    s.firecrawlApiKey ? 'firecrawl' : null,
  ].filter(Boolean) as ProviderKey[]);
  return providerStatus().filter(p => used.has(p.key));
}

// ── SDK pre-warm ──────────────────────────────────────────────────────────────

/**
 * Mark a provider's SDK chunk as loading, then import it.
 * Safe to call multiple times — idempotent.
 */
export async function warmProviderSdk(key: ProviderKey): Promise<void> {
  if ((_sdkState as Record<string, string>)[key]) return; // already loading or ready

  (_sdkState as Record<string, string>)[key] = 'loading';
  try {
    if (key === 'hume') {
      await import('hume');
    } else if (key === 'wasm') {
      // transformers.js is loaded inside the worker — just ping the worker init
      const { ensureWasmReady } = await import('./wasm');
      await ensureWasmReady();
    }
    (_sdkState as Record<string, string>)[key] = 'ready';
  } catch (e) {
    console.warn(`[provider-status] Failed to load SDK for ${key}:`, e);
    (_sdkState as Record<string, string>)[key] = 'error';
  }
}
