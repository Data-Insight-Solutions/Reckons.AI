import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_FEWSHOT,
  buildExtractionUserPrompt,
  buildExtractedTripleSchema,
  parseTriplesJSON,
  isSmallOllamaModel,
  type ExtractedTriple
} from './extractor';
import { chatOllama, chatOllamaStructured, type ChatMessage } from './providers';
import { CRITIC_SYSTEM_PROMPT, buildCriticUserPrompt, mergeCriticPass } from './extract-critic';

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
  /** Existing graph vocabulary + structure appended to the extraction request (F136.3). */
  graphContext?: string;
  /**
   * Aborts the HTTP request when the user cancels an ingest. Without it a cancel could only stop
   * the pipeline BETWEEN stages, leaving a 27B model generating for another minute against a
   * result nobody will read.
   */
  signal?: AbortSignal;
  /**
   * THINKING MODE (F146 extract-then-critic). Runs a second pass that reads the source AGAINST the
   * first pass's triples and returns only what was missed, unioned in. Roughly doubles the time,
   * which is why it is opt-in and off by default — see extract-critic.ts for why a comparison beats
   * a re-run, and why the critic can only ever add.
   */
  thinking?: boolean;
  /** Reports what the critic contributed, so the UI can say whether the extra wait bought anything. */
  onCritic?: (info: { added: number; duplicates: number }) => void;
};

/** Picks EXTRACTION_SYSTEM_PROMPT vs. the compact small-model variant. */
export function resolveOllamaSystemPrompt(opts: OllamaExtractOptions): string {
  if (opts.systemPromptOverride) return opts.systemPromptOverride;
  const mode = opts.promptMode ?? 'auto';
  const useCompact = mode === 'compact' || (mode === 'auto' && isSmallOllamaModel(opts.model));
  return useCompact ? EXTRACTION_SYSTEM_PROMPT_FEWSHOT : EXTRACTION_SYSTEM_PROMPT;
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
  const raw = await chatOllamaStructured(messages, system, schema, opts.model, opts.baseUrl, opts.maxTokens, opts.signal);
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
  const repaired = await chatOllamaStructured(repairMessages, system, schema, opts.model, opts.baseUrl, opts.maxTokens, opts.signal);
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
  const first = await runOnePass(
    buildExtractionUserPrompt(text, sourceTitle, opts.graphContext),
    resolveOllamaSystemPrompt(opts),
    opts,
  );
  if (!opts.thinking) return first;

  /*
   * THE SECOND PASS IS BEST-EFFORT AND MUST NEVER COST THE FIRST. If the critic times out, returns
   * unparseable output, or the model simply refuses, thinking mode degrades to exactly the
   * single-pass result rather than failing the whole ingest — the user asked for a better answer,
   * not a more fragile one. A cancel is the one exception: it is an instruction, so it propagates.
   */
  let critic: ExtractedTriple[] = [];
  try {
    critic = await runOnePass(
      buildCriticUserPrompt(text, sourceTitle, first, opts.graphContext),
      CRITIC_SYSTEM_PROMPT,
      opts,
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    console.warn('[ollama] critic pass failed; keeping the single-pass result:', e);
    opts.onCritic?.({ added: 0, duplicates: 0 });
    return first;
  }

  const { merged, added, duplicates } = mergeCriticPass(first, critic);
  opts.onCritic?.({ added: added.length, duplicates });
  return merged;
}

/** One extraction request: schema-constrained where possible, plain chat as the fallback. */
async function runOnePass(
  userPrompt: string,
  system: string,
  opts: OllamaExtractOptions
): Promise<ExtractedTriple[]> {
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
  const useStructured = opts.structured ?? true;

  if (useStructured) {
    try {
      return await extractStructured(messages, system, opts);
    } catch (e) {
      // A cancel must not be "handled" by silently retrying on the unstructured path — that would
      // start a second generation the user already asked to stop.
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.warn('[ollama] structured extraction failed, falling back to plain chat:', e);
    }
  }

  const raw = await chatOllama(messages, system, opts.model, opts.baseUrl, opts.maxTokens, opts.signal);
  return parseTriplesJSON(raw);
}
