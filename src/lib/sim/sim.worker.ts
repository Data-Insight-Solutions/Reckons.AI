// F260.1 — thin Web Worker wrapper for later replay (phase 3). Message in: { scene, options }.
// Message out: { ok: true, result } or { ok: false, error }. No wall-clock input, no state.
import { simulate, type SimOptions, type SimResult } from './world';
import type { Scene } from './scene';

export interface SimRequest { scene: Scene; options: SimOptions }
export type SimResponse = { ok: true; result: SimResult } | { ok: false; error: string };

export async function handleSimRequest(req: SimRequest): Promise<SimResponse> {
  try { return { ok: true, result: await simulate(req.scene, req.options) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

const scope = globalThis as unknown as { postMessage?: (m: unknown) => void; onmessage: ((e: { data: SimRequest }) => void) | null };
if (typeof WorkerGlobalScope !== 'undefined') {
  scope.onmessage = async (e) => scope.postMessage?.(await handleSimRequest(e.data));
}
declare const WorkerGlobalScope: unknown;
