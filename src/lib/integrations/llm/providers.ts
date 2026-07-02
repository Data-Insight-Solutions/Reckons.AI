/**
 * Client-side LLM provider abstraction.
 *
 * All calls go directly from the browser to the provider's public API.
 * API keys are stored in IndexedDB and only sent over TLS to their
 * respective provider endpoints — they never touch a backend server.
 */

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// ── Claude (Anthropic) ────────────────────────────────────────────────────────

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

export async function chatClaude(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  model = 'claude-haiku-4-5-20251001',
  maxTokens = 1024
): Promise<string> {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export async function chatOpenAI(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  model = 'gpt-4o-mini',
  maxTokens = 1024
): Promise<string> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Ollama (local) ────────────────────────────────────────────────────────────

/**
 * Shared network layer for both Ollama endpoints (`/v1/chat/completions` and
 * `/api/chat`). Interprets fetch-level failures (CORS blocked, connection
 * refused, offline) into actionable error messages, then leaves HTTP-status
 * and body handling to the caller since the two endpoints shape errors
 * differently.
 */
async function ollamaFetch(url: string, body: unknown, baseUrl: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    // Network errors (CORS blocked, connection refused, offline)
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('NetworkError') || msg.includes('Failed to fetch') || msg.includes('Load failed')) {
      const origin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : '';
      const isRemote = origin && !origin.includes('localhost') && !origin.includes('127.0.0.1');
      const isLocalUrl = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');

      // Most common mobile mistake: app accessed via LAN IP but Ollama URL still points to localhost
      if (isRemote && isLocalUrl) {
        const host = new URL(origin).hostname;
        throw new Error(
          `Ollama URL is "${baseUrl}" but you're accessing this app from ${origin}. ` +
          `"localhost" means this device — your phone can't reach the desktop's Ollama that way. ` +
          `Change the Ollama URL in Settings to http://${host}:11434`
        );
      }

      throw new Error(
        `Cannot reach Ollama at ${baseUrl}. ` +
        `Either Ollama is not running, or CORS is blocking the request. ` +
        `Start Ollama with: OLLAMA_ORIGINS="${origin}" ollama serve`
      );
    }
    throw e;
  }
}

/** Calls a locally running Ollama instance via its OpenAI-compatible chat endpoint. */
export async function chatOllama(
  messages: ChatMessage[],
  system: string,
  model = 'llama3.2',
  baseUrl = 'http://localhost:11434',
  maxTokens = 1024
): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;
  const res = await ollamaFetch(url, {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages]
  }, baseUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)} — is Ollama running at ${baseUrl}?`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Calls a locally running Ollama instance via its native `/api/chat` endpoint
 * with the `format` parameter set to a JSON Schema, constraining decoding so
 * the model can only emit tokens that keep the output schema-valid (Ollama
 * converts the schema to a GBNF grammar under the hood, same as llama.cpp's
 * `--json-schema`). This is the schema-constrained counterpart to
 * `chatOllama` — used for structured extraction, not for plain chat.
 *
 * `think: false` disables reasoning on hybrid-thinking models (Qwen3,
 * gpt-oss, …). Without it, those models spend the entire token budget on a
 * hidden `<think>` block and return empty `message.content` — measured
 * empirically against qwen3:4b, which produced 0 usable output at
 * `num_predict: 2048` with thinking on, vs. correct schema-valid JSON in
 * under a second with it off. Ignored (harmlessly) by non-thinking models
 * and older Ollama builds that don't recognize the field.
 */
export async function chatOllamaStructured(
  messages: ChatMessage[],
  system: string,
  schema: Record<string, unknown>,
  model = 'llama3.2',
  baseUrl = 'http://localhost:11434',
  maxTokens = 1024
): Promise<string> {
  const url = `${baseUrl}/api/chat`;
  const res = await ollamaFetch(url, {
    model,
    stream: false,
    think: false,
    format: schema,
    options: { num_predict: maxTokens },
    messages: [{ role: 'system', content: system }, ...messages]
  }, baseUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)} — is Ollama running at ${baseUrl}?`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}

/** List models available on a running Ollama instance. Returns [] on error. */
export async function listOllamaModels(baseUrl = 'http://localhost:11434'): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

/**
 * OpenRouter.ai — unified API with access to many models, some free.
 * Uses the OpenAI-compatible endpoint. Free models include Llama 3, Mistral, etc.
 * Keys are free at openrouter.ai/keys.
 */
export async function chatOpenRouter(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  model = 'meta-llama/llama-3.2-3b-instruct:free',
  maxTokens = 1024
): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      'http-referer': typeof window !== 'undefined' ? window.location.origin : 'https://reckons.ai',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Reckons.AI Cloud Workers ──────────────────────────────────────────────────

/**
 * Reckons.AI Cloud Workers — managed AI inference running on Cloudflare Workers AI.
 * Uses the OpenAI-compatible chat completions format.
 * API keys are provisioned via reckons.ai (Stripe-managed subscription).
 */
export async function chatReckons(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  baseUrl = 'https://api.reckons.ai',
  model = '@cf/meta/llama-3.1-8b-instruct',
  maxTokens = 1024
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Reckons Cloud ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Chrome Built-in AI (Gemini Nano) ─────────────────────────────────────────

/**
 * Chrome 127+ exposes window.ai.languageModel — Gemini Nano running locally
 * in the browser. Completely free, no API key, no network call.
 * Requires Chrome with "Prompt API for Gemini Nano" flag enabled.
 */
export async function chatChromeAI(
  messages: ChatMessage[],
  system: string,
  maxTokens = 1024
): Promise<string> {
  const ai = (window as any).ai;
  if (!ai?.languageModel) {
    throw new Error(
      'Chrome Built-in AI not available. Enable it at chrome://flags/#prompt-api-for-gemini-nano and restart Chrome.'
    );
  }
  const capabilities = await ai.languageModel.capabilities();
  if (capabilities.available === 'no') {
    throw new Error('Chrome Built-in AI model is not downloaded yet. Visit chrome://components and update "Optimization Guide On Device Model".');
  }

  const session = await ai.languageModel.create({
    systemPrompt: system,
    maxTokens,
  });

  const userText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  const result = await session.prompt(userText);
  session.destroy();
  return result;
}

// ── Gemini (Google) ───────────────────────────────────────────────────────────

export async function chatGemini(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  model = 'gemini-2.0-flash',
  maxTokens = 1024
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Gemini uses alternating user/model roles; inject system as first user turn
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens }
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${b.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
