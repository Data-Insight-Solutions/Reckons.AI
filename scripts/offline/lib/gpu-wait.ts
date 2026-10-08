/**
 * GPU WAIT for `npm run offline:all` (F74.7). The session queue worker checks scripts/agent/session-gpu.ts
 * before starting each GPU job; offline:all did not, so a batch run outside the queue could stack
 * agent jobs onto a hot GPU. Observed 2026-10-07: an ungated batch drove GPU 1 to 89 C.
 *
 * Before EACH agent-tier job (not once per run: the heat comes from the jobs before it):
 *   clear       run it
 *   hot/full/busy  wait, re-reading every POLL_MS, up to the wait limit; then SKIP it, said by name
 *   unknown     run it with a warning. THIS DIFFERS FROM THE WORKER, which fails closed. offline:all is
 *               started by a person at a terminal, and on a machine without nvidia-smi (no NVIDIA GPU,
 *               a container) failing closed would silently turn every agent job off. The weakness: a
 *               machine whose nvidia-smi is broken gets no protection here.
 */
import type { GpuVerdict } from '../../agent/session-gpu.js';

export const POLL_MS = 30_000;
export const DEFAULT_WAIT_MIN = 20;

/**
 * --gpu-wait-min, validated. A non-number would make the limit NaN, and `waited >= NaN` is never
 * true, so the job would wait forever; refuse it instead (found by the local review, 2026-10-07).
 */
export function parseWaitMin(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_MIN;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`--gpu-wait-min must be a number of minutes >= 0, got "${raw}"`);
  return n;
}

export type GpuStep = { act: 'run' } | { act: 'run-unknown'; reason: string } | { act: 'wait'; reason: string } | { act: 'skip'; reason: string };

/** Pure: what to do with the next agent job, given the GPU verdict and how long it has waited. */
export function gpuStep(v: GpuVerdict, waitedMs: number, maxWaitMs: number): GpuStep {
  if (v.ok) return { act: 'run' };
  if (v.kind === 'unknown') return { act: 'run-unknown', reason: v.reason };
  if (waitedMs >= maxWaitMs) return { act: 'skip', reason: `${v.reason}; waited ${Math.round(waitedMs / 60_000)} min` };
  return { act: 'wait', reason: v.reason };
}

/** Wait until the GPU is clear or the limit passes. Prints each new reason once. */
export async function waitForGpu(
  read: () => Promise<GpuVerdict>,
  maxWaitMs: number,
  log: (s: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Exclude<GpuStep, { act: 'wait' }>> {
  const start = Date.now();
  let last = '';
  for (;;) {
    const step = gpuStep(await read(), Date.now() - start, maxWaitMs);
    if (step.act !== 'wait') {
      if (last && step.act === 'run') log('gpu gate: clear');
      return step;
    }
    if (step.reason !== last) { log(`gpu gate: waiting (${step.reason})`); last = step.reason; }
    await sleep(POLL_MS);
  }
}
