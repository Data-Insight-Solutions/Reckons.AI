import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseTriplesJSON,
  type ExtractedTriple
} from './extractor';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-7';

export type ClaudeOptions = {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
};

/**
 * Calls Claude's messages API directly from the browser.
 * The user's API key never leaves their device; it's stored in IndexedDB
 * and sent only to api.anthropic.com over TLS.
 *
 * Anthropic requires the `anthropic-dangerous-direct-browser-access` header
 * to allow CORS calls from a browser. Users running the PWA accept this
 * trade-off in exchange for not needing a backend.
 */
export async function extractWithClaude(
  text: string,
  sourceTitle: string,
  opts: ClaudeOptions
): Promise<ExtractedTriple[]> {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildExtractionUserPrompt(text, sourceTitle) },
        // Prefill forces Claude to start its response mid-array, guaranteeing
        // JSON output without any preamble text.
        { role: 'assistant', content: '[' }
      ]
    }),
    signal: opts.signal
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Prepend the '[' we sent as prefill — the API returns only the completion.
  const completion = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('\n');
  return parseTriplesJSON('[' + completion);
}
