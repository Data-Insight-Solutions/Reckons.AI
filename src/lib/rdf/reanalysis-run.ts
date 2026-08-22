/**
 * Running a freeform re-analysis against whichever backend the user has configured.
 *
 * Kept apart from reanalysis.ts on purpose: that module is pure types + validation, so it stays
 * trivially testable and carries no provider imports. This is the dispatch half, and it mirrors
 * generateDiffSummary's provider selection rather than inventing a second one.
 *
 * IT RETURNS PROPOSALS. Nothing here writes a statement, changes a status, or settles anything —
 * the caller shows the operations, and a person applies them or does not.
 */
import {
  chatClaude, chatOpenAI, chatGemini, chatOllama, chatOpenRouter, chatReckons, chatChromeAI,
  type ChatMessage,
} from '$lib/integrations/llm/providers';
import { chatWithWasm } from '$lib/integrations/llm/wasm';
import { preferLocalBackend } from '$lib/integrations/llm/prefer-local';
import { ethicsPreambleFor } from '$lib/safety/content-policy';
import type { SettingsRecord } from '$lib/storage/db';
import {
  validateProposedReanalysis, type ReanalysisRequest, type ReanalysisOutcome, type ProposedReanalysis,
} from './reanalysis';

/*
 * THE POLICY DECIDES, NOT THIS COMMENT.
 *
 * An earlier version of this file argued in prose that no ethics preamble was needed here —
 * purpose is 'structured', the entire output is a closed set of operations over ids that already
 * exist, and validateProposedReanalysis rejects anything else, so there is no channel through
 * which generated content reaches a reader. The reasoning was right and the implementation was
 * wrong: scripts/offline/safety-attestation.ts flagged this module UNCLASSIFIED, because a prompt
 * that asserts its own exemption cannot be audited.
 *
 * So it now ASKS. ethicsPreambleFor('structured') returns '' today, which is the same output the
 * comment claimed — but if the policy ever changes its mind about structured prompts, this prompt
 * changes with it instead of quietly keeping an exemption somebody wrote once.
 */
const SYSTEM = ethicsPreambleFor('structured') + `You reorganize a list of PENDING facts that a person is about to review.

You may only propose these operations, and nothing else:
  attach  {"op":"attach","factIds":["..."],"decisionId":"...","because":"..."}   put facts under an open decision
  group   {"op":"group","factIds":["..."],"question":"...?","because":"..."}     gather facts into ONE question
  depend  {"op":"depend","blockerDecisionId":"...","blockedDecisionId":"...","because":"..."}
  drop    {"op":"drop","factIds":["..."],"because":"..."}                        flag as noise or duplicate

RULES:
- You may NOT add, edit, reword or settle a fact. You move what already exists.
- Every id you name must appear in the input. Never invent an id.
- A fact belongs to at most one operation.
- A group needs at least two facts and a question ending in "?".
- Follow the person's instruction. If it asks for something you cannot do with these four
  operations, return {"operations":[]} rather than doing something else.

Respond with valid JSON only: {"operations":[ ... ]}`;

function buildPrompt(req: ReanalysisRequest): string {
  const facts = req.facts
    .map((f) => `${f.id} | ${f.subject.replace('urn:kbase:concept/', 'kb:')} | ${f.predicate} | ${String(f.object).replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');
  const decisions = req.decisions.length
    ? req.decisions.map((d) => `${d.id} | ${d.question.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
    : '(none open)';
  return [
    `WHAT THE PERSON ASKED FOR (their words, follow them):\n${req.instruction}`,
    '',
    `PENDING FACTS (id | subject | predicate | object):\n${facts}`,
    '',
    `OPEN DECISIONS (id | question):\n${decisions}`,
  ].join('\n');
}

export interface ReanalysisRun extends ReanalysisOutcome {
  /** Set when the model could not be reached or did not return usable JSON. */
  error?: string;
  /** How many operations the model proposed before validation, so the yield is visible. */
  proposed: number;
}

export async function runReanalysis(req: ReanalysisRequest, s: SettingsRecord): Promise<ReanalysisRun> {
  if (!req.instruction.trim()) return { operations: [], rejected: [], proposed: 0, error: 'No instruction given.' };
  if (!req.facts.length) return { operations: [], rejected: [], proposed: 0, error: 'Nothing pending to re-analyze.' };

  const explicit = s.analyzeBackend;
  const provider = explicit ?? (await preferLocalBackend(s, explicit)) ?? s.preferredBackend;
  const messages: ChatMessage[] = [{ role: 'user', content: buildPrompt(req) }];

  let raw: string;
  try {
    if (provider === 'openai') raw = await chatOpenAI(messages, SYSTEM, s.openaiApiKey ?? '', s.openaiModel ?? 'gpt-4o-mini', 1024);
    else if (provider === 'gemini') raw = await chatGemini(messages, SYSTEM, s.geminiApiKey ?? '', s.geminiModel ?? 'gemini-2.0-flash', 1024);
    else if (provider === 'ollama') raw = await chatOllama(messages, SYSTEM, s.ollamaModel ?? 'llama3.2', s.ollamaBaseUrl, 1024);
    else if (provider === 'openrouter') raw = await chatOpenRouter(messages, SYSTEM, s.openrouterApiKey ?? '', s.openrouterModel ?? 'meta-llama/llama-3.1-8b-instruct', 1024);
    else if (provider === 'reckons') raw = await chatReckons(messages, SYSTEM, s.reckonsApiKey ?? '', s.reckonsBaseUrl, undefined, 1024);
    else if (provider === 'wasm') raw = await chatWithWasm(messages, SYSTEM, s.wasmAnalyzeModel || s.wasmModel || undefined);
    else if (provider === 'chrome-ai') raw = await chatChromeAI(messages, SYSTEM, 1024);
    else raw = await chatClaude(messages, SYSTEM, s.claudeApiKey ?? '', s.claudeModel ?? 'claude-haiku-4-5-20251001', 1024);
  } catch (err) {
    // Reported, never swallowed: a silent failure looks identical to "your pending set is fine".
    return { operations: [], rejected: [], proposed: 0, error: `The model could not be reached: ${(err as Error).message}` };
  }

  let parsed: ProposedReanalysis;
  try {
    let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object in the response');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { operations: [], rejected: [], proposed: 0, error: `The model did not return usable JSON: ${(err as Error).message}` };
  }

  const proposed = parsed.operations?.length ?? 0;
  return { ...validateProposedReanalysis(parsed, req), proposed };
}
