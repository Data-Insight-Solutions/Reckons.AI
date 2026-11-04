/**
 * The notice shown when Ollama runs a different model from the one chosen (F279).
 *
 * The resolver (model-for-task.ts) falls back to the best installed model when the chosen name is
 * not installed, so work keeps running instead of failing on Ollama's 404. That fallback changes
 * which model writes the facts, so it is never silent: this module turns each substitution into a
 * warning with the fix in it. Once per chosen → used pair per page load, so an ingest that resolves
 * the model several times shows one notice, not a stack.
 */
import { setOllamaSubstitutionListener, type OllamaSubstitution, type OllamaTask } from '$lib/integrations/llm/model-for-task';
import { pushNotification, type AppNotification } from '$lib/stores/notifications.svelte';

const TASK_LABEL: Record<OllamaTask, string> = {
  ingest: 'Ingest',
  analyze: 'Analyze',
  chat: 'chat',
  diffSummary: 'change summaries',
  mergeAnalysis: 'merge suggestions',
};

/** The notification for one substitution. Pure, so the wording is testable without a DOM. */
export function substitutionNotice(sub: OllamaSubstitution): Omit<AppNotification, 'id'> & { id: string } {
  return {
    id: `ollama-substituted:${sub.chosen}->${sub.used}`,
    type: 'warn',
    title: `Ollama ran ${sub.used} instead of ${sub.chosen}`,
    body: `${sub.chosen} is not installed on your Ollama server, so ${TASK_LABEL[sub.task]} used ${sub.used}. `
      + `Results come from a different model than the one you chose. Install it with "ollama pull ${sub.chosen}", or choose an installed model in Settings.`,
    action: { label: 'Ollama settings', href: '/settings#s-ollama' },
    // The person is waiting on this work right now; a collapsed tray would hide it (see AppNotification.important).
    important: true,
  };
}

const shown = new Set<string>();

/** Register the listener once, from the app layout. */
export function initOllamaModelNotice(): void {
  setOllamaSubstitutionListener((sub) => {
    const n = substitutionNotice(sub);
    if (shown.has(n.id)) return;
    shown.add(n.id);
    pushNotification(n);
  });
}
