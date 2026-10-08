import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseTriplesJSON,
  type ExtractedTriple
} from './extractor';
import { claudeMaxTokens, claudeReplyText } from './providers';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Output schema for structured outputs (`output_config.format`). Mirrors `ExtractedTriple`.
 * The root has to be an object, so the array rides in `triples`; `parseTriplesJSON` slices from
 * the first `[` to the last `]`, which reads this wrapper unchanged. Constrained decoding
 * guarantees the shape, so this replaces the old assistant-turn prefill of `[` — a prefill
 * returns a 400 on Opus 4.6+ / Sonnet 4.6+ / Opus 5.5. Structured outputs work on Haiku 4.5 too.
 */
const TRIPLES_SCHEMA = {
  type: 'object',
  properties: {
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          objectIsLiteral: { type: 'boolean' },
          datatype: { type: 'string', enum: ['string', 'number', 'date', 'boolean'] },
          gloss: { type: 'string' },
          confidence: { type: 'number' },
          excerpt: { type: 'string' }
        },
        required: ['subject', 'predicate', 'object', 'objectIsLiteral', 'gloss', 'confidence', 'excerpt'],
        additionalProperties: false
      }
    }
  },
  required: ['triples'],
  additionalProperties: false
};

export type ClaudeOptions = {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  /** Override the default extraction system prompt (e.g. for code-aware extraction) */
  systemPrompt?: string;
  /** Existing graph vocabulary + structure appended to the extraction request (F136.3). */
  graphContext?: string;
  /**
   * `output_config.effort`. Omitted unless set: Haiku 4.5 (the settings default) rejects the field,
   * and on Opus 5.5 omitting it means `medium`. Measure before setting it —
   * `scripts/offline/extraction-score.ts --models=claude:<id> --effort=<level>`.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Receives the response's `usage` block, for token and cost accounting. */
  onUsage?: (usage: { input_tokens: number; output_tokens: number }) => void;
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
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: claudeMaxTokens(model, 4096),
      system: opts.systemPrompt ?? EXTRACTION_SYSTEM_PROMPT,
      output_config: {
        format: { type: 'json_schema', schema: TRIPLES_SCHEMA },
        ...(opts.effort ? { effort: opts.effort } : {})
      },
      messages: [
        { role: 'user', content: buildExtractionUserPrompt(text, sourceTitle, opts.graphContext) }
      ]
    }),
    signal: opts.signal
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.usage) opts.onUsage?.(data.usage);
  return parseTriplesJSON(claudeReplyText(data));
}
