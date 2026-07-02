/**
 * Local extraction and summarization — bulk LLM work offloaded to a local
 * Ollama instance (see ollama-client.ts) so MCP clients don't spend
 * cloud/session tokens on it.
 *
 * Both tools return proposals only; neither writes to any KB, consistent
 * with Reckons.AI's review-first philosophy (see ReviewStatus in
 * src/lib/rdf/types.ts — pending/pending-removal/confirmed/refined/rejected/superseded).
 */

import { ETHICS_PREAMBLE } from './ethics-preamble.js';
import { ollamaChat, ollamaChatJSON, type OllamaChatMessage } from './ollama-client.js';
import type { Triple } from './kb-reader.js';

// ── Extraction ───────────────────────────────────────────────────────────────

export type LocalTriple = {
  subject: string;
  predicate: string;
  object: string;
  excerpt?: string;
};

const EXTRACT_SCHEMA = {
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
          excerpt: { type: 'string' },
        },
        required: ['subject', 'predicate', 'object'],
      },
    },
  },
  required: ['triples'],
};

/** Small-model-friendly prompt: few rules, two few-shot examples. */
export const LOCAL_EXTRACT_SYSTEM_PROMPT =
  ETHICS_PREAMBLE +
  `You extract knowledge graph triples from text.

Rules:
1. Output triples: {subject, predicate, object, excerpt}.
2. subject and predicate are short kebab-case slugs (e.g. "reckons-ai", "has-status"). object is a slug or a plain value.
3. excerpt is the verbatim source sentence the triple came from — copy it exactly, do not paraphrase.
4. Only extract facts actually stated in the text. Do not invent or infer beyond what's written.
5. Output JSON only, matching the schema. No extra text, no markdown fence.

Example 1:
Text: "Reckons.AI ships an MCP server that exposes 16 tools to AI agents."
Output: {"triples":[{"subject":"reckons-ai","predicate":"ships","object":"mcp-server","excerpt":"Reckons.AI ships an MCP server that exposes 16 tools to AI agents."},{"subject":"mcp-server","predicate":"has-tool-count","object":"16","excerpt":"Reckons.AI ships an MCP server that exposes 16 tools to AI agents."}]}

Example 2:
Text: "Ada Lovelace wrote the first algorithm intended for a machine, in 1843."
Output: {"triples":[{"subject":"ada-lovelace","predicate":"wrote","object":"first-algorithm","excerpt":"Ada Lovelace wrote the first algorithm intended for a machine, in 1843."},{"subject":"first-algorithm","predicate":"written-in","object":"1843","excerpt":"Ada Lovelace wrote the first algorithm intended for a machine, in 1843."}]}`;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

/** Render extracted triples as Turtle, matching the urn:kbase:* vocabulary. */
export function renderLocalTriplesAsTurtle(triples: LocalTriple[]): string {
  const lines = ['@prefix kb: <urn:kbase:concept/> .', '@prefix kpred: <urn:kbase:predicate/> .', ''];
  for (const t of triples) {
    const s = `kb:${slugify(t.subject)}`;
    const p = `kpred:${slugify(t.predicate)}`;
    const isLiteral = /^-?[\d.]+$/.test(t.object) || /\s/.test(t.object);
    const o = isLiteral ? `"${t.object.replace(/"/g, '\\"')}"` : `kb:${slugify(t.object)}`;
    lines.push(`${s} ${p} ${o} .`);
  }
  return lines.join('\n');
}

export type LocalExtractResult = {
  triples: LocalTriple[];
  turtle: string;
};

/**
 * Extract triples from text using a local Ollama model. Returns proposals
 * for the caller to review — does NOT write anything to a KB.
 */
export async function extractTriplesLocally(text: string, source?: string): Promise<LocalExtractResult> {
  const userPrompt = `Source: "${source ?? 'unspecified'}"\n\nText:\n"""\n${text.slice(0, 8000)}\n"""\n\nExtract triples now.`;

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: LOCAL_EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const parsed = await ollamaChatJSON<{ triples?: LocalTriple[] }>(messages, EXTRACT_SCHEMA);
  const triples = Array.isArray(parsed.triples) ? parsed.triples : [];
  return { triples, turtle: renderLocalTriplesAsTurtle(triples) };
}

// ── Summarization ────────────────────────────────────────────────────────────

/** Minimal interface local-llm needs from a KB reader — satisfied structurally by MultiKBReader. */
export interface SubgraphSource {
  resolveLabel(label: string, kb?: string): string | null;
  subgraph(iri: string, hops: number, kb?: string): Triple[];
}

function fmtTripleCompact(t: Triple): string {
  const s = t.subject.split('/').pop() ?? t.subject;
  const p = t.predicate.split('/').pop() ?? t.predicate;
  return `${s} .${p} ${t.object}`;
}

function trimToWordBudget(text: string, budget: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= budget) return text;
  return words.slice(0, budget).join(' ') + '…';
}

export type LocalSummarizeParams = {
  entity?: string;
  text?: string;
  kb?: string;
  budget?: number;
};

export type LocalSummarizeResult = {
  label: string;
  summary: string;
};

/**
 * Summarize either an entity's subgraph (pulled via `source`, reusing the
 * same subgraph logic as kb_subgraph) or raw text, using a local Ollama
 * model. Exactly one of entity/text must be provided. `budget` caps the
 * summary length in approximate words (soft cap via prompt, hard cap by
 * trimming the response).
 */
export async function summarizeLocally(params: LocalSummarizeParams, source: SubgraphSource): Promise<LocalSummarizeResult> {
  const hasEntity = !!params.entity?.trim();
  const hasText = !!params.text?.trim();
  if (hasEntity === hasText) {
    throw new Error('Provide exactly one of "entity" or "text".');
  }

  const budget = Math.min(Math.max(params.budget ?? 150, 20), 1000);

  let label: string;
  let contextText: string;

  if (hasEntity) {
    let iri = params.entity!.trim();
    if (!iri.startsWith('urn:') && !iri.startsWith('http')) {
      const resolved = source.resolveLabel(iri, params.kb);
      if (!resolved) throw new Error(`Not found: "${iri}". Use kb_search or kb_list_entities.`);
      iri = resolved;
    }
    const triples = source.subgraph(iri, 1, params.kb).slice(0, 60);
    if (triples.length === 0) throw new Error(`No facts near: ${iri}`);
    label = iri.split('/').pop() ?? iri;
    contextText = triples.map(fmtTripleCompact).join('\n');
  } else {
    label = 'provided text';
    contextText = params.text!.slice(0, 8000);
  }

  const systemPrompt =
    ETHICS_PREAMBLE +
    `You are a concise summarizer. Summarize the given content in plain prose, in about ${budget} words or fewer. No preamble, no headers — just the summary.`;
  const userPrompt = hasEntity
    ? `Entity: ${label}\n\nKnown facts (subject .predicate object):\n${contextText}\n\nSummarize this entity.`
    : `Text:\n"""\n${contextText}\n"""\n\nSummarize this text.`;

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const raw = await ollamaChat(messages);
  const summary = trimToWordBudget(raw.trim(), budget);
  return { label, summary };
}
