/**
 * Local Ollama bridge — lets MCP clients (e.g. Claude Code sessions) offload
 * bulk LLM work (extraction, summarization) to a LOCAL Ollama instance
 * instead of spending cloud/session tokens.
 *
 * Opt-in: the feature is disabled unless OLLAMA_BASE_URL is set. There is
 * intentionally no default base URL — an operator must explicitly point
 * this at a running Ollama instance.
 *
 * Ollama native chat API: POST {baseUrl}/api/chat
 * https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-structured-outputs
 */

/** No default — unset means the feature is disabled. */
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'devstral-small-2:latest';

export function ollamaEnabled(): boolean {
  return !!OLLAMA_BASE_URL;
}

export const OLLAMA_DISABLED_MESSAGE =
  'Local LLM offload is disabled. Set the OLLAMA_BASE_URL environment variable to enable it ' +
  '(e.g. OLLAMA_BASE_URL=http://localhost:11434) and restart the MCP server. ' +
  'Optionally set OLLAMA_MODEL to pick a model (default: devstral-small-2:latest).';

export type OllamaChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type OllamaChatOptions = {
  /** JSON schema to constrain the model's output (Ollama's `format` field). */
  format?: object;
  /** Override the configured model for this call. */
  model?: string;
};

/**
 * Call Ollama's native /api/chat endpoint (non-streaming) and return the
 * assistant's message content. Throws if the feature is disabled or the
 * request fails.
 */
export async function ollamaChat(messages: OllamaChatMessage[], opts: OllamaChatOptions = {}): Promise<string> {
  const baseUrl = OLLAMA_BASE_URL;
  if (!baseUrl) throw new Error(OLLAMA_DISABLED_MESSAGE);

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? OLLAMA_MODEL,
      messages,
      stream: false,
      ...(opts.format ? { format: opts.format } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Ollama response missing message.content');
  }
  return content;
}

/**
 * Call Ollama with a JSON schema constraint and parse the result as JSON.
 * Retries once if the first response fails to parse, appending the parse
 * error to the conversation so the model can self-correct. If the retry
 * also fails to parse, the error propagates to the caller.
 */
export async function ollamaChatJSON<T>(
  messages: OllamaChatMessage[],
  schema: object,
  opts: OllamaChatOptions = {}
): Promise<T> {
  const raw = await ollamaChat(messages, { ...opts, format: schema });
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const parseError = e instanceof Error ? e.message : String(e);
    const retryMessages: OllamaChatMessage[] = [
      ...messages,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `That response was not valid JSON (${parseError}). Return ONLY valid JSON matching the required schema — no prose, no markdown fence.`,
      },
    ];
    const retryRaw = await ollamaChat(retryMessages, { ...opts, format: schema });
    return JSON.parse(retryRaw) as T; // if this throws, the caller surfaces the error
  }
}
