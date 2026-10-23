/**
 * F262 — one chat provider for any server that speaks the OpenAI chat-completions shape: LM Studio,
 * llama.cpp server, vLLM, LocalAI, and Ollama's own /v1. The person supplies the base URL, the
 * model and (only if their server wants one) a key. The fixed-URL `openai` provider is untouched.
 *
 * Locality comes from the URL, never from the provider name: the same provider can point at this
 * machine or at somebody's cloud. A private address is local; anything else is remote, so a
 * mistyped or unfamiliar host keeps the ethics preamble rather than dropping it.
 */
import type { ChatMessage } from './providers';

export type OpenAICompatibleConfig = { baseUrl: string; model: string; apiKey?: string };
export type OpenAICompatibleSettings = {
  openaiCompatibleBaseUrl?: string;
  openaiCompatibleModel?: string;
  openaiCompatibleApiKey?: string;
};

/**
 * Accept what people paste. Servers document their base as http://host:port/v1, but many people
 * paste http://host:port; a bare origin gets /v1, and any explicit path is kept as given.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return url.pathname === '/' || url.pathname === '' ? `${url.origin}/v1` : trimmed;
  } catch {
    return trimmed;
  }
}

export function openAICompatibleConfig(s: OpenAICompatibleSettings): OpenAICompatibleConfig {
  return {
    baseUrl: normalizeBaseUrl(s.openaiCompatibleBaseUrl ?? ''),
    model: s.openaiCompatibleModel?.trim() ?? '',
    ...(s.openaiCompatibleApiKey?.trim() ? { apiKey: s.openaiCompatibleApiKey.trim() } : {}),
  };
}

/** Configured enough to send a request: a parseable base URL and a model name. */
export function openAICompatibleReady(s: OpenAICompatibleSettings): boolean {
  const cfg = openAICompatibleConfig(s);
  try { return !!cfg.model && /^https?:$/.test(new URL(cfg.baseUrl).protocol); } catch { return false; }
}

/**
 * This machine or this person's own network: loopback, RFC 1918, link-local, Tailscale's CGNAT
 * range, IPv6 unique-local, and mDNS `.local` names. Everything else, including a hostname we
 * cannot resolve here, is treated as remote.
 */
export function isPrivateEndpoint(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let host: string;
  try { host = new URL(normalizeBaseUrl(raw)).hostname.toLowerCase(); } catch { return false; }
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function headers(cfg: OpenAICompatibleConfig): Record<string, string> {
  return { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) };
}

async function reach(url: string, init: RequestInit, cfg: OpenAICompatibleConfig): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    const origin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'this page';
    throw new Error(
      `Cannot reach the server at ${cfg.baseUrl}. Either it is not running, or it does not accept ` +
      `requests from ${origin} (CORS). Allow that origin in the server: LM Studio has a CORS switch in ` +
      `its server settings, vLLM takes --allowed-origins, and Ollama takes OLLAMA_ORIGINS.`,
    );
  }
}

export async function chatOpenAICompatible(
  messages: ChatMessage[],
  system: string,
  cfg: OpenAICompatibleConfig,
  maxTokens = 1024,
  signal?: AbortSignal,
): Promise<string> {
  if (!cfg.baseUrl || !cfg.model) throw new Error('Set the server URL and model for your OpenAI-compatible server in Settings.');
  const res = await reach(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST', signal, headers: headers(cfg),
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }),
  }, cfg);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Server at ${cfg.baseUrl} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** GET /models — what the server offers, for the settings picker and its connection test. */
export async function listOpenAICompatibleModels(cfg: Pick<OpenAICompatibleConfig, 'baseUrl' | 'apiKey'>, signal?: AbortSignal): Promise<string[]> {
  const full = { ...cfg, model: '' };
  const res = await reach(`${cfg.baseUrl}/models`, { method: 'GET', signal, headers: headers(full) }, full);
  if (!res.ok) throw new Error(`Server at ${cfg.baseUrl} answered ${res.status} to /models`);
  const data = await res.json() as { data?: { id?: unknown }[] };
  return (data.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
}
