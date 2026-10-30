/**
 * STABLE LOCAL MODEL CALLS (F74.10) — two things every local job's Ollama call needs.
 *
 * 1. THE DEVICE'S BATCH SIZE. `localOptions` adds num_batch from the device-config threshold
 *    `ollamaNumBatch` (default 256 in device-defaults.ttl). Measured 2026-10-09: qwen3.6 split over
 *    two RTX 3090s aborted with a CUDA illegal memory access on job-watch's verdict prompt 4 of 4
 *    times at Ollama's default 512 and answered 4 of 4 at 256. A workaround, not a fix: the cause
 *    inside llama.cpp is unknown. A caller's own num_batch wins.
 *
 * 2. A RETRY WHEN THE SERVER DIED UNDER THE CALL. When llama-server aborts, the call in flight gets
 *    a 500 and Ollama starts a fresh runner, which takes 10-20 s to load. `retryTransient` waits and
 *    tries again (twice by default). Only failures a restart explains are retried: HTTP 5xx and a
 *    refused, reset or dropped connection. A 4xx (bad request, unknown model) or a timeout from
 *    ollama-stream's own patience fails at once, because waiting would not change it.
 */
import { loadDeviceConfig } from '../../agent/device-config.js';

/**
 * The general local reasoning model, for every job that does not name its own. ONE place, because
 * five scripts hardcoded qwen3.6:latest or qwen3:32b, both removed from this machine by hand on
 * 2026-10-26 when the deputy moved to qwen3.8, and each then failed at its first call with an unknown
 * model while the deputy's handoff blamed an Ollama API change. RECKONS_LOCAL_MODEL overrides it
 * per host. qwen3.8 is NOT yet re-measured on the panel or docs tasks that qwen3.6 was scored on.
 */
export const DEFAULT_REASONING_MODEL = process.env.RECKONS_LOCAL_MODEL || 'qwen3.8:latest';

export const DEFAULT_NUM_BATCH = 256;
export const RETRY_WAIT_MS = 15_000;
export const RETRY_ATTEMPTS = 2;

/** The device's num_batch: the threshold's limit, DEFAULT_NUM_BATCH if unreadable, undefined for 0. */
export function deviceNumBatch(load: () => { thresholds: Record<string, { limit?: number }> } = loadDeviceConfig): number | undefined {
  let v: number | undefined;
  try { v = load().thresholds.ollamaNumBatch?.limit; } catch { /* an unreadable config falls back to the default */ }
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_NUM_BATCH;
  return n > 0 ? Math.floor(n) : undefined;
}

/** Ollama `options` with the device's num_batch added. The caller's values win. */
export function localOptions<T extends Record<string, unknown>>(options: T, numBatch: () => number | undefined = deviceNumBatch): T & { num_batch?: number } {
  if ('num_batch' in options) return options;
  const n = numBatch();
  return n === undefined ? options : { num_batch: n, ...options };
}

/** An error thrown by a local call, carrying the HTTP status when there was one. */
export class OllamaHttpError extends Error {
  constructor(readonly status: number, body: string) { super(`Ollama ${status}: ${body.slice(0, 200)}`); }
}

/**
 * A local model that is not installed. Ollama answers `404 {"error":"model 'x' not found"}`; said
 * raw, that read as an API change and sent a handoff chasing a regression that did not exist
 * (2026-10-26). Never transient, so never retried: waiting does not pull a model.
 */
export class MissingModelError extends OllamaHttpError {
  constructor(readonly model: string, body: string) {
    super(404, body);
    this.message = `local model "${model}" is not installed in Ollama — pull it (ollama pull ${model}), pass --model=<an installed model>, or set RECKONS_LOCAL_MODEL. \`npm run models:check\` lists every default the scripts expect against what is installed.`;
  }
}

/** The model named by Ollama's not-found answer, or null. Pure. */
export function missingModelIn(status: number, body: string): string | null {
  if (status !== 404) return null;
  return body.match(/model ['"]([^'"]+)['"] not found/)?.[1] ?? null;
}

/** Throw an OllamaHttpError for a non-OK response, keeping the body (it names the crash). */
export async function assertOk(res: { ok: boolean; status: number; text(): Promise<string> }): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  const missing = missingModelIn(res.status, body);
  throw missing ? new MissingModelError(missing, body) : new OllamaHttpError(res.status, body);
}

/** Would a restarted model server explain this failure? Pure. */
export function isTransient(e: unknown): boolean {
  if (e instanceof OllamaHttpError) return e.status >= 500;
  const err = e as { message?: string; code?: string; cause?: { code?: string } } | undefined;
  const code = err?.cause?.code ?? err?.code ?? '';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'].includes(code)) return true;
  const msg = err?.message ?? '';
  if (/UND_ERR_(HEADERS|BODY)_TIMEOUT/.test(msg)) return false;
  return /\bOllama:? 5\d\d\b|ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|other side closed|llama-server|an error was encountered while running the model/i.test(msg) || msg === 'fetch failed';
}

/** Run `fn`, retrying a transient failure after a wait. The last error is rethrown as is. */
export async function retryTransient<T>(fn: () => Promise<T>, opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (e: unknown, attempt: number) => void } = {}): Promise<T> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      (opts.onRetry ?? ((err, n) => console.error(`local model: transient failure, retry ${n} of ${attempts} in ${Math.round((opts.waitMs ?? RETRY_WAIT_MS) / 1000)} s — ${(err as Error).message?.slice(0, 120)}`)))(e, i + 1);
      await sleep(opts.waitMs ?? RETRY_WAIT_MS);
    }
  }
}
