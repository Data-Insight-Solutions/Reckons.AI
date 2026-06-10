import { v4 as uuid } from 'uuid';
import type { Source, Statement } from '../rdf/types';
import { extractWithClaude } from '../integrations/llm/claude';
import { extractWithWasm } from '../integrations/llm/wasm';
import { chatOpenAI, chatGemini, chatOpenRouter, chatChromeAI, chatReckons } from '../integrations/llm/providers';
import { triplesToStatements, extractMock, parseTriplesJSON, EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, type ExtractedTriple } from '../integrations/llm/extractor';
import { computeDiff, type Diff } from '../rdf/diff';
import { semanticEnrichDiff } from '../rdf/semantic-diff';
import { addSource, addStatements, statements as allStatements } from './kb.svelte';
import { settings } from './settings.svelte';
import { addSuggestion } from './disambiguation.svelte';
import { pushNotification } from './notifications.svelte';

/**
 * One pipeline for all four ingestion modes — URL, document, note, reminder.
 * The output is always the same: a new Source, a batch of pending Statements,
 * and a Diff against the existing KB that the review UI can render.
 */

export type IngestInput =
  | { kind: 'url'; url: string }
  | { kind: 'document'; title: string; text: string; filename?: string }
  | { kind: 'note'; title: string; body: string }
  | { kind: 'reminder'; title: string; body: string; dueAt?: number };

export type IngestProgress =
  | { phase: 'fetching' }
  | { phase: 'extracting'; backend: 'claude' | 'openai' | 'gemini' | 'ollama' | 'wasm' | 'mock' | 'openrouter' | 'chrome-ai' }
  | { phase: 'diffing' }
  | { phase: 'semantic' }
  | { phase: 'done'; source: Source; statements: Statement[]; diff: Diff };

const JINA_PROXY = 'https://r.jina.ai/';

async function fetchReadable(url: string): Promise<{ title: string; text: string }> {
  // Prefer Firecrawl (JS rendering, better quality) when a key is configured.
  // Falls back to Jina Reader (free, no key, simple GET).
  const firecrawlKey = settings().firecrawlApiKey;
  if (firecrawlKey) {
    const { fetchWithFirecrawl } = await import('../integrations/parsers/firecrawl');
    return fetchWithFirecrawl(url, firecrawlKey);
  }
  const res = await fetch(`${JINA_PROXY}${url}`);
  if (!res.ok) throw new Error(`Reader failed: ${res.status}`);
  const text = await res.text();
  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? url;
  return { title, text };
}

export async function ingest(
  input: IngestInput,
  onProgress?: (p: IngestProgress) => void
): Promise<IngestProgress & { phase: 'done' }> {
  const id = uuid();
  let title: string;
  let text: string;
  let uri: string;
  let kind: Source['kind'];

  if (input.kind === 'url') {
    onProgress?.({ phase: 'fetching' });
    const fetched = await fetchReadable(input.url);
    title = fetched.title;
    text = fetched.text;
    uri = input.url;
    kind = 'url';
  } else if (input.kind === 'document') {
    title = input.title;
    text = input.text;
    uri = `file://${input.filename ?? input.title}`;
    kind = 'document';
  } else if (input.kind === 'note') {
    title = input.title;
    text = input.body;
    uri = `note://${id}`;
    kind = 'note';
  } else {
    title = input.title;
    text = `Reminder: ${input.title}\n${input.body}${input.dueAt ? `\nDue: ${new Date(input.dueAt).toISOString()}` : ''}`;
    uri = `reminder://${id}`;
    kind = 'reminder';
  }

  const source: Source = {
    id,
    title,
    uri,
    ingestedAt: Date.now(),
    kind,
    hash: await sha256(text)
  };

  const s = settings();
  // Per-task backend override — falls back to the global preferredBackend.
  // Smart fallback: if a cloud backend is selected but no key is configured,
  // drop to WASM so the app still works without any setup.
  const chosen = s.ingestBackend ?? s.preferredBackend;
  const hasKey =
    chosen === 'claude'      ? !!s.claudeApiKey :
    chosen === 'openai'      ? !!s.openaiApiKey :
    chosen === 'gemini'      ? !!s.geminiApiKey :
    chosen === 'openrouter'  ? !!s.openrouterApiKey :
    chosen === 'reckons'     ? !!s.reckonsApiKey :
    true; // ollama, wasm, mock, manual, chrome-ai need no key
  const backend = hasKey ? chosen : 'wasm';
  onProgress?.({ phase: 'extracting', backend });
  let triples: ExtractedTriple[];
  if (backend === 'openai') {
    const raw = await chatOpenAI(
      [{ role: 'user', content: buildExtractionUserPrompt(text, title) }],
      EXTRACTION_SYSTEM_PROMPT,
      s.openaiApiKey!,
      s.openaiModel
    );
    triples = parseTriplesJSON(raw);
  } else if (backend === 'gemini') {
    const raw = await chatGemini(
      [{ role: 'user', content: buildExtractionUserPrompt(text, title) }],
      EXTRACTION_SYSTEM_PROMPT,
      s.geminiApiKey!,
      s.geminiModel
    );
    triples = parseTriplesJSON(raw);
  } else if (backend === 'claude') {
    triples = await extractWithClaude(text, title, { apiKey: s.claudeApiKey!, model: s.claudeModel });
  } else if (backend === 'openrouter') {
    const raw = await chatOpenRouter(
      [{ role: 'user', content: buildExtractionUserPrompt(text, title) }],
      EXTRACTION_SYSTEM_PROMPT,
      s.openrouterApiKey!,
      s.openrouterModel
    );
    triples = parseTriplesJSON(raw);
  } else if (backend === 'reckons') {
    const raw = await chatReckons(
      [{ role: 'user', content: buildExtractionUserPrompt(text, title) }],
      EXTRACTION_SYSTEM_PROMPT,
      s.reckonsApiKey!,
      s.reckonsBaseUrl,
      s.reckonsModel
    );
    triples = parseTriplesJSON(raw);
  } else if (backend === 'chrome-ai') {
    const raw = await chatChromeAI(
      [{ role: 'user', content: buildExtractionUserPrompt(text, title) }],
      EXTRACTION_SYSTEM_PROMPT
    );
    triples = parseTriplesJSON(raw);
  } else if (backend === 'wasm') {
    try {
      triples = await extractWithWasm(text, title, s.wasmModel);
    } catch (wasmErr) {
      console.warn('[fallback] WASM extraction failed, using mock:', wasmErr);
      pushNotification({
        id: 'wasm-fallback',
        type: 'warn',
        title: 'Local AI unavailable — used placeholder extraction',
        body: 'The WASM model could not load. Statements were placeholder-extracted and need careful review. Switch to a cloud backend in Settings for better quality.',
        action: { label: 'Settings', href: '/settings' },
      });
      triples = extractMock(text, title);
    }
  } else {
    triples = extractMock(text, title);
  }

  const newStatements = triplesToStatements(triples, source);

  // Record the backend and exact model that performed extraction.
  // Useful for provenance, re-extraction decisions, and explaining confidence variance.
  source.extractionBackend = backend;
  source.extractionModel =
    backend === 'claude'     ? (s.claudeModel     ?? 'claude-opus-4-7')                        :
    backend === 'openai'     ? (s.openaiModel     ?? 'gpt-4o-mini')                            :
    backend === 'gemini'     ? (s.geminiModel     ?? 'gemini-2.0-flash')                       :
    backend === 'ollama'     ? (s.ollamaModel     ?? 'llama3.2')                               :
    backend === 'wasm'       ? (s.wasmModel       ?? 'HuggingFaceTB/SmolLM2-360M-Instruct')    :
    backend === 'openrouter' ? (s.openrouterModel ?? 'meta-llama/llama-3.2-3b-instruct:free')  :
    backend === 'reckons'    ? (s.reckonsModel    ?? '@cf/meta/llama-3.1-8b-instruct')         :
    backend === 'chrome-ai'  ? 'chrome-ai'                                                      :
    'mock';

  onProgress?.({ phase: 'diffing' });
  const structuralDiff = computeDiff(newStatements, allStatements());

  onProgress?.({ phase: 'semantic' });
  const diff = await semanticEnrichDiff(structuralDiff, allStatements());

  await addSource(source);
  await addStatements(newStatements, source.id);

  // Detect similar entity names via semantic clustering
  try {
    const entityKeys = new Set<string>();
    for (const st of newStatements) {
      if (st.s.kind === 'iri') {
        const key = st.s.value;
        if (key.startsWith('kb:')) {
          entityKeys.add(key);
        }
      }
    }

    if (entityKeys.size > 1) {
      const keys = Array.from(entityKeys);
      const labels = keys.map((k) => k.split('/').pop() || k);
      const { embedMany, cluster } = await import('../embed');
      const embeddings = await embedMany(labels);
      const clusters = cluster(keys, embeddings, 0.85);

      // For each cluster with >1 member, add disambiguation suggestions
      for (const clusterGroup of clusters) {
        if (clusterGroup.length > 1) {
          for (let i = 0; i < clusterGroup.length - 1; i++) {
            const keyA = clusterGroup[i];
            const keyB = clusterGroup[i + 1];
            // Rough similarity from cluster membership
            const similarity = 0.87;
            addSuggestion({
              id: `${keyA}::${keyB}`,
              entityKeyA: keyA,
              entityKeyB: keyB,
              similarity,
              timestamp: Date.now(),
              dismissed: false
            });
          }
        }
      }
    }
  } catch (err) {
    // Embedding/clustering errors shouldn't block ingestion
    console.warn('Disambiguation clustering failed:', err);
  }

  const done: IngestProgress & { phase: 'done' } = {
    phase: 'done',
    source,
    statements: newStatements,
    diff
  };
  onProgress?.(done);
  return done;
}

/**
 * Build the LLM extraction prompt for a given input without calling an LLM.
 * Used by the "copy prompt" UI so the user can paste it into any LLM manually.
 */
export async function buildIngestionPrompt(input: IngestInput): Promise<{ prompt: string; title: string }> {
  let title: string;
  let text: string;
  if (input.kind === 'url') {
    const fetched = await fetchReadable(input.url);
    title = fetched.title;
    text = fetched.text;
  } else if (input.kind === 'document') {
    title = input.title;
    text = input.text;
  } else if (input.kind === 'note') {
    title = input.title;
    text = input.body;
  } else {
    title = input.title;
    text = `Reminder: ${input.title}\n${input.body}${input.dueAt ? `\nDue: ${new Date(input.dueAt).toISOString()}` : ''}`;
  }
  const prompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n${buildExtractionUserPrompt(text, title)}`;
  return { prompt, title };
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
