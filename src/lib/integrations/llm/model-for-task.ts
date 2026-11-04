/**
 * Which Ollama model runs which task.
 *
 * The backend has been per-task since the beginning (`ingestBackend`, `chatBackend`, ...) and WASM
 * has had per-task models (`wasmIngestModel`, ...), but every Ollama task shared a single
 * `ollamaModel`. That is not a small gap: it is how prose extraction ended up running on
 * `qwen3-coder`, a code model, which collapsed prose into an entity (synthetic illustration:
 * `example-archive-is-an-enterprise-dam`). Nobody chose that; there was simply nowhere to say
 * otherwise.
 *
 * ONE RESOLVER, NOT TEN FALLBACKS. Ten call sites each wrote `s.ollamaModel ?? 'llama3.2'`. Ten
 * copies of a default is ten places for it to drift, and no place to add a task without editing
 * all of them. Everything goes through here now.
 *
 * Since the installed-models pass, the resolver also knows WHAT THE SERVER HAS: given the list
 * from Ollama `/api/tags`, a bare name resolves to the tag actually installed (`llama3.2` →
 * `llama3.2:3b`, so the user never has to type the tag), and when nothing is configured — or
 * the chosen name is not installed — the best installed model is picked instead of a name the
 * server cannot serve. A model the user chose that IS installed is never overridden.
 */

/**
 * Only the model fields, structurally. Callers pass all sorts of settings-shaped objects (chat
 * carries its own narrowed type), and demanding a full SettingsRecord would force casts at the
 * call sites — which is exactly how a resolver gets bypassed.
 */
export type OllamaModelSettings = {
  ollamaModel?: string;
  ollamaIngestModel?: string;
  ollamaAnalyzeModel?: string;
  ollamaChatModel?: string;
  ollamaDiffSummaryModel?: string;
  ollamaMergeAnalysisModel?: string;
};

/**
 * The tasks that can carry their own model.
 *
 * These mirror the existing per-task BACKEND settings exactly, so a user who has already split a
 * task off by backend finds the model control in the same place rather than a new vocabulary.
 */
export type OllamaTask =
  | 'ingest'
  | 'analyze'
  | 'chat'
  | 'diffSummary'
  | 'mergeAnalysis';

const FIELD: Record<OllamaTask, keyof OllamaModelSettings> = {
  ingest: 'ollamaIngestModel',
  analyze: 'ollamaAnalyzeModel',
  chat: 'ollamaChatModel',
  diffSummary: 'ollamaDiffSummaryModel',
  mergeAnalysis: 'ollamaMergeAnalysisModel',
};

/** Last-resort default, in ONE place. Small and almost always present on a fresh Ollama install. */
export const FALLBACK_OLLAMA_MODEL = 'llama3.2';

/**
 * Resolve a model name against the models the server actually has installed (the `/api/tags`
 * names). Ollama installs models WITH a tag — a fresh `ollama pull llama3.2` lands as
 * `llama3.2:3b` — and a request for the bare name then fails, which is why the user kept having
 * to re-type `:3b` after every default. Order: exact match (a name the user chose is never
 * rewritten), `name:latest`, then the first installed tag of that family. Returns undefined
 * rather than inventing a name it cannot see in the list.
 */
export function resolveInstalledModel(name: string, installed: string[]): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (installed.includes(trimmed)) return trimmed;
  if (installed.includes(`${trimmed}:latest`)) return `${trimmed}:latest`;
  return installed.find((tag) => tag.startsWith(`${trimmed}:`));
}

/**
 * Preferred local models, best first, for a server that has any of them installed.
 *
 * The ORDER follows the task brief of 2026-11-03 (Matt), which cited this machine's extraction
 * benches: zero invented facts outranks recall, because an invented triple is a persistent
 * citable claim while a missed one is only an absence. The per-model recall figures in that
 * brief are NOT reproduced here because the result files that back them are not in the repo,
 * so they cannot be checked from this file. `qwen3:32b` heads the list but was removed from
 * this machine on 2026-10-26; resolution skips names that are not installed, so it only
 * applies to a machine that has it. `qwen3-coder` is a code model that tends to mangle prose,
 * so it sits just above the fallback. Models never benched here fall back to public
 * benchmarks, then to the first non-embedding model installed.
 */
export const PREFERRED_OLLAMA_MODELS = [
  'qwen3:32b',
  'mistral-small3.2:24b',
  'gemma3:27b',
  'phi4:14b',
  'qwen3-coder',
  'llama3.2',
];

/**
 * The model to run when the user has not chosen one: the best preferred model the server has,
 * else the first installed model that is not an embedding model (embedding models cannot do
 * extraction or chat), else the bare fallback (nothing is installed — or Ollama is down).
 */
export function pickDefaultOllamaModel(installed: string[]): string {
  for (const name of PREFERRED_OLLAMA_MODELS) {
    const resolved = resolveInstalledModel(name, installed);
    if (resolved) return resolved;
  }
  const firstUsable = installed.find((name) => !name.toLowerCase().includes('embed'));
  return firstUsable ?? FALLBACK_OLLAMA_MODEL;
}

/** The user's own choice for a task — task override, else the sub-task's analyze parent, else the
 *  general `ollamaModel`. Blank or whitespace-only counts as unset. `undefined` = nothing configured. */
export function explicitOllamaModel(task: OllamaTask, s: OllamaModelSettings): string | undefined {
  const own = s[FIELD[task]];
  if (typeof own === 'string' && own.trim()) return own.trim();

  if (task === 'diffSummary' || task === 'mergeAnalysis') {
    const analyze = s.ollamaAnalyzeModel;
    if (typeof analyze === 'string' && analyze.trim()) return analyze.trim();
  }

  const general = s.ollamaModel;
  if (typeof general === 'string' && general.trim()) return general.trim();
  return undefined;
}

/**
 * The model for a task: its own override, else the general `ollamaModel`, else the fallback.
 *
 * `diffSummary` and `mergeAnalysis` are sub-tasks of analyze and inherit from it, matching how
 * `diffSummaryBackend` already falls back to `analyzeBackend`. Splitting the backend but not the
 * model would otherwise send a sub-task to a model chosen for something else.
 *
 * `installed` (the `/api/tags` list) switches the last two steps onto reality: a bare name is
 * resolved to the tag the server actually has (`llama3.2` → `llama3.2:3b`), and when nothing is
 * configured — or the chosen name is not installed — `pickDefaultOllamaModel` picks the best
 * model that IS there. A model the user chose that is installed is never overridden. Without a
 * list the resolution is exactly what it was before: the chosen name, else the bare fallback.
 */
export function ollamaModelFor(task: OllamaTask, s: OllamaModelSettings, installed?: string[] | null): string {
  const explicit = explicitOllamaModel(task, s);

  if (installed) {
    if (explicit) {
      const resolved = resolveInstalledModel(explicit, installed);
      if (resolved) return resolved;
    }
    return pickDefaultOllamaModel(installed);
  }

  return explicit ?? FALLBACK_OLLAMA_MODEL;
}
