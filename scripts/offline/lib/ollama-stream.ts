/**
 * OLLAMA, STREAMED, WITH TWO DIFFERENT PATIENCES (F74.7).
 *
 * WHY. With `stream: false` Ollama sends nothing, not even response headers, until the whole answer
 * is generated. Node's fetch gives up after 300 s without headers, so a request that was merely
 * WAITING behind other GPU jobs died with UND_ERR_HEADERS_TIMEOUT (local reviews, 2026-10-06/07),
 * and a long answer on a slow model could die the same way while working perfectly.
 *
 * Streamed, the two waits separate and get their own limits:
 *   queueWaitMs  time until Ollama starts answering (headers): a model loading or a queue ahead.
 *                Long by default (20 min), because waiting is not failing.
 *   idleMs       time between chunks once it is answering: silence means stuck. Short (2 min).
 * undici's headersTimeout and bodyTimeout are exactly these two, so no timer code is needed.
 *
 * Works for /api/generate (text in `response`) and /api/chat (text in `message.content`).
 */
import { Agent, fetch } from 'undici';
import { localOptions, retryTransient } from './local-model.js';

export const QUEUE_WAIT_MS = 20 * 60_000;
export const IDLE_MS = 2 * 60_000;

export type StreamFinal = { done?: boolean; done_reason?: string; eval_count?: number; prompt_eval_count?: number; total_duration?: number };

/**
 * Pure: fold NDJSON text chunks (split anywhere, even mid-line) into the answer and the final
 * record. An `error` line from Ollama throws with its message.
 */
export function foldNdjson(chunks: Iterable<string>): { text: string; final: StreamFinal | null } {
  let buf = '';
  let text = '';
  let final: StreamFinal | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const o = JSON.parse(line) as { response?: string; message?: { content?: string }; error?: string } & StreamFinal;
    if (o.error) throw new Error(`Ollama: ${o.error}`);
    text += o.response ?? o.message?.content ?? '';
    if (o.done) final = o;
  };
  for (const c of chunks) {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  take(buf);
  return { text, final };
}

const agents = new Map<string, Agent>();
const agentFor = (queueWaitMs: number, idleMs: number): Agent => {
  const key = `${queueWaitMs}/${idleMs}`;
  if (!agents.has(key)) agents.set(key, new Agent({ headersTimeout: queueWaitMs, bodyTimeout: idleMs }));
  return agents.get(key)!;
};

/**
 * POST a streamed request and return the whole answer. `body.stream` is forced to true, and
 * `body.options` gets the device's num_batch (F74.10). A failure a restarted model server explains
 * is retried (retryTransient); the two patience timeouts are not.
 * Transport errors keep their cause (undici's code), because a bare "fetch failed" once made
 * a cold model load look like 25 mystery failures.
 */
export async function ollamaStream(
  base: string,
  endpoint: 'generate' | 'chat',
  body: Record<string, unknown>,
  opts: { queueWaitMs?: number; idleMs?: number } = {},
): Promise<{ text: string; final: StreamFinal | null }> {
  const withOptions = { ...body, options: localOptions((body.options as Record<string, unknown> | undefined) ?? {}) };
  return retryTransient(() => streamOnce(base, endpoint, withOptions, opts));
}

async function streamOnce(
  base: string,
  endpoint: 'generate' | 'chat',
  body: Record<string, unknown>,
  opts: { queueWaitMs?: number; idleMs?: number },
): Promise<{ text: string; final: StreamFinal | null }> {
  const url = `${base.replace(/\/+$/, '')}/api/${endpoint}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      dispatcher: agentFor(opts.queueWaitMs ?? QUEUE_WAIT_MS, opts.idleMs ?? IDLE_MS),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ${res.status} ${res.statusText}${res.ok ? ' (no body)' : `: ${(await res.text()).slice(0, 200)}`}`);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for await (const part of res.body) chunks.push(decoder.decode(part as Uint8Array, { stream: true }));
    chunks.push(decoder.decode());
    return foldNdjson(chunks);
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code;
    const hint = code === 'UND_ERR_HEADERS_TIMEOUT' ? ` — Ollama did not start answering within ${Math.round((opts.queueWaitMs ?? QUEUE_WAIT_MS) / 60_000)} min (queue or model load)`
      : code === 'UND_ERR_BODY_TIMEOUT' ? ` — Ollama went silent for ${Math.round((opts.idleMs ?? IDLE_MS) / 1000)} s mid-answer` : '';
    throw new Error(`${e?.message ?? e}${code ? ` (${code})` : ''}${hint}`);
  }
}
