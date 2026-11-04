/**
 * Prefer-local routing — opt-in redirection of secondary LLM tasks to Ollama.
 *
 * When `settings.preferLocal` is on and the local Ollama server is reachable,
 * tasks that scored well locally in the bench suite (chat 0.83+, diff summary,
 * merge analysis — see kb:local-offload in the roadmap KB) default to the
 * `ollama` backend instead of `preferredBackend`. Explicit per-task overrides
 * always win: the redirect only fills the same slot in the resolution chain
 * that `preferredBackend` would otherwise fill.
 *
 * Reachability is probed against GET {base}/api/tags with a short timeout and
 * cached briefly, so a downed Ollama costs one failed probe per window, after
 * which everything falls through to the existing chain untouched.
 *
 * The probe already fetches the model list (it is IN the /api/tags response),
 * so the names are cached alongside reachability: `model-for-task.ts` resolves
 * defaults against them instead of guessing at tags.
 */


const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 60_000;

let cachedAt = 0;
let cachedReachable = false;
let cachedBaseUrl = '';
/** Installed model names from the last successful probe, or null if none succeeded. */
let cachedModels: string[] | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * Probe Ollama reachability, cached for CACHE_TTL_MS per base URL.
 * Concurrent callers share one in-flight probe rather than reading a stale value.
 */
export async function ollamaReachable(baseUrl = 'http://localhost:11434'): Promise<boolean> {
  if (baseUrl === cachedBaseUrl) {
    if (Date.now() - cachedAt < CACHE_TTL_MS) return cachedReachable;
    if (inflight) return inflight;
  }

  cachedBaseUrl = baseUrl;
  inflight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      cachedReachable = res.ok;
      // The reachability signal is res.ok; the model list is a bonus parsed from the same body.
      // Tolerate a body without one — parsing must never cost reachability.
      if (res.ok && typeof res.json === 'function') {
        try {
          const data = await res.json();
          cachedModels = ((data?.models ?? []) as Array<{ name?: unknown }>)
            .map((m) => (typeof m?.name === 'string' ? m.name : ''))
            .filter((name) => name !== '');
        } catch {
          cachedModels = null;
        }
      } else {
        cachedModels = null;
      }
    } catch {
      cachedReachable = false;
      cachedModels = null;
    }
    cachedAt = Date.now();
    inflight = null;
    return cachedReachable;
  })();
  return inflight;
}

/** Drop the cache (used by tests and after the user edits the base URL). */
export function resetOllamaProbeCache(): void {
  cachedAt = 0;
  cachedBaseUrl = '';
  cachedReachable = false;
  cachedModels = null;
  inflight = null;
}

/**
 * The model names the server reported in its last successful /api/tags probe, or null if no
 * probe for this base URL has succeeded. Last-known-good is deliberate: the list only changes
 * when the user pulls or unpulls a model, and null must mean "we do not know" (the resolver
 * falls back to bare-name resolution) — never "nothing is installed".
 */
export function installedOllamaModels(baseUrl = 'http://localhost:11434'): string[] | null {
  if (baseUrl !== cachedBaseUrl || !cachedReachable) return null;
  return cachedModels;
}

/**
 * Returns 'ollama' when prefer-local should route this task there, else
 * undefined so the caller's existing `?? preferredBackend` chain applies.
 * `explicit` is the task's own override chain (already ??-collapsed).
 */
export async function preferLocalBackend(
  s: { preferLocal?: boolean; ollamaBaseUrl?: string },
  explicit: string | undefined
): Promise<'ollama' | undefined> {
  if (!s.preferLocal || explicit !== undefined) return undefined;
  return (await ollamaReachable(s.ollamaBaseUrl || 'http://localhost:11434')) ? 'ollama' : undefined;
}

/**
 * Synchronous variant for sync resolution paths (e.g. turtle-chat's provider
 * resolver). Uses the cached probe result and kicks off a background refresh;
 * callers should warm the cache at startup (the app layout does this when
 * preferLocal is on) so the first resolution already has a value.
 */
export function preferLocalBackendSync(
  s: { preferLocal?: boolean; ollamaBaseUrl?: string },
  explicit: string | undefined
): 'ollama' | undefined {
  if (!s.preferLocal || explicit !== undefined) return undefined;
  const base = s.ollamaBaseUrl || 'http://localhost:11434';
  const fresh = base === cachedBaseUrl && Date.now() - cachedAt < CACHE_TTL_MS;
  void ollamaReachable(base);
  return fresh && cachedReachable ? 'ollama' : undefined;
}
