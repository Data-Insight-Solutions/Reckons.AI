import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_COMPACT,
  buildExtractionUserPrompt,
  buildExtractedTripleSchema,
  parseTriplesJSON,
  isSmallOllamaModel,
  type ExtractedTriple
} from './extractor';
import { chatOllama, chatOllamaStructured, type ChatMessage } from './providers';

export type OllamaExtractOptions = {
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /**
   * Overrides prompt-variant selection entirely — used when a caller has
   * already composed a specialised system prompt (e.g. repository ingest's
   * code-extraction supplement). Wins over `promptMode`.
   */
  systemPromptOverride?: string;
  /**
   * 'auto' (default) picks the compact prompt for small models per
   * `isSmallOllamaModel`; 'compact'/'full' force one variant regardless of
   * model name. Exposed as a settings override (`ollamaPromptMode`).
   */
  promptMode?: 'auto' | 'compact' | 'full';
  /**
   * Enables schema-constrained decoding via Ollama's native `/api/chat`
   * `format` parameter. Defaults to true. On any failure (older Ollama
   * without `format` support, model that ignores the grammar, etc.) this
   * automatically falls back to the plain OpenAI-compatible chat path, so it
   * is safe to leave enabled.
   */
  structured?: boolean;
};

/** Picks EXTRACTION_SYSTEM_PROMPT vs. the compact small-model variant. */
export function resolveOllamaSystemPrompt(opts: OllamaExtractOptions): string {
  if (opts.systemPromptOverride) return opts.systemPromptOverride;
  const mode = opts.promptMode ?? 'auto';
  const useCompact = mode === 'compact' || (mode === 'auto' && isSmallOllamaModel(opts.model));
  return useCompact ? EXTRACTION_SYSTEM_PROMPT_COMPACT : EXTRACTION_SYSTEM_PROMPT;
}

type ParseResult =
  | { ok: true; triples: ExtractedTriple[] }
  | { ok: false; error: string };

function tryParseTriples(raw: string): ParseResult {
  try {
    const triples = parseTriplesJSON(raw);
    if (triples.length === 0 && raw.trim() !== '[]') {
      return { ok: false, error: 'No valid triples found in the response (missing subject/predicate/object fields?)' };
    }
    return { ok: true, triples };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Schema-constrained extraction with one repair retry: if the first response
 * fails to parse/validate, the failure is appended as a follow-up user turn
 * and the model gets one more constrained attempt before giving up.
 */
async function extractStructured(
  messages: ChatMessage[],
  system: string,
  opts: OllamaExtractOptions
): Promise<ExtractedTriple[]> {
  const schema = buildExtractedTripleSchema();
  const raw = await chatOllamaStructured(messages, system, schema, opts.model, opts.baseUrl, opts.maxTokens);
  const first = tryParseTriples(raw);
  if (first.ok) return first.triples;

  const repairMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
    {
      role: 'user',
      content: `That response was invalid: ${first.error}. Re-emit a corrected JSON array that matches the schema exactly. Respond with ONLY the JSON array.`
    }
  ];
  const repaired = await chatOllamaStructured(repairMessages, system, schema, opts.model, opts.baseUrl, opts.maxTokens);
  const second = tryParseTriples(repaired);
  if (second.ok) return second.triples;

  throw new Error(`Structured extraction failed after repair retry: ${second.error}`);
}

/**
 * Extracts triples from text via a locally running Ollama instance.
 *
 * Prefers schema-constrained decoding (Ollama's native `/api/chat` with a
 * JSON Schema `format`) so the model can only emit schema-valid tokens, with
 * one repair/retry on parse failure. Falls back to the plain OpenAI-compatible
 * chat path (`chatOllama`) if structured decoding is disabled or errors out
 * (e.g. an older Ollama build without `format` support).
 *
 * The system prompt is chosen automatically: small models (~4B params or
 * fewer, per `isSmallOllamaModel`) get a compact prompt with restated schema
 * and few-shot examples, which they follow more reliably than the full
 * 11-rule prompt. Larger models keep the full prompt. Callers can force a
 * variant via `promptMode`, or bypass selection entirely via
 * `systemPromptOverride` (used by code-aware repository ingest).
 */
export async function extractWithOllama(
  text: string,
  sourceTitle: string,
  opts: OllamaExtractOptions
): Promise<ExtractedTriple[]> {
  const system = resolveOllamaSystemPrompt(opts);
  const messages: ChatMessage[] = [{ role: 'user', content: buildExtractionUserPrompt(text, sourceTitle) }];
  const useStructured = opts.structured ?? true;

  if (useStructured) {
    try {
      return await extractStructured(messages, system, opts);
    } catch (e) {
      console.warn('[ollama] structured extraction failed, falling back to plain chat:', e);
    }
  }

  const raw = await chatOllama(messages, system, opts.model, opts.baseUrl, opts.maxTokens);
  return parseTriplesJSON(raw);
}
