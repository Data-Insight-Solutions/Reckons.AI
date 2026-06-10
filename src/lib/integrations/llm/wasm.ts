import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseTriplesJSON,
  type ExtractedTriple
} from './extractor';
import type { ChatMessage } from './providers';

/**
 * Local extraction backend running entirely in the browser via Transformers.js.
 * The model runs in a Web Worker so the UI thread is never blocked, and the
 * pipeline is lazily instantiated on first use. On WebGPU-capable browsers the
 * worker will switch to the WebGPU backend automatically; CPU otherwise.
 *
 * Notes:
 *  - The default model is small to keep first-load reasonable. Users can switch
 *    to a larger instruct model in Settings if they have the bandwidth.
 *  - Output quality is materially below Claude. The reviewer UI exists precisely
 *    so users can correct or refine before the statements are committed to KB.
 */

const DEFAULT_MODEL = 'HuggingFaceTB/SmolLM2-360M-Instruct';

let workerSingleton: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const progressCallbacks = new Set<(status: string, progress?: number) => void>();

type WorkerMsgIn =
  | { id: number; type: 'init'; model: string }
  | { id: number; type: 'extract'; system: string; user: string }
  | { id: number; type: 'chat'; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };

type WorkerMsgOut =
  | { id: number; type: 'ready' }
  | { id: number; type: 'progress'; status: string; progress?: number }
  | { id: number; type: 'result'; text: string }
  | { id: number; type: 'error'; message: string };

function getWorker(): Worker {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(new URL('./wasm-worker.ts', import.meta.url), { type: 'module' });
  workerSingleton.onmessage = (ev: MessageEvent<WorkerMsgOut>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      for (const cb of progressCallbacks) cb(msg.status, msg.progress);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'result') {
      pending.delete(msg.id);
      p.resolve(msg.text);
    } else if (msg.type === 'error') {
      pending.delete(msg.id);
      p.reject(new Error(msg.message));
    } else if (msg.type === 'ready') {
      pending.delete(msg.id);
      p.resolve(true);
    }
  };
  return workerSingleton;
}

function call<T>(msg: Omit<WorkerMsgIn, 'id'>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextReqId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

/** How long to wait for a WASM model download before giving up (ms). */
const WASM_INIT_TIMEOUT_MS = 90_000;

export async function ensureWasmReady(model = DEFAULT_MODEL): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`WASM model download timed out after ${WASM_INIT_TIMEOUT_MS / 1000}s. Check your connection or switch to a different backend in Settings.`)), WASM_INIT_TIMEOUT_MS)
  );
  await Promise.race([call({ type: 'init', model }), timeout]);
}

/**
 * Register a progress callback. Does NOT create the worker — safe to call
 * on page load. The callback fires once the worker is started (by
 * ensureWasmReady / extractWithWasm) and begins downloading a model.
 */
export function onWasmProgress(cb: (status: string, progress?: number) => void): () => void {
  progressCallbacks.add(cb);
  return () => progressCallbacks.delete(cb);
}

export async function chatWithWasm(
  messages: ChatMessage[],
  system: string,
  model = DEFAULT_MODEL
): Promise<string> {
  await ensureWasmReady(model);
  return call<string>({ type: 'chat', system, messages });
}

export async function extractWithWasm(
  text: string,
  sourceTitle: string,
  model = DEFAULT_MODEL
): Promise<ExtractedTriple[]> {
  await ensureWasmReady(model);
  const raw = await call<string>({
    type: 'extract',
    system: EXTRACTION_SYSTEM_PROMPT,
    user: buildExtractionUserPrompt(text, sourceTitle)
  });
  return parseTriplesJSON(raw);
}
