/**
 * The third avenue of re-alignment: settling a set of facts with an ANSWER rather than a verdict.
 *
 * THREE WAYS A PENDING SET GETS RE-ALIGNED, and they differ only in what new signal arrives:
 *
 *   instruction  -> reanalysis-run.ts  "these are all about the March deploy, group them"
 *   more content -> ingest             another note about the same thing, extracted and merged
 *   an answer    -> HERE               "what was the main goal of this work?"
 *
 * The first is built. The third was designed down to its validator and left unwired: `purposeAnswers`
 * sat declared and unread in the review page while the card told the user their words would be
 * "queued for the local model to partition". Nothing was queued. This is that queue.
 *
 * WHY AN ANSWER IS NOT A VERDICT. A cluster of work tied to no planned feature cannot be settled
 * yes/no, because the missing information is a REASON, not a truth value. Asking "is this correct?"
 * of six facts whose only problem is that nobody said what they were FOR gets you six shrugs. The
 * answer re-partitions the set instead: each part gets a purpose, in the user's own words.
 *
 * THE MODEL NEVER INVENTS A PURPOSE. `validateProposedPartition` requires every purpose to be built
 * from words the person actually used, and drops any part that is not. The model's job is to decide
 * WHICH FACTS go under WHICH of the user's phrases — a sorting task, not an authoring one. That is
 * what makes it safe to run locally on a small model.
 */

import type { SettingsRecord } from '../storage/db';
import { ollamaModelFor } from '../integrations/llm/model-for-task';
import { ethicsPreambleFor } from '$lib/safety/content-policy';
import {
  chatClaude,
  chatOpenAI,
  chatOllama,
  chatOpenRouter,
  chatReckons,
  chatChromeAI,
  type ChatMessage,
} from '../integrations/llm/providers';
import {
  validateProposedPartition,
  type FactCluster,
  type PartitionOutcome,
  type PartitionRequest,
  type ProposedPartition,
} from './fact-aggregation';

/**
 * ASKS rather than assumes, like reanalysis-run.ts. `ethicsPreambleFor('structured')` returns ''
 * today: this is a structured-output prompt whose every result is vetted deterministically by
 * `validateProposedPartition` before anything is written, and the model authors no prose of its
 * own — it sorts ids under phrases the user already wrote. If the purpose/locality policy ever
 * changes its mind about structured prompts, this one changes with it instead of silently
 * keeping an omission nobody re-examined.
 */
const SYSTEM = ethicsPreambleFor('structured') + `You sort facts into groups. You are given a person's answer to "what was the main goal of this work?" and a numbered list of their facts.

Split the facts into parts, one part per distinct goal the person named.

RULES:
1. Every "purpose" MUST be phrased using the person's own words from their answer. Never invent a goal they did not state, and never generalise theirs into something broader.
2. If the person named only ONE goal, return ONE part containing every fact.
3. Put every fact id into exactly one part. Do not drop or duplicate ids.
4. Respond with JSON only: {"parts":[{"purpose":"...","memberIds":["..."]}]}`;

/** The request the model sees: the person's words, and the facts to sort under them. */
export function partitionRequest(cluster: FactCluster, answer: string): PartitionRequest {
  return {
    clusterId: cluster.id,
    answer,
    facts: cluster.members.map((st) => ({
      id: st.id,
      subject: st.s.value,
      predicate: st.p.value.replace('urn:kbase:predicate/', ''),
      object: st.o.value.slice(0, 200),
    })),
  };
}

function buildPrompt(req: PartitionRequest): string {
  const facts = req.facts
    .map((f) => `${f.id} | ${f.subject.split('/').pop()} | ${f.predicate} | ${f.object}`)
    .join('\n');
  return `Their answer:\n"""\n${req.answer}\n"""\n\nTheir facts (id | subject | predicate | object):\n${facts}\n\nReturn the parts as JSON.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          purpose: { type: 'string' },
          memberIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['purpose', 'memberIds'],
      },
    },
  },
  required: ['parts'],
} as const;

export type PartitionRun = {
  outcome: PartitionOutcome | null;
  /** Set when nothing usable came back. Reported, never swallowed. */
  error?: string;
};

/**
 * Ask a model to sort a cluster under the purposes the person named, then validate the result.
 *
 * Local-first by the same rule as reanalysis: an explicit backend wins, otherwise a running local
 * model is preferred. A person's account of their own work is exactly the kind of thing that
 * should not need to leave the machine.
 */
export async function runPartition(
  cluster: FactCluster,
  answer: string,
  s: SettingsRecord,
): Promise<PartitionRun> {
  const trimmed = answer.trim();
  if (!trimmed) return { outcome: null, error: 'Answer the question first.' };
  if (cluster.members.length === 0) return { outcome: null, error: 'Nothing in this set to sort.' };

  const req = partitionRequest(cluster, trimmed);
  const messages: ChatMessage[] = [{ role: 'user', content: buildPrompt(req) }];
  const provider = s.analyzeBackend ?? s.preferredBackend;

  let raw: string;
  try {
    if (provider === 'openai')
      raw = await chatOpenAI(messages, SYSTEM, s.openaiApiKey ?? '', s.openaiModel ?? 'gpt-4o-mini', 1024);
    else if (provider === 'ollama')
      raw = await chatOllama(messages, SYSTEM, ollamaModelFor('analyze', s), s.ollamaBaseUrl, 1024);
    else if (provider === 'openrouter')
      raw = await chatOpenRouter(messages, SYSTEM, s.openrouterApiKey ?? '', s.openrouterModel ?? 'meta-llama/llama-3.1-8b-instruct', 1024);
    else if (provider === 'reckons')
      raw = await chatReckons(messages, SYSTEM, s.reckonsApiKey ?? '', s.reckonsBaseUrl, undefined, 1024);
    else if (provider === 'chrome-ai') raw = await chatChromeAI(messages, SYSTEM, 1024);
    else
      raw = await chatClaude(messages, SYSTEM, s.claudeApiKey ?? '', s.claudeModel ?? 'claude-haiku-4-5-20251001', 1024);
  } catch (err) {
    // A silent failure here looks identical to "your answer changed nothing", which is the one
    // reading that would make the user stop answering.
    return { outcome: null, error: `The model could not be reached: ${(err as Error).message}` };
  }

  let parsed: ProposedPartition;
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object in the response');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { outcome: null, error: `The model did not return usable JSON: ${(err as Error).message}` };
  }

  const outcome = validateProposedPartition(parsed, cluster, trimmed);
  if (outcome.parts.length === 0) {
    // Every proposed purpose failed the "in the user's own words" test. Say so plainly rather
    // than reporting a successful run that changed nothing.
    return { outcome, error: 'The model proposed no purpose that matched your own words.' };
  }
  return { outcome };
}

export { SCHEMA as PARTITION_SCHEMA };
