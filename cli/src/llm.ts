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

/** Build a compact KB context block from relevant triples.
 *  Groups by subject to reduce repetition and token usage. */
export function buildContext(triples: Triple[]): string {
  if (triples.length === 0) return '(no relevant facts)';

  // Group triples by subject for compact representation
  const bySubject = new Map<string, Array<{ p: string; o: string }>>();
  for (const t of triples) {
    const s = t.subject.split('/').pop() ?? t.subject;
    const p = t.predicate.split('/').pop() ?? t.predicate;
    if (!bySubject.has(s)) bySubject.set(s, []);
    bySubject.get(s)!.push({ p, o: t.object });
  }

  const lines: string[] = [];
  for (const [subj, facts] of bySubject) {
    if (facts.length === 1) {
      lines.push(`${subj} .${facts[0].p} ${facts[0].o}`);
    } else {
      lines.push(`${subj}: ${facts.map(f => `${f.p}=${f.o}`).join('; ')}`);
    }
  }
  return lines.join('\n');
}

const SYSTEM = `You are Shelly, the Reckons.AI assistant. You help users explore and reason about their personal knowledge base.

Rules:
- Answer based on the KB context provided. Cite specific facts.
- If the KB context doesn't cover a topic, say "this KB doesn't have information on that yet" — not that it doesn't exist. Absence of a fact in this KB doesn't mean the fact is false.
- Be concise and direct. This may be read aloud via TTS.
- Keep responses under 150 words unless the user asks for detail.
- Use plain language — avoid markdown formatting when possible.`;

const EXTRACT_SYSTEM = `You are a knowledge extraction engine for Reckons.AI.

Given a short note or observation, extract structured triples in Turtle (.ttl) format.

Rules:
1. Use the prefix \`@prefix kb: <urn:kbase:> .\`
2. Entity IRIs: \`kb:<type>/<slug>\` where type is person, concept, event, place, org, etc.
3. Predicate IRIs: \`kb:predicate/<verb>\` in camelCase.
4. Add \`rdfs:label\` for every new entity.
5. Add \`rdf:type\` using \`kb:type/<Type>\`.
6. Keep it minimal — only extract what the note actually says.
7. Output ONLY valid Turtle. No explanation, no markdown fences.
8. Include the @prefix declarations at the top.`;

/**
 * Extract Turtle triples from a short note using the LLM.
 */
export async function extract(
  config: LLMConfig,
  noteText: string,
): Promise<string> {
  const model = config.model ?? DEFAULT_MODELS[config.provider];
  const messages = [{ role: 'user' as const, content: `Extract triples from this note:\n\n${noteText}` }];

  if (config.provider === 'ollama') {
    return chatOllama(config.baseUrl ?? 'http://localhost:11434', model, EXTRACT_SYSTEM, messages);
  }
  if (config.provider === 'claude') {
    if (!config.apiKey) throw new Error('Claude API key required (--api-key or ANTHROPIC_API_KEY)');
    return chatClaude(config.apiKey, model, EXTRACT_SYSTEM, messages);
  }
  if (config.provider === 'openai') {
    if (!config.apiKey) throw new Error('OpenAI API key required (--api-key or OPENAI_API_KEY)');
    return chatOpenAI(config.apiKey, model, EXTRACT_SYSTEM, messages);
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

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
