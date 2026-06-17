/**
 * F11 — Diff Summary
 * Generates concise natural-language summaries of new, reinforcing, and
 * conflicting information from a computed diff, using the configured LLM.
 */

import type { Diff, DiffEntry } from './diff';
import type { Statement } from './types';
import { chatClaude, chatOpenAI, chatGemini, chatOllama, chatOpenRouter, chatReckons, type ChatMessage } from '$lib/integrations/llm/providers';
import { chatWithWasm } from '$lib/integrations/llm/wasm';
import type { SettingsRecord } from '$lib/storage/db';
import { ETHICS_PREAMBLE } from '$lib/safety/content-policy';

export type DiffSummary = {
  newSummary: string;
  reinforcingSummary: string;
  conflictingSummary: string;
};

const SUMMARY_SYSTEM = ETHICS_PREAMBLE + `You summarize the differences between a new document and an existing knowledge base.
You receive three categorized lists of facts (as short glosses or triple descriptions).
For each category, write 1-3 concise sentences summarizing the key themes.
"New to this KB" means the KB hasn't captured these facts yet — not that they are newly discovered or previously unknown in the world. If a category is empty, say "None in this source."
Respond with valid JSON: {"newSummary":"...","reinforcingSummary":"...","conflictingSummary":"..."}
No markdown fences, no extra text.`;

function describeEntry(e: DiffEntry): string {
  const inc = e.incoming;
  if (inc.gloss) return inc.gloss;
  if (inc.excerpt) return inc.excerpt;
  const s = inc.s.value.split('/').pop() ?? inc.s.value;
  const p = inc.p.value.split('/').pop() ?? inc.p.value;
  const o = inc.o.value.split('/').pop() ?? inc.o.value;
  return `${s} ${p} ${o}`;
}

function buildPrompt(diff: Diff): string {
  const newFacts = diff.entries
    .filter(e => e.kind === 'new')
    .map(describeEntry)
    .slice(0, 40);
  const reinforcing = diff.entries
    .filter(e => e.kind === 'reinforces' || e.kind === 'synonym-reinforces')
    .map(describeEntry)
    .slice(0, 30);
  const conflicting = diff.entries
    .filter(e => e.kind === 'conflicts' || e.kind === 'antonym-conflicts' || e.kind === 'refines')
    .map(describeEntry)
    .slice(0, 30);

  return `## New information (${newFacts.length} facts)
${newFacts.length > 0 ? newFacts.map((f, i) => `${i + 1}. ${f}`).join('\n') : '(none)'}

## Reinforcing information (${reinforcing.length} facts)
${reinforcing.length > 0 ? reinforcing.map((f, i) => `${i + 1}. ${f}`).join('\n') : '(none)'}

## Conflicting / refining information (${conflicting.length} facts)
${conflicting.length > 0 ? conflicting.map((f, i) => `${i + 1}. ${f}`).join('\n') : '(none)'}

Summarize each category in 1-3 sentences. Respond with JSON only.`;
}

/** Quick local summary when no LLM is available */
function fallbackSummary(diff: Diff): DiffSummary {
  const newCount = diff.summary.new;
  const reinfCount = diff.summary.reinforces + diff.summary.synonymReinforces;
  const conflCount = diff.summary.conflicts + diff.summary.antonymConflicts + diff.summary.refines;
  return {
    newSummary: newCount > 0
      ? `This source introduces ${newCount} fact${newCount !== 1 ? 's' : ''} not yet captured in this KB.`
      : 'None in this source.',
    reinforcingSummary: reinfCount > 0
      ? `${reinfCount} fact${reinfCount !== 1 ? 's' : ''} corroborate${reinfCount === 1 ? 's' : ''} what this KB already contains.`
      : 'None in this source.',
    conflictingSummary: conflCount > 0
      ? `${conflCount} fact${conflCount !== 1 ? 's' : ''} conflict${conflCount === 1 ? 's' : ''} with or refine${conflCount === 1 ? 's' : ''} existing KB statements.`
      : 'None in this source.'
  };
}

export async function generateDiffSummary(
  diff: Diff,
  s: SettingsRecord
): Promise<DiffSummary> {
  // If nothing meaningful to summarize, return counts-only fallback
  const total = diff.summary.new + diff.summary.reinforces + diff.summary.conflicts
    + diff.summary.refines + diff.summary.synonymReinforces + diff.summary.antonymConflicts;
  if (total === 0) return fallbackSummary(diff);

  const provider = s.diffSummaryBackend ?? s.analyzeBackend ?? s.preferredBackend;
  const messages: ChatMessage[] = [
    { role: 'user', content: buildPrompt(diff) }
  ];

  try {
    let raw: string;
    if (provider === 'openai') {
      raw = await chatOpenAI(messages, SUMMARY_SYSTEM, s.openaiApiKey ?? '', s.openaiModel ?? 'gpt-4o-mini', 512);
    } else if (provider === 'gemini') {
      raw = await chatGemini(messages, SUMMARY_SYSTEM, s.geminiApiKey ?? '', s.geminiModel ?? 'gemini-2.0-flash', 512);
    } else if (provider === 'ollama') {
      raw = await chatOllama(messages, SUMMARY_SYSTEM, s.ollamaModel ?? 'llama3.2', s.ollamaBaseUrl, 512);
    } else if (provider === 'openrouter') {
      raw = await chatOpenRouter(messages, SUMMARY_SYSTEM, s.openrouterApiKey ?? '', s.openrouterModel ?? 'meta-llama/llama-3.1-8b-instruct', 512);
    } else if (provider === 'reckons') {
      raw = await chatReckons(messages, SUMMARY_SYSTEM, s.reckonsApiKey ?? '', s.reckonsBaseUrl, undefined, 512);
    } else if (provider === 'wasm') {
      raw = await chatWithWasm(messages, SUMMARY_SYSTEM, s.wasmAnalyzeModel || s.wasmModel || undefined);
    } else {
      // claude (default)
      raw = await chatClaude(messages, SUMMARY_SYSTEM, s.claudeApiKey ?? '', s.claudeModel ?? 'claude-haiku-4-5-20251001', 512);
    }

    // Parse JSON from response
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return fallbackSummary(diff);
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      newSummary: parsed.newSummary || fallbackSummary(diff).newSummary,
      reinforcingSummary: parsed.reinforcingSummary || fallbackSummary(diff).reinforcingSummary,
      conflictingSummary: parsed.conflictingSummary || fallbackSummary(diff).conflictingSummary
    };
  } catch (err) {
    console.warn('Diff summary LLM failed, using fallback:', err);
    return fallbackSummary(diff);
  }
}
