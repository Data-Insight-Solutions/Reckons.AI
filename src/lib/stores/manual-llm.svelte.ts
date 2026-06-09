/**
 * Manual LLM store — pauses extraction so the user can copy the built
 * prompt into any external LLM (Claude.ai, ChatGPT, Gemini, etc.) and
 * paste the JSON response back in. No API key or billing required.
 */

let _prompt = $state<string | null>(null);
let _resolve: ((text: string) => void) | null = null;
let _reject: ((e: Error) => void) | null = null;

/** The pending prompt waiting for a user response, or null if idle */
export function pendingManualPrompt(): string | null {
  return _prompt;
}

/**
 * Called from the extraction pipeline. Sets the visible prompt and returns
 * a Promise that resolves once the user pastes and submits a response.
 */
export async function requestManualLLM(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    _prompt = prompt;
    _resolve = resolve;
    _reject = reject;
  });
}

/** Called by the modal UI when the user submits their pasted response */
export function submitManualLLMResponse(text: string) {
  const res = _resolve;
  _prompt = null;
  _resolve = null;
  _reject = null;
  res?.(text);
}

/** Called by the modal UI when the user cancels */
export function cancelManualLLM() {
  const rej = _reject;
  _prompt = null;
  _resolve = null;
  _reject = null;
  rej?.(new Error('Cancelled'));
}
