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
 * ONE RESOLVER, NOT TEN FALLBACKS. Ten call sites each wrote `s.ollamaModel ?? <a model name>`. Ten
 * copies of a default is ten places for it to drift, and no place to add a task without editing
 * all of them. Everything goes through here now.
 *
 * Since the installed-models pass, the resolver also knows WHAT THE SERVER HAS: given the list
 * from Ollama `/api/tags`, a bare name resolves to the tag actually installed (`llama3.2` →
 * `llama3.2:3b`, so the user never has to type the tag), and when nothing is configured — or
 * the chosen name is not installed — the best installed model is picked instead of a name the
 * server cannot serve. A model the user chose that IS installed is never overridden, and one that
 * is replaced raises a notice through the substitution listener below.
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

/**
 * The roles a model can be picked for. The five tasks map onto them (`roleForTask`); `code` has no
 * task yet but the setup guide and the picker use it, so the preference list lives here.
 */
export type OllamaRole = 'extraction' | 'chat' | 'code';

export function roleForTask(task: OllamaTask): OllamaRole {
  return task === 'chat' ? 'chat' : 'extraction';
}

/**
 * A model worth suggesting in a message when nothing is installed. NOT a default: nothing is ever
 * run from this name, it only appears in "run `ollama pull ...`".
 */
export const SUGGESTED_PULL_MODEL = 'gemma3';

/** The error text a caller shows when no Ollama model is installed and none is chosen. */
export const NO_OLLAMA_MODEL_MESSAGE =
  `No Ollama model is installed — run \`ollama pull ${SUGGESTED_PULL_MODEL}\`, or choose one in Settings → Ollama.`;

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
 * Preferred local models per role, best first, for a server that has any of them installed.
 *
 * The extraction ORDER follows the task brief of 2026-11-03 (Matt), which cited this machine's
 * extraction benches: zero invented facts outranks recall, because an invented triple is a
 * persistent citable claim while a missed one is only an absence. The per-model recall figures are
 * NOT reproduced here because the result files that back them are not in the repo. Resolution
 * skips names that are not installed. `qwen3-coder` is a code model that tends to mangle prose,
 * so it is last among the extraction picks. Chat favors general instruction-following models; code
 * favors the code models. `llama3.2` stays in the lists only as a small option for low-RAM
 * machines: it is never named as a default.
 */
export const PREFERRED_OLLAMA_MODELS_BY_ROLE: Record<OllamaRole, string[]> = {
  extraction: ['qwen3:32b', 'mistral-small3.2:24b', 'gemma3:27b', 'phi4:14b', 'gemma3', 'qwen3-coder', 'llama3.2'],
  chat: ['mistral-small3.2:24b', 'gemma3:27b', 'qwen3:32b', 'phi4:14b', 'gemma3', 'llama3.2', 'qwen3-coder'],
  code: ['qwen3-coder', 'devstral-small-2', 'qwen3:32b', 'phi4:14b', 'mistral-small3.2:24b'],
};

/** The extraction ordering (kept for existing importers). */
export const PREFERRED_OLLAMA_MODELS = PREFERRED_OLLAMA_MODELS_BY_ROLE.extraction;

/**
 * The best installed model for a role: the first preferred model the server has, else the first
 * installed model that is not an embedding model (embedders cannot do extraction or chat), else
 * undefined — nothing usable is installed. There is deliberately NO invented fallback name.
 */
export function pickDefaultOllamaModel(installed: string[], role: OllamaRole = 'extraction'): string | undefined {
  for (const name of PREFERRED_OLLAMA_MODELS_BY_ROLE[role]) {
    const resolved = resolveInstalledModel(name, installed);
    if (resolved) return resolved;
  }
  return installed.find((name) => !name.toLowerCase().includes('embed'));
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
 * The model for a task: its own override, else the general `ollamaModel`, else undefined — no model name is invented.
 *
 * `diffSummary` and `mergeAnalysis` are sub-tasks of analyze and inherit from it, matching how
 * `diffSummaryBackend` already falls back to `analyzeBackend`. Splitting the backend but not the
 * model would otherwise send a sub-task to a model chosen for something else.
 *
 * `installed` (the `/api/tags` list) switches the last two steps onto reality: a bare name is
 * resolved to the tag the server actually has (`llama3.2` → `llama3.2:3b`), and when nothing is
 * configured — or the chosen name is not installed — `pickDefaultOllamaModel` picks the best
 * model that IS there. A model the user chose that is installed is never overridden. Without a
 * list the result is the chosen name, else undefined; callers that must send a request resolve
 * `undefined` through `resolveOllamaModelOrThrow` (providers.ts), which asks the server itself.
 */
export function ollamaModelFor(task: OllamaTask, s: OllamaModelSettings, installed?: string[] | null): string | undefined {
  const explicit = explicitOllamaModel(task, s);

  if (installed) {
    if (explicit) {
      const resolved = resolveInstalledModel(explicit, installed);
      if (resolved) return resolved;
    }
    const used = pickDefaultOllamaModel(installed, roleForTask(task));
    if (used && explicit) substitutionListener?.({ task, chosen: explicit, used });
    // Nothing usable installed: keep the person's own choice (the server will say it is missing)
    // rather than inventing a name; with no choice either, undefined.
    return used ?? explicit;
  }

  return explicit;
}

/** A chosen model the server does not have, and the installed one that ran in its place. */
export type OllamaSubstitution = { task: OllamaTask; chosen: string; used: string };

/**
 * NEVER A SILENT SWAP (Matt, 2026-11-04: "make it a notification, need some notice"). Running a
 * different model than the one chosen changes what gets extracted, so the person must be told.
 * The resolver stays free of UI: the app registers one listener (stores/ollama-model-notice.ts)
 * and every call site above is covered without passing anything through.
 */
let substitutionListener: ((sub: OllamaSubstitution) => void) | null = null;

export function setOllamaSubstitutionListener(fn: ((sub: OllamaSubstitution) => void) | null): void {
  substitutionListener = fn;
}
