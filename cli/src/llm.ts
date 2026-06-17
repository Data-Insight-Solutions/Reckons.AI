/**
 * LLM chat — call Ollama, Claude, or OpenAI with KB context.
 *
 * Keeps it simple: one function, returns a string.
 */

import type { Triple } from './kb.js';

export type Provider = 'ollama' | 'claude' | 'openai';

export interface LLMConfig {
  provider: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  ollama: 'llama3.2',
  claude: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
};

/** Build a KB context block from relevant triples */
export function buildContext(triples: Triple[]): string {
  if (triples.length === 0) return '(empty knowledge base)';
  return triples.map(t => {
    const s = t.subject.split('/').pop() ?? t.subject;
    const p = t.predicate.split('/').pop() ?? t.predicate;
    return `${s} -- ${p} --> ${t.object}`;
  }).join('\n');
}

const SYSTEM = `You are Shelly, the Reckons.AI assistant. You help users explore and reason about their personal knowledge base.

Rules:
- Answer based on the KB context provided. Cite specific facts.
- If the KB doesn't contain relevant information, say so honestly.
- Be concise and direct. This may be read aloud via TTS.
- Keep responses under 150 words unless the user asks for detail.
- Use plain language — avoid markdown formatting when possible.`;

/**
 * Send a message to the LLM with KB context.
 * Returns the assistant's response text.
 */
export async function chat(
  config: LLMConfig,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  kbContext: string,
): Promise<string> {
  const model = config.model ?? DEFAULT_MODELS[config.provider];
  const systemPrompt = `${SYSTEM}\n\nKnowledge base context:\n${kbContext}`;

  if (config.provider === 'ollama') {
    return chatOllama(config.baseUrl ?? 'http://localhost:11434', model, systemPrompt, messages);
  }
  if (config.provider === 'claude') {
    if (!config.apiKey) throw new Error('Claude API key required (--api-key or ANTHROPIC_API_KEY)');
    return chatClaude(config.apiKey, model, systemPrompt, messages);
  }
  if (config.provider === 'openai') {
    if (!config.apiKey) throw new Error('OpenAI API key required (--api-key or OPENAI_API_KEY)');
    return chatOpenAI(config.apiKey, model, systemPrompt, messages);
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function chatOllama(
  baseUrl: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const body = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
  };

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { message?: { content?: string } };
  return json.message?.content?.trim() ?? '(no response)';
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function chatClaude(
  apiKey: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const body = {
    model,
    max_tokens: 1024,
    system,
    messages,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { content?: Array<{ text?: string }> };
  return json.content?.[0]?.text?.trim() ?? '(no response)';
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function chatOpenAI(
  apiKey: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}
