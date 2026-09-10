/**
 * Which Ollama model runs which task.
 *
 * The backend has been per-task since the beginning (`ingestBackend`, `chatBackend`, ...) and WASM
 * has had per-task models (`wasmIngestModel`, ...), but every Ollama task shared a single
 * `ollamaModel`. That is not a small gap: it is how prose extraction ended up running on
 * `qwen3-coder`, a code model, which collapsed "Orange Logic is an enterprise DAM" into the single
 * entity `orange-logic-is-an-enterprise-dam`. Nobody chose that; there was simply nowhere to say
 * otherwise.
 *
 * ONE RESOLVER, NOT TEN FALLBACKS. Ten call sites each wrote `s.ollamaModel ?? 'llama3.2'`. Ten
 * copies of a default is ten places for it to drift, and no place to add a task without editing
 * all of them. Everything goes through here now.
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
 * The model for a task: its own override, else the general `ollamaModel`, else the fallback.
 *
 * `diffSummary` and `mergeAnalysis` are sub-tasks of analyze and inherit from it, matching how
 * `diffSummaryBackend` already falls back to `analyzeBackend`. Splitting the backend but not the
 * model would otherwise send a sub-task to a model chosen for something else.
 */
export function ollamaModelFor(task: OllamaTask, s: OllamaModelSettings): string {
  const own = s[FIELD[task]];
  if (typeof own === 'string' && own.trim()) return own.trim();

  if (task === 'diffSummary' || task === 'mergeAnalysis') {
    const analyze = s.ollamaAnalyzeModel;
    if (typeof analyze === 'string' && analyze.trim()) return analyze.trim();
  }

  const general = s.ollamaModel;
  if (typeof general === 'string' && general.trim()) return general.trim();
  return FALLBACK_OLLAMA_MODEL;
}
